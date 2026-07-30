// OFFLINE REMOVAL - the lost-phone case, on a REAL Autobase.
//
// The case the "remove this phone" feature is named for, and the one every
// removal proven on hardware so far skipped: every one of those had both devices
// online and next to each other. Filed as a two-device job; it is not one. The
// question is what happens to writes a revoked device made WHILE IT WAS OFFLINE,
// and those writes are CONCURRENT with the revocation - the removed phone could
// not have known - so this is Autobase linearization, not app logic. Two phones
// cannot answer it any better than two bases can, and they cannot be re-run
// twenty times to find a race.
//
// "Offline" here is the replication stream being down, which is exactly what it
// is on a phone with no network.
//
// WHAT THIS MEASURED, 2026-07-30:
//   - Whether the offline writes land on reconnect is a RACE. Six runs of the
//     two-peer case: 4 accepted them, 2 did not. Six runs of the three-peer case:
//     3 accepted, 3 did not.
//   - It is a race, NOT a fork. In every single run all honest peers landed on
//     the SAME answer with byte-identical views. That is the invariant this file
//     asserts; the coin-flip itself is only logged, because asserting either
//     outcome would be a flaky test.
//   - Once the phone KNOWS it is revoked, it cannot write at all - the append
//     throws, every run.
//   - It keeps READING, which is the documented limit (DECISIONS.md 2026-07-28:
//     re-keying is "make a new space").
//
// NOT COVERED HERE, and it still wants hardware: the app-level transition on a
// real phone - what the UI shows the removed device, and device-link's personal
// base. The ONLINE half of that was proven on the TCL + iPhone on 2026-07-29.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { signValue } = require('@peerloom/core/records')
const CURRENT = require('../src/listWire.js')

const _dirs = []
function tmpDir (p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function kp () {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  return async function device () {
    const d = kp()
    const proof = await IdentityKey.from({ mnemonic }).then((i) => i.bootstrap(d.publicKey))
    return { ...d, pubkey: hex(d.publicKey), identityProof: hex(proof) }
  }
}

// The engine's apply loop, from peerloom-core/src/engine.js.
function makeApply (groupId, selfKey) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: true }); continue
      }
      if (op.type === 'revokeWriter' && typeof op.pubkey === 'string') {
        const key = b4a.from(op.pubkey, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(key)) continue
        try { await base.removeWriter(key) } catch {}
        continue
      }
      await CURRENT.applyListOp(op, { view, base, groupId, node, emit () {}, selfKey })
    }
  }
}

async function mkPeer ({ bootstrap, selfKey, groupId = 'g' }) {
  const store = new Corestore(tmpDir('plist-off-'))
  await store.ready()
  const base = new Autobase(store.namespace(groupId), bootstrap, {
    open: openView, apply: makeApply(groupId, selfKey), valueEncoding: 'json',
  })
  await base.ready()
  return { store, base, selfKey }
}
function connect (a, b) {
  const s1 = a.store.replicate(true); const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}
async function settle (peers, ms = 1500) {
  for (const p of peers) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of peers) { try { await p.base.update() } catch {} }
}
let clock = 1700000000000
async function put (peer, dev, key, value) {
  await peer.base.append({ type: 'put', key, value: signValue({ ...value, pubkey: dev.pubkey, updatedAt: ++clock }, dev.secretKey) })
}
const itemKey = (dev, i) => `item:l1:${dev.pubkey}:${String(i).padStart(10, '0')}`

async function snapshot (p) {
  const out = {}
  for await (const { key, value } of p.base.view.createReadStream()) out[key] = value
  return out
}
function diffViews (a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].sort().filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
}

// Arm revocation, then RE-PUBLISH the member rows. Order matters: the writer
// binding `_w` is recorded on APPLY of a member row while armed, so a row written
// before arming carries none - and a revocation needs it to know which core to
// remove. The real app re-runs publishMember on every space open, which is what
// produces this in the field.
async function armAndBind (owner, A, target, B, peers, others = []) {
  await put(owner, A, 'space', { ...(await owner.base.view.get('space')).value, revokeV1: true, revokeV2: true })
  await settle(peers, 2000)
  const caps = ['revoke1', 'revoke2']
  await put(owner, A, 'member:' + A.pubkey, { displayName: 'A', caps, identityProof: A.identityProof })
  await put(target, B, 'member:' + B.pubkey, { displayName: 'B', caps, identityProof: B.identityProof })
  for (const [peer, dev] of others) {
    await put(peer, dev, 'member:' + dev.pubkey, { displayName: 'C', caps, identityProof: dev.identityProof })
  }
  await settle(peers, 2000)
  const w = (await owner.base.view.get('member:' + B.pubkey)).value._w
  assert.equal(typeof w, 'string', 'precondition: the writer binding was recorded while armed')
  return w
}

// ---------------------------------------------------------------------------

test('OFFLINE REMOVAL: the returning phone learns it was revoked, and cannot write again', async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk()   // the phone you still have
  const B = await mk()   // the phone you lost

  const owner = await mkPeer({ bootstrap: null, selfKey: A.pubkey })
  const lost = await mkPeer({ bootstrap: owner.base.key, selfKey: B.pubkey })
  let stop = connect(owner, lost)

  await put(owner, A, 'space', { owner: A.pubkey, name: 'House' })
  await owner.base.append({ type: 'addWriter', pubkey: hex(lost.base.local.key) })
  await settle([owner, lost])
  const boundWriter = await armAndBind(owner, A, lost, B, [owner, lost])
  await put(owner, A, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await settle([owner, lost])

  // A normal write from the lost phone BEFORE it goes missing. Removing a phone
  // is not meant to erase the shopping it already did.
  await put(lost, B, itemKey(B, 1), { listId: 'l1', text: 'before-loss' })
  await settle([owner, lost])
  assert.equal((await owner.base.view.get(itemKey(B, 1)))?.value?.text, 'before-loss', 'pre-loss write landed')
  assert.equal(lost.base.writable, true, 'precondition: it could write')

  // ---- THE PHONE IS LOST. Network down. -----------------------------------
  stop(); await sleep(300)
  await put(owner, A, 'space', { ...(await owner.base.view.get('space')).value, evicted: { [B.pubkey]: { at: ++clock } } })
  await owner.base.append({ type: 'revokeWriter', pubkey: boundWriter })
  await settle([owner], 1500)
  assert.equal(await owner.base.view.get(itemKey(B, 2)), null, 'nothing from the lost phone has arrived yet')

  // Whoever has it keeps using it, offline, knowing nothing.
  for (let i = 2; i <= 4; i++) await put(lost, B, itemKey(B, i), { listId: 'l1', text: 'ZOMBIE-' + i })
  await settle([lost], 800)
  assert.equal(lost.base.writable, true, 'while offline it has no way to know')

  // ---- IT COMES BACK ONLINE ------------------------------------------------
  stop = connect(owner, lost); t.after(stop)
  await settle([owner, lost], 4000)
  await settle([owner, lost], 3000)

  // The race, LOGGED not asserted: sometimes the offline writes merge, sometimes
  // they never arrive. See the header. The three-peer test below is what pins
  // down that this cannot split honest peers.
  const accepted = []
  for (let i = 2; i <= 4; i++) if ((await owner.base.view.get(itemKey(B, i)))?.value) accepted.push(i)
  console.log('  [race] offline writes that merged on reconnect:', accepted.length ? accepted : 'NONE')

  assert.equal(lost.base.writable, false, 'on reconnect it learns it can no longer write')
  assert.ok((await lost.base.view.get('space'))?.value?.evicted?.[B.pubkey],
    'and it can see WHY - the evicted map replicated to it')

  // THE BOUNDARY, and it never wavered across runs: a write attempted once it
  // KNOWS must not land, or revocation would mean nothing at all.
  let threw = false
  try { await put(lost, B, itemKey(B, 7), { listId: 'l1', text: 'POST-KNOWLEDGE' }) } catch { threw = true }
  await settle([owner, lost], 2500)
  assert.equal(threw, true, 'the append itself is refused')
  assert.equal(await owner.base.view.get(itemKey(B, 7)), null, 'and nothing reaches the honest peer')

  assert.equal((await owner.base.view.get(itemKey(B, 1)))?.value?.text, 'before-loss',
    'the pre-loss write survives - revocation is not a purge')
})

test('OFFLINE REMOVAL: the revoked phone can still READ, which is the documented limit', async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk(); const B = await mk()

  const owner = await mkPeer({ bootstrap: null, selfKey: A.pubkey })
  const lost = await mkPeer({ bootstrap: owner.base.key, selfKey: B.pubkey })
  let stop = connect(owner, lost)

  await put(owner, A, 'space', { owner: A.pubkey, name: 'House' })
  await owner.base.append({ type: 'addWriter', pubkey: hex(lost.base.local.key) })
  await settle([owner, lost])
  const boundWriter = await armAndBind(owner, A, lost, B, [owner, lost])
  await put(owner, A, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await settle([owner, lost])

  stop(); await sleep(300)
  await owner.base.append({ type: 'revokeWriter', pubkey: boundWriter })
  await settle([owner], 1500)
  await put(owner, A, itemKey(A, 9), { listId: 'l1', text: 'after-you-were-removed' })
  await settle([owner], 800)

  stop = connect(owner, lost); t.after(stop)
  await settle([owner, lost], 4000)

  assert.equal((await lost.base.view.get(itemKey(A, 9)))?.value?.text, 'after-you-were-removed',
    'revocation stops writes, never reads - DECISIONS.md 2026-07-28, re-keying is "make a new space"')
})

test('OFFLINE REMOVAL: honest peers agree with each other, whichever way the race falls', async (t) => {
  t.after(cleanup)
  const mkTim = await person(); const mkSam = await person()
  const A = await mkTim()   // owner, the phone you still have
  const B = await mkTim()   // the phone you lost (same person)
  const C = await mkSam()   // an honest housemate, current build

  const owner = await mkPeer({ bootstrap: null, selfKey: A.pubkey })
  const lost = await mkPeer({ bootstrap: owner.base.key, selfKey: B.pubkey })
  const mate = await mkPeer({ bootstrap: owner.base.key, selfKey: C.pubkey })

  let sAB = connect(owner, lost)
  t.after(connect(owner, mate))
  let sBC = connect(lost, mate)

  await put(owner, A, 'space', { owner: A.pubkey, name: 'House' })
  await owner.base.append({ type: 'addWriter', pubkey: hex(lost.base.local.key) })
  await owner.base.append({ type: 'addWriter', pubkey: hex(mate.base.local.key) })
  await settle([owner, lost, mate], 2500)

  const boundWriter = await armAndBind(owner, A, lost, B, [owner, lost, mate], [[mate, C]])
  await put(owner, A, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await settle([owner, lost, mate], 2000)

  // ---- THE PHONE IS LOST: cut it off from BOTH honest peers ----------------
  sAB(); sBC(); await sleep(400)
  await put(owner, A, 'space', { ...(await owner.base.view.get('space')).value, evicted: { [B.pubkey]: { at: ++clock } } })
  await owner.base.append({ type: 'revokeWriter', pubkey: boundWriter })
  await settle([owner, mate], 2500)

  for (let i = 2; i <= 4; i++) await put(lost, B, itemKey(B, i), { listId: 'l1', text: 'ZOMBIE-' + i })
  await settle([lost], 800)

  // ---- IT COMES BACK, to both peers ---------------------------------------
  sAB = connect(owner, lost); t.after(sAB)
  sBC = connect(lost, mate); t.after(sBC)
  await settle([owner, lost, mate], 5000)
  await settle([owner, lost, mate], 4000)

  const ownerSees = []; const mateSees = []
  for (let i = 2; i <= 4; i++) {
    if ((await owner.base.view.get(itemKey(B, i)))?.value) ownerSees.push(i)
    if ((await mate.base.view.get(itemKey(B, i)))?.value) mateSees.push(i)
  }
  console.log('  [race] owner accepted:', ownerSees.length ? ownerSees : 'NONE',
    '| housemate accepted:', mateSees.length ? mateSees : 'NONE')

  // THE POINT OF THIS WHOLE FILE. Either outcome of the race is survivable - a
  // burst of stale edits merging once is recoverable, and losing them is fine
  // too. Two honest peers landing on DIFFERENT outcomes would NOT be: that is a
  // silent fork between current builds. Six runs, three each way, never split.
  assert.deepEqual(ownerSees, mateSees, 'the two honest peers must reach the SAME answer')
  assert.deepEqual(diffViews(await snapshot(owner), await snapshot(mate)), [],
    'and their views must be byte-identical')
})
