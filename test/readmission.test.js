// What makes a writer revocation STICK - measured, because it was reasoned about
// wrongly first (see proposals/2026-07-30-repairing-a-removed-phone.md, corrected
// the same day).
//
// The wrong reasoning, recorded so it is not repeated: "the original addWriter is
// still in the log and is re-applied on every view rebuild, so without a
// replicated revocation record the removal would silently undo itself." That is
// false. Apply is ORDERED - addWriter at seq 5 then removeWriter at seq 50 always
// linearizes to removed, on every rebuild, forever. No denylist needed for that.
//
// What a denylist actually buys is refusal of a FUTURE addWriter. That is a
// POLICY, not a correctness requirement, and the two bases in this app differ:
//
//   personal base  keeps `revokedWriter:` rows and REFUSES re-admission forever
//                  (peerloom-device-link/src/personal.js)
//   shared spaces  keep no such record, so a later addWriter DOES re-admit
//
// Both behaviours are load-bearing for how re-pairing a removed phone can work, so
// both are pinned here against a REAL Autobase.

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
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-readmit-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The SPACE model: ordered apply, no denylist. Deliberately minimal - this is
// about Autobase's writer-set semantics, not about listWire's rows.
function apply (nodes, view, base) {
  return (async () => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter') { try { await base.addWriter(b4a.from(op.key, 'hex'), { indexer: true }) } catch {}; continue }
      if (op.type === 'removeWriter') {
        const k = b4a.from(op.key, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(k)) continue
        try { await base.removeWriter(k) } catch {}
        continue
      }
      if (op.type === 'put') await view.put(op.key, op.value)
    }
  })()
}

async function mk (dir, bootstrap) {
  const store = new Corestore(dir)
  await store.ready()
  const base = new Autobase(store.namespace('g'), bootstrap, { open: openView, apply, valueEncoding: 'json' })
  await base.ready()
  return { store, base }
}
function connect (a, b) {
  const s1 = a.store.replicate(true); const s2 = b.store.replicate(false); s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}
async function settle (ps, ms = 2000) {
  for (const p of ps) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of ps) { try { await p.base.update() } catch {} }
}

// `base.writable` is the signal to trust. getIndexedInfo() LAGS - it cannot
// advance while another indexer is offline - and reading the writer set from it
// gave the wrong answer twice on 2026-07-30 before that was noticed.
test('a revocation survives a full view rebuild, with NO denylist', async (t) => {
  t.after(cleanup)
  const dirA = tmpDir(); const dirB = tmpDir()
  const A = await mk(dirA, null)
  const B = await mk(dirB, A.base.key)
  let stop = connect(A, B)

  const bKey = hex(B.base.local.key)
  await A.base.append({ type: 'put', key: 'hello', value: 1 })
  await A.base.append({ type: 'addWriter', key: bKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, true, 'precondition: admitted')

  await A.base.append({ type: 'removeWriter', key: bKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, false, 'revoked')

  // Rebuild A from disk: every op, including the original addWriter, applies again
  // from scratch.
  const bootKey = A.base.key
  stop()
  await A.base.close(); await A.store.close()
  const A2 = await mk(dirA, bootKey)
  t.after(async () => { try { await A2.base.close() } catch {}; try { await A2.store.close() } catch {} })
  const stop2 = connect(A2, B)
  t.after(stop2)
  await settle([A2, B], 3000)
  await settle([A2, B], 2000)

  assert.equal(B.base.writable, false,
    'ordered apply keeps it revoked across a rebuild - a denylist is NOT what makes removal stick')
})

test('with no denylist, a LATER addWriter re-admits a revoked writer - which is what spaces do', async (t) => {
  t.after(cleanup)
  const A = await mk(tmpDir(), null)
  const B = await mk(tmpDir(), A.base.key)
  t.after(connect(A, B))

  const bKey = hex(B.base.local.key)
  await A.base.append({ type: 'put', key: 'hello', value: 1 })
  await A.base.append({ type: 'addWriter', key: bKey })
  await settle([A, B], 2500)
  await A.base.append({ type: 'removeWriter', key: bKey })
  await settle([A, B], 2500)
  assert.equal(B.base.writable, false, 'precondition: revoked')

  await A.base.append({ type: 'addWriter', key: bKey })
  await settle([A, B], 3000)
  await settle([A, B], 2000)

  // THE POINT: nothing in a SPACE refuses this, so re-admitting a removed phone to
  // a shared space needs no key rotation and no new op - just an addWriter from
  // someone who may append. Only the PERSONAL base refuses, by policy.
  assert.equal(B.base.writable, true,
    'a space can take a removed writer back; the personal base is the one that will not')
})

test('the personal base keeps the denylist that makes its refusal permanent', () => {
  // Pinning the asymmetry itself, so a change on either side is deliberate. If this
  // ever fails, re-read proposals/2026-07-30-repairing-a-removed-phone.md before
  // "fixing" it - the whole re-pair design turns on which base refuses.
  const src = fs.readFileSync(
    path.join(__dirname, '../../peerloom-device-link/src/personal.js'), 'utf8')
  assert.match(src, /revokedWriter:/, 'the personal base records revoked keys in the VIEW')
  assert.match(src, /if \(await isRevoked\(view, hex\)\) continue/,
    'and refuses a later addWriter for one')
})
