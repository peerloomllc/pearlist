// OLD-PEER FORK SAFETY, on a REAL Autobase. The load-bearing test named in
// proposals/2026-07-13-writer-revocation.md ("if this test fails, the feature
// does not ship") and on the verify list of
// proposals/2026-07-29-removing-a-phone-should-remove-it.md.
//
// WHY IT CANNOT BE A listWire UNIT TEST. Those run applyListOp against a MOCK
// view, and a fork is not visible in one view: it is two peers computing
// DIFFERENT views from the SAME log. That needs two real Autobases replicating.
// So this harness runs the ACTUAL applyListOp - the current one on one peer, an
// OLD one checked out of git on the other - over one shared base, and compares
// the resulting views key by key.
//
// The two old builds are extracted with `git archive`, so they are the real
// shipped code and not a hand-written model of it:
//   ANCIENT = 53c063b~1, before revoke1 existed at all
//   V1ONLY  = 5d88903 (PR #129), understands revoke1 but NOT revoke2
//
// The engine's apply loop (addWriter / revokeWriter) is reproduced from
// peerloom-core/src/engine.js makeApply, because that is the layer applyOps
// hangs off.
//
// WHAT IT ESTABLISHES, and none of it was known before 2026-07-30:
//   1. Unarmed, an old peer agrees EXACTLY. The caps / proof fields are inert.
//   2. Armed, an old peer forks - silently, nothing throws.
//   3. The fork is CONFINED to member and space rows. No list or item ever
//      diverges, and both peers keep reading and writing each other's edits.
//   4. The casualty is the SIGNED frontier, which freezes at the divergence
//      point while an unforked pair reaches ~16 of 18.
//   5. The capability gate refuses to arm while such a peer is present, which
//      is what keeps 2-4 hypothetical.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { signValue } = require('@peerloom/core/records')

const REPO = path.join(__dirname, '..')
const CURRENT = require('../src/listWire.js')

const _dirs = []
function tmpDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  _dirs.push(dir)
  return dir
}
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

// A past build's listWire, loaded from a real `git archive` of that commit.
// node_modules is symlinked rather than copied: the old src only needs
// @peerloom/core and @peerloom/device-link, and neither has drifted in a way
// that matters to the apply rules under test.
function oldWire (commit) {
  const dir = tmpDir('plist-old-')
  execSync(`git archive ${commit} src | tar -x -C ${dir}`, { cwd: REPO, stdio: 'pipe' })
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'))
  return require(path.join(dir, 'src/listWire.js'))
}

// A shallow clone or a missing commit must SKIP, not fail red: the history is
// not something a contributor can be assumed to have.
let ANCIENT = null; let V1ONLY = null; let loadErr = null
try {
  ANCIENT = oldWire('53c063b~1')
  V1ONLY = oldWire('5d88903')
} catch (e) { loadErr = e }
const skip = loadErr ? `old builds unavailable: ${loadErr.message}` : false

function tmpStore () { return new Corestore(tmpDir('plist-fork-')) }
const openView = (store) => new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function kp () {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

// One person's phones: same mnemonic, separate device keys, each attesting
// itself. Exactly what happens after pairing.
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  return async function device () {
    const d = kp()
    const proof = await IdentityKey.from({ mnemonic }).then((i) => i.bootstrap(d.publicKey))
    return { ...d, pubkey: hex(d.publicKey), identityProof: hex(proof) }
  }
}

// honourRevoke:false models a peer whose CORE also predates revocation: per
// engine.js, a build with no authorizeRevoke hook `continue`s past the op.
function makeApply (wire, groupId, selfKey, honourRevoke) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: true })
        continue
      }
      if (op.type === 'revokeWriter' && typeof op.pubkey === 'string') {
        if (!honourRevoke) continue
        const key = b4a.from(op.pubkey, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(key)) continue
        try { await base.removeWriter(key) } catch {}
        continue
      }
      await wire.applyListOp(op, { view, base, groupId, node, emit () {}, selfKey })
    }
  }
}

async function mkPeer ({ wire, bootstrap, selfKey, honourRevoke = true, groupId = 'g' }) {
  const store = tmpStore()
  await store.ready()
  const base = new Autobase(store.namespace(groupId), bootstrap, {
    open: openView,
    apply: makeApply(wire, groupId, selfKey, honourRevoke),
    valueEncoding: 'json',
  })
  await base.ready()
  return { store, base, selfKey }
}

function connect (a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}

async function settle (peers, ms = 1500) {
  for (const p of peers) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of peers) { try { await p.base.update() } catch {} }
}

// Whole-view snapshot, so a fork shows up as a VALUE difference and not merely
// as a missing key.
async function snapshot (p) {
  const out = {}
  for await (const { key, value } of p.base.view.createReadStream()) out[key] = value
  return out
}

function diffViews (a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs = []
  for (const k of [...keys].sort()) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) diffs.push(k)
  }
  return diffs
}

function frontier (p) {
  const c = p.base.view.core
  return { length: c.length, signed: c.signedLength ?? null }
}

let clock = 1700000000000
const stamp = () => ++clock

// putRow, as listMethods writes it: a signed value carrying pubkey + updatedAt.
async function put (peer, dev, key, value) {
  const signed = signValue({ ...value, pubkey: dev.pubkey, updatedAt: stamp() }, dev.secretKey)
  await peer.base.append({ type: 'put', key, value: signed })
}

const itemKeyOf = (dev, i) => `item:l1:${dev.pubkey}:${String(i).padStart(10, '0')}`

// Ten alternating writes, the "household keeps using the app" workload. Returns
// nothing; callers assert convergence themselves.
async function tenWrites (owner, A, other, B) {
  await put(owner, A, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await settle([owner, other])
  for (let i = 1; i <= 5; i++) {
    await put(owner, A, itemKeyOf(A, i), { listId: 'l1', text: 'a' + i })
    await put(other, B, itemKeyOf(B, i), { listId: 'l1', text: 'b' + i })
    await settle([owner, other], 600)
  }
  await settle([owner, other], 2000)
}

// Standard opening: owner claims the space, admits the other peer, both publish
// a member row. `otherCaps` is what the other peer's BUILD would advertise.
async function openSpace (owner, A, other, B, otherCaps) {
  await put(owner, A, 'space', { owner: A.pubkey, name: 'House' })
  await owner.base.append({ type: 'addWriter', pubkey: hex(other.base.local.key) })
  await settle([owner, other])
  await put(owner, A, 'member:' + A.pubkey, { displayName: 'A', caps: ['revoke1', 'revoke2'] })
  const row = { displayName: 'B' }
  if (otherCaps) row.caps = otherCaps
  await put(other, B, 'member:' + B.pubkey, row)
  await settle([owner, other])
}

// ---------------------------------------------------------------------------

test('CONTROL: two CURRENT peers in an armed space agree exactly', { skip }, async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk(); const B = await mk()

  const owner = await mkPeer({ wire: CURRENT, bootstrap: null, selfKey: A.pubkey })
  const member = await mkPeer({ wire: CURRENT, bootstrap: owner.base.key, selfKey: B.pubkey })
  t.after(connect(owner, member))

  await openSpace(owner, A, member, B, ['revoke1', 'revoke2'])
  const meta = (await owner.base.view.get('space')).value
  await put(owner, A, 'space', { ...meta, revokeV1: true, revokeV2: true })
  await put(owner, A, 'member:' + A.pubkey, { displayName: 'A', caps: ['revoke1', 'revoke2'] })
  await put(member, B, 'member:' + B.pubkey, { displayName: 'B', caps: ['revoke1', 'revoke2'] })
  await settle([owner, member])

  assert.deepEqual(diffViews(await snapshot(owner), await snapshot(member)), [],
    'current peers must not diverge')

  // Baseline for the frontier readout in BLAST RADIUS below: an UNFORKED pair
  // doing the same workload. Signs ~16 of 18 - that is what healthy looks like.
  await tenWrites(owner, A, member, B)
  const f = frontier(owner)
  assert.ok(f.signed > f.length - 4, `unforked pair signs to the frontier (${JSON.stringify(f)})`)
})

test('HAZARD 1: an ANCIENT peer in a revokeV1-armed space FORKS on member rows', { skip }, async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk(); const B = await mk()

  const owner = await mkPeer({ wire: CURRENT, bootstrap: null, selfKey: A.pubkey })
  const old = await mkPeer({ wire: ANCIENT, bootstrap: owner.base.key, selfKey: B.pubkey, honourRevoke: false })
  t.after(connect(owner, old))

  await openSpace(owner, A, old, B, null) // an ancient build advertises no caps

  assert.deepEqual(diffViews(await snapshot(owner), await snapshot(old)), [],
    'UNARMED, an old peer agrees exactly - the new fields are inert')

  // Arm anyway. This is the thing the gate exists to prevent; we do it by hand
  // to measure what it is preventing.
  const meta = (await owner.base.view.get('space')).value
  await put(owner, A, 'space', { ...meta, revokeV1: true })
  await put(owner, A, 'member:' + A.pubkey, { displayName: 'A', caps: ['revoke1', 'revoke2'] })
  await put(old, B, 'member:' + B.pubkey, { displayName: 'B' })
  await settle([owner, old])

  const diffs = diffViews(await snapshot(owner), await snapshot(old))
  assert.ok(diffs.length > 0, 'the fork is real, and SILENT - nothing threw')
  assert.ok(diffs.every((k) => k.startsWith('member:')), `divergence confined to member rows, got ${diffs}`)

  // The mechanism, pinned so a refactor cannot quietly change it: the current
  // peer records the writer binding `_w`, the old peer has no such code.
  const mine = (await owner.base.view.get('member:' + B.pubkey)).value
  const theirs = (await old.base.view.get('member:' + B.pubkey)).value
  assert.equal(typeof mine._w, 'string', 'current peer records the writer binding')
  assert.equal(theirs._w, undefined, 'the ancient peer does not')
})

test('HAZARD 1b: the ANCIENT peer still READS and still EDITS lists and items', { skip }, async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk(); const B = await mk()

  const owner = await mkPeer({ wire: CURRENT, bootstrap: null, selfKey: A.pubkey })
  const old = await mkPeer({ wire: ANCIENT, bootstrap: owner.base.key, selfKey: B.pubkey, honourRevoke: false })
  t.after(connect(owner, old))

  await openSpace(owner, A, old, B, null)
  const meta = (await owner.base.view.get('space')).value
  await put(owner, A, 'space', { ...meta, revokeV1: true })
  await settle([owner, old])

  // Owner writes a list and an item; the old peer must SEE both.
  await put(owner, A, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await put(owner, A, itemKeyOf(A, 1), { listId: 'l1', text: 'milk' })
  await settle([owner, old])
  assert.equal((await old.base.view.get('list:l1'))?.value?.name, 'Groceries', 'old peer READS the list')
  assert.equal((await old.base.view.get(itemKeyOf(A, 1)))?.value?.text, 'milk', 'old peer READS the item')

  // The old peer writes; the owner must SEE it.
  await put(old, B, itemKeyOf(B, 1), { listId: 'l1', text: 'bread' })
  await settle([owner, old])
  assert.equal((await owner.base.view.get(itemKeyOf(B, 1)))?.value?.text, 'bread', 'old peer EDITS and it lands')

  // And an owner edit of the old peer's item converges back.
  await put(owner, A, itemKeyOf(B, 1), { listId: 'l1', text: 'bread', checked: true })
  await settle([owner, old])
  assert.equal((await old.base.view.get(itemKeyOf(B, 1)))?.value?.checked, true, 'list state still converges')

  const diffs = diffViews(await snapshot(owner), await snapshot(old))
  assert.ok(!diffs.some((k) => k.startsWith('list:') || k.startsWith('item:')),
    `no list or item may diverge, got ${diffs}`)
})

test('HAZARD 2: a V1-ONLY peer REJECTS a same-identity ownership transfer and forks the space row', { skip }, async (t) => {
  t.after(cleanup)
  const mkTim = await person(); const mkHousemate = await person()
  const A1 = await mkTim(); const A2 = await mkTim() // Tim's two phones
  const B = await mkHousemate()                      // the housemate, on an old build

  const owner = await mkPeer({ wire: CURRENT, bootstrap: null, selfKey: A1.pubkey })
  const phone2 = await mkPeer({ wire: CURRENT, bootstrap: owner.base.key, selfKey: A2.pubkey })
  const old = await mkPeer({ wire: V1ONLY, bootstrap: owner.base.key, selfKey: B.pubkey })
  const stops = [connect(owner, phone2), connect(owner, old), connect(phone2, old)]
  t.after(() => stops.forEach((s) => s()))

  await put(owner, A1, 'space', { owner: A1.pubkey, name: 'House' })
  await owner.base.append({ type: 'addWriter', pubkey: hex(phone2.base.local.key) })
  await owner.base.append({ type: 'addWriter', pubkey: hex(old.base.local.key) })
  await settle([owner, phone2, old], 2500)

  const caps = ['revoke1', 'revoke2']
  await put(owner, A1, 'member:' + A1.pubkey, { displayName: 'Tim', caps, identityProof: A1.identityProof })
  await put(phone2, A2, 'member:' + A2.pubkey, { displayName: 'Tim', caps, identityProof: A2.identityProof })
  await put(old, B, 'member:' + B.pubkey, { displayName: 'Sam', caps: ['revoke1'] }) // no revoke2
  await settle([owner, phone2, old], 2500)

  // Arm revokeV2 by hand - precisely what the revoke2 gate forbids here.
  const meta = (await owner.base.view.get('space')).value
  await put(owner, A1, 'space', { ...meta, revokeV1: true, revokeV2: true })
  await settle([owner, phone2, old], 2500)

  // Tim's second phone takes ownership: removal transfers first, then revokes.
  const armed = (await phone2.base.view.get('space')).value
  await put(phone2, A2, 'space', { ...armed, owner: A2.pubkey })
  await settle([owner, phone2, old], 2500)

  const ownerView = await snapshot(owner)
  const oldView = await snapshot(old)
  assert.equal(ownerView.space.owner, A2.pubkey, 'the transfer applied on current code')
  assert.equal(oldView.space.owner, A1.pubkey, 'the v1-only peer kept the OLD owner - split brain')
  assert.ok(diffViews(ownerView, oldView).includes('space'), 'the space row itself forked')
})

test('BLAST RADIUS: after the fork, writes still flow both ways but the SIGNED frontier freezes', { skip }, async (t) => {
  t.after(cleanup)
  const mk = await person()
  const A = await mk(); const B = await mk()

  const owner = await mkPeer({ wire: CURRENT, bootstrap: null, selfKey: A.pubkey })
  const old = await mkPeer({ wire: ANCIENT, bootstrap: owner.base.key, selfKey: B.pubkey, honourRevoke: false })
  t.after(connect(owner, old))

  await openSpace(owner, A, old, B, null)
  const meta = (await owner.base.view.get('space')).value
  await put(owner, A, 'space', { ...meta, revokeV1: true })
  await put(owner, A, 'member:' + A.pubkey, { displayName: 'A', caps: ['revoke1', 'revoke2'] })
  await settle([owner, old])

  assert.ok(diffViews(await snapshot(owner), await snapshot(old)).length > 0, 'precondition: diverged')
  const before = frontier(owner)

  await tenWrites(owner, A, old, B)

  // Every one of the ten items is visible on BOTH peers: the household does not
  // notice, which is exactly why this fails silently.
  for (let i = 1; i <= 5; i++) {
    assert.equal((await old.base.view.get(itemKeyOf(A, i)))?.value?.text, 'a' + i, `old peer sees owner item ${i}`)
    assert.equal((await owner.base.view.get(itemKeyOf(B, i)))?.value?.text, 'b' + i, `owner sees old-peer item ${i}`)
  }

  const after = frontier(owner)
  assert.ok(after.length > before.length, 'the view kept growing after the fork')
  assert.ok(!diffViews(await snapshot(owner), await snapshot(old))
    .some((k) => k.startsWith('list:') || k.startsWith('item:')),
  'the divergence never spread beyond member rows')

  // THE CASUALTY. The CONTROL pair signs ~16 of 18 on this same workload. A
  // forked pair signs NOTHING further, because the two indexers cannot agree on
  // the view they are signing. Local reads still converge, so the app looks
  // healthy - but nothing is indexed again, and fast-forward for a new joiner
  // plus any future retention/truncation work rest on indexed state.
  assert.equal(after.signed, before.signed,
    `not one block signed after the fork (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`)
})

test('THE GATE HOLDS: an old member row without caps blocks arming', async () => {
  const rows = [
    { pubkey: 'a'.repeat(64), caps: ['revoke1', 'revoke2'] },
    { pubkey: 'b'.repeat(64) },                       // ancient build
    { pubkey: 'c'.repeat(64), caps: ['revoke1'] },    // v1-only build
  ]
  assert.equal(CURRENT.allMembersSupportRevoke(rows), false, 'revoke1 must not arm with an ancient member present')
  assert.equal(CURRENT.allMembersSupportSelfRevoke(rows), false, 'revoke2 must not arm with a v1-only member present')

  // ...and it opens once the laggard is the eviction target, or has updated.
  assert.equal(CURRENT.allMembersSupportRevoke(rows, ['b'.repeat(64)]), true, 'the eviction target is exempt')
  assert.equal(CURRENT.allMembersSupportSelfRevoke(rows.slice(0, 1)), true, 'an all-current roster arms')
})
