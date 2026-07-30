// Re-pairing a removed phone: the rotation half, on a REAL Autobase.
//
// proposals/2026-07-30-repairing-a-removed-phone.md. The load-bearing assertion is
// the LAST one in the first test, and it is written the way it is on purpose:
//
//   a rotated peer's write must reach another peer WITHOUT this test reconnecting.
//
// Because the failure mode is not "rotation does not work" - it does. It is that a
// rotated peer reports writable:true, updates its own view, and is INVISIBLE to
// everyone else until the replication stream is re-established. A test that
// reconnects before asserting would pass while shipping exactly that bug, and the
// bug would present as a sync problem rather than a rotation one.
//
// So the reconnect belongs to the ROTATION ROUTINE, mirroring
// peerloom-device-link's rotateLocalWriter (which destroys swarm.connections and
// lets Hyperswarm re-dial). The test never touches the connection after rotating.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-rot-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}
const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The PERSONAL-base model: ordered apply PLUS the revokedWriter denylist, mirroring
// peerloom-device-link/src/personal.js. This is the base that refuses re-admission,
// so it is the one rotation has to get past.
function apply (nodes, view, base) {
  return (async () => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter') {
        const revoked = await view.get('revokedWriter:' + op.key)
        if (revoked && revoked.value) continue
        try { await base.addWriter(b4a.from(op.key, 'hex'), { indexer: true }) } catch {}
        continue
      }
      if (op.type === 'removeWriter') {
        await view.put('revokedWriter:' + op.key, { revoked: true })
        const k = b4a.from(op.key, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(k)) continue
        try { await base.removeWriter(k) } catch {}
        continue
      }
      if (op.type === 'put') await view.put(op.key, op.value)
    }
  })()
}

const NS = 'personal'
async function mkPeer (dir, bootstrap) {
  const store = new Corestore(dir || tmpDir())
  await store.ready()
  const base = new Autobase(store.namespace(NS), bootstrap, { open: openView, apply, valueEncoding: 'json' })
  await base.ready()
  return { store, base }
}

// Stands in for the swarm: owns the replication stream and can drop it, which is
// what rotateLocalWriter does via swarm.connections.
function makeLink (a, b) {
  const link = { stop: null }
  link.open = () => {
    const s1 = a.store.replicate(true); const s2 = b.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    link.stop = () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
  }
  link.reconnect = () => { if (link.stop) link.stop(); link.open() }
  link.open()
  return link
}
async function settle (ps, ms = 2000) {
  for (const p of ps) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of ps) { try { await p.base.update() } catch {} }
}

// peerloom-device-link's rotateLocalWriter, in miniature. The key MUST come from a
// named core in the base's own namespace: setLocal resolves via store.get({ key }),
// which only yields a signable core if the corestore already holds its keypair.
async function rotateLocalWriter (peer, gen) {
  const core = peer.store.namespace(NS).get({ name: 'local-' + gen })
  await core.ready()
  const key = core.key
  await core.close()
  await peer.base.setLocal(key)
  return hex(peer.base.local.key)
}

// The whole re-pair sequence, as device-link performs it. Modelled as ONE routine
// because the ORDER is the load-bearing part and a caller must not have to know it:
//
//   1. rotate, WITHOUT reconnecting - the handshake is running over the connection
//      the reply still has to go out on (handleGranted, reconnect:false)
//   2. the primary admits the new key (handlePersonalWriter -> addWriter)
//   3. ONLY THEN reconnect (handleComplete)
//
// Step 3 must come after step 2. Reconnecting at rotation time does NOT work: the
// other peer opens the writer core for the new key when it applies the addWriter,
// which is after the stream was re-established, so it is invisible all over again.
// That was measured here - the first version of this test reconnected in step 1 and
// failed exactly that way.
async function repair (secondary, primary, link, gen) {
  const newKey = await rotateLocalWriter(secondary, gen)      // 1
  await settle([primary, secondary], 1500)
  await primary.base.append({ type: 'addWriter', key: newKey }) // 2
  await settle([primary, secondary], 2500)
  link.reconnect()                                             // 3
  await settle([primary, secondary], 2500)
  return newKey
}

test('a rotated peer is re-admitted AND its writes actually reach the other peer', async (t) => {
  t.after(cleanup)
  const A = await mkPeer()
  const B = await mkPeer(null, A.base.key)
  const link = makeLink(A, B)
  t.after(() => link.stop && link.stop())

  const oldKey = hex(B.base.local.key)
  await A.base.append({ type: 'put', key: 'hello', value: 1 })
  await A.base.append({ type: 'addWriter', key: oldKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, true, 'precondition: admitted')

  await A.base.append({ type: 'removeWriter', key: oldKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, false, 'precondition: revoked')

  // The old key is refused forever - that is the behaviour rotation must NOT break.
  await A.base.append({ type: 'addWriter', key: oldKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, false, 'the denylist still refuses the old key')

  // ---- the re-pair sequence, entirely inside the routine ---------------------
  const newKey = await repair(B, A, link, 2)
  assert.notEqual(newKey, oldKey, 'the local writer key actually changed')
  assert.equal(B.base.writable, true, 'the fresh key is admitted - no rule changed to allow it')

  // ---- THE ASSERTION THIS FILE EXISTS FOR -----------------------------------
  // No reconnect here. If rotateLocalWriter did not do it, this fails - which is
  // the whole point, because without it the phone looks healthy and is invisible.
  await B.base.append({ type: 'put', key: 'from-rotated-b', value: 1 })
  await settle([A, B], 3000)
  await settle([A, B], 2000)
  assert.ok(await A.base.view.get('from-rotated-b'),
    'the rotated peer must be VISIBLE to the other peer without anyone reconnecting by hand')

  // And the old key is still dead at the end - rotation is a way back for the
  // person, not an undo of the revocation.
  const dead = await A.base.view.get('revokedWriter:' + oldKey)
  assert.ok(dead && dead.value, 'the revoked key stays revoked')
})

test('rotation is PERSISTENT - the same name yields the same key after a store reopen', async (t) => {
  t.after(cleanup)
  // Autobase's default local core is `name: 'local'`, so a rotation that is not
  // recorded is undone the next time the base is opened - i.e. on the next app
  // launch, putting the device back on its dead key. device-link records the name
  // and re-applies it in openPersonalBase; this pins the property that makes that
  // work, namely that a named core in a namespace is deterministic per store.
  const dir = tmpDir()
  const store1 = new Corestore(dir)
  await store1.ready()
  const c1 = store1.namespace(NS).get({ name: 'local-2' })
  await c1.ready()
  const first = hex(c1.key)
  await c1.close(); await store1.close()

  const store2 = new Corestore(dir)
  await store2.ready()
  const c2 = store2.namespace(NS).get({ name: 'local-2' })
  await c2.ready()
  const second = hex(c2.key)
  await c2.close(); await store2.close()

  assert.equal(second, first, 'the recorded name resolves to the same key across launches')
})

test('device-link rotates on a RE-pair, defers the reconnect, and re-applies on open', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../peerloom-device-link/src/personal.js'), 'utf8')

  // Persistent, or the next launch silently reverts to the dead key.
  assert.match(src, /const LOCAL_NAME_KEY = 'personalMeta:localName'/, 'the rotation is recorded')
  assert.match(src, /await applyRotatedLocal\(base\)/, 'and re-applied on every base open')
  // Before joining the swarm / seeding, both of which act on personalBase.local.
  const openAt = src.indexOf('async function openPersonalBase')
  const openBody = src.slice(openAt, src.indexOf('\n  }', src.indexOf('return base', openAt)))
  assert.ok(openBody.indexOf('applyRotatedLocal') < openBody.indexOf('joinPersonalSwarm'),
    'rotation is applied BEFORE the swarm join and the deviceMeta seed')

  // Rotates when re-pairing, because the denylist row may not have replicated yet
  // and checking would be a race.
  assert.match(src, /const rejoining = !!\(prevBoot && prevBoot\.key === parsed\.personalBaseKey\)/)
  assert.match(src, /if \(rejoining\) \{ await rotateLocalWriter\(\{ reconnect: false \}\)/,
    'rotates mid-handshake WITHOUT dropping the connection the reply goes out on')

  // ...and the deferred reconnect actually happens.
  const doneAt = src.indexOf('async function handleComplete')
  const doneBody = src.slice(doneAt, doneAt + 900)
  assert.match(doneBody, /if \(rotated\) reconnectPersonalPeers\(\)/,
    'the reconnect is done once the handshake is finished')
})

test('the app announces per-space writer keys after linking', () => {
  const methods = fs.readFileSync(path.join(__dirname, '../src/listMethods.js'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '../src/ui/App.jsx'), 'utf8')

  // seedGroups SKIPS a space the device never left, so without this a re-paired
  // phone sits in the space able to read and silently unable to write.
  assert.match(methods, /'device:announceSpaceWriters'/, 'the method exists')
  assert.match(methods, /dl\.announceGroupWriter\(groupId, w\)/, 'and announces per space')
  assert.match(methods, /if \(!dl\.isWritable\(\)\) return/, 'no-ops until the personal base accepts writes')

  // It cannot fire once: this device is not a writer on the personal base until the
  // other phone's addWriter replicates back, which is after the handshake returns.
  assert.match(app, /function announceSpaceWriters \(attempts = 8\)/, 'retried, not fired once')
  assert.match(app, /announceSpaceWriters\(\)/, 'and called after a successful link')
})
