// MULTI-SPACE / PARTIAL REMOVAL, on REAL Autobases.
//
// One of the two device-removal cases that had never run (TODO.md, filed
// 2026-07-30). Every removal proven before this - on hardware and in tests - was
// one person, two phones, ONE space, both armed and both online. So the only
// result ever observed was `spacesRevoked: 1, spacesBlocked: 0`, and every SKIP
// path in `spaceRevokeBlocker`, plus the "cut off from N of your M shared spaces"
// wording that depends on them, had never executed once.
//
// FILED AS A HARDWARE JOB. It is not one, and that is now the third time: old-peer
// fork safety and offline removal were both filed as needing two phones and both
// were answered by real Autobases instead (PRs #132, #133). What this asks is
// which spaces a removal reaches and why it skips the rest, which is base state
// and app logic. Phones cannot answer it any better, and cannot be re-run.
//
// REAL bases, not the mock view, for one specific reason: 'sole-indexer' is
// answered by Autobase's own `removeable()`. A mock cannot tell the truth about
// that, and it is precisely the blocker that shipped broken - a removal reporting
// success about a phone that went on editing (found on hardware 2026-07-30).
// See memory: mock-view-hides-apply-bugs.

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
const listWire = require('../src/listWire.js')
const { _revokeDeviceFromSpaces: revokeDeviceFromSpaces } = require('../src/listMethods.js')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-multi-')); _dirs.push(d); return d }
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
// One PERSON, many devices. The identity proof is what makes two device keys the
// same human, which is what the same-identity owner transfer turns on.
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  const id = await IdentityKey.from({ mnemonic })
  return async function device () {
    const d = kp()
    return { ...d, pubkey: hex(d.publicKey), identityProof: hex(await id.bootstrap(d.publicKey)) }
  }
}

// The engine's apply loop, from peerloom-core/src/engine.js.
function makeApply (groupId, selfKey) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: op.indexer !== false })
        continue
      }
      if (op.type === 'revokeWriter' && typeof op.pubkey === 'string') {
        const key = b4a.from(op.pubkey, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(key)) continue
        try { await base.removeWriter(key) } catch {}
        continue
      }
      await listWire.applyListOp(op, { view, base, groupId, node, emit () {}, selfKey })
    }
  }
}

async function mkPeer ({ bootstrap, selfKey, groupId }) {
  const store = new Corestore(tmpDir())
  await store.ready()
  const base = new Autobase(store.namespace(groupId), bootstrap, {
    open: openView, apply: makeApply(groupId, selfKey), valueEncoding: 'json',
  })
  await base.ready()
  return { store, base }
}
function connect (a, b) {
  const s1 = a.store.replicate(true); const s2 = b.store.replicate(false)
  s1.on('error', () => {}); s2.on('error', () => {}); s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}
async function settle (peers, ms = 1500) {
  for (const p of peers) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of peers) { try { await p.base.update() } catch {} }
}

let clock = 1700000000000
async function put (peer, dev, key, value) {
  await peer.base.append({
    type: 'put', key, value: signValue({ ...value, pubkey: dev.pubkey, updatedAt: ++clock }, dev.secretKey),
  })
}

// A `ctx` shaped the way peerloom-core's methodCtx builds one, carrying several
// spaces at once. That plurality is the whole point of this file.
function mkCtx (identityKp, spaces) {
  const bases = new Map()
  for (const [groupId, peer] of Object.entries(spaces)) bases.set(groupId, peer.base)
  return {
    identity: { publicKey: identityKp.publicKey, secretKey: identityKp.secretKey },
    bases,
    async append (groupId, value) { await bases.get(groupId).append(value) },
    emit () {},
  }
}

// Build one space owned by `ownerDev`, with `targetDev` admitted as a writer.
// `armed` and `bindTarget` are the two levers the blockers turn on.
async function mkSpace ({ groupId, ownerDev, targetDev, armed = true, bindTarget = true, targetIndexer = true }) {
  const owner = await mkPeer({ bootstrap: null, selfKey: ownerDev.publicKey, groupId })
  const target = await mkPeer({ bootstrap: owner.base.key, selfKey: targetDev.publicKey, groupId })
  const stop = connect(owner, target)
  const peers = [owner, target]

  await put(owner, ownerDev, 'space', { owner: ownerDev.pubkey, name: groupId })
  await owner.base.append({ type: 'addWriter', pubkey: hex(target.base.local.key), indexer: targetIndexer })
  await settle(peers, 2000)

  if (armed) {
    const meta = (await owner.base.view.get('space')).value
    await put(owner, ownerDev, 'space', { ...meta, revokeV1: true, revokeV2: true })
    await settle(peers, 1500)
  }

  // The writer binding `_w` is recorded on APPLY of a member row while armed, so a
  // row written before arming carries none. Re-publishing after arming is what the
  // real app does on every space open, and it is what a revocation needs to know
  // which core to remove.
  const caps = [listWire.REVOKE_CAP, listWire.REVOKE_SELF_CAP]
  await put(owner, ownerDev, 'member:' + ownerDev.pubkey, { displayName: 'owner', caps, identityProof: ownerDev.identityProof })
  if (bindTarget) {
    await put(target, targetDev, 'member:' + targetDev.pubkey, { displayName: 'target', caps, identityProof: targetDev.identityProof })
  }
  await settle(peers, 2000)

  return { owner, target, stop, peers, groupId }
}

async function closeAll (spaces) {
  for (const s of spaces) {
    try { s.stop() } catch {}
    for (const p of s.peers) { try { await p.base.close() } catch {}; try { await p.store.close() } catch {} }
  }
}

test('a removal reaches the armed spaces and says WHY it skipped each of the others', async (t) => {
  t.after(cleanup)
  const me = await person()
  const owner = await me()   // the phone doing the removing
  const target = await me()  // the phone being removed - same person, second device

  // Four spaces in four different states. Before today only the first had ever
  // been exercised.
  const armedBound = await mkSpace({ groupId: 'g-armed', ownerDev: owner, targetDev: target })
  const notArmed = await mkSpace({ groupId: 'g-unarmed', ownerDev: owner, targetDev: target, armed: false })
  const noBinding = await mkSpace({ groupId: 'g-nobind', ownerDev: owner, targetDev: target, bindTarget: false })
  const spaces = [armedBound, notArmed, noBinding]
  t.after(() => closeAll(spaces))

  const ctx = mkCtx(owner, {
    'g-armed': armedBound.owner, 'g-unarmed': notArmed.owner, 'g-nobind': noBinding.owner,
  })

  const out = await revokeDeviceFromSpaces(ctx, target.pubkey)

  assert.equal(out.revoked, 1, 'exactly the armed, bound space is cut off')
  assert.equal(out.blocked.length, 2, 'and the other two are REPORTED, not silently skipped')

  const why = Object.fromEntries(out.blocked.map((b) => [b.groupId, b.why]))
  assert.equal(why['g-unarmed'], 'not-armed',
    'an un-armed space cannot revoke, and names that reason')
  assert.equal(why['g-nobind'], 'no-writer-binding',
    'a member row written before arming carries no _w, so there is no core to remove')

  // THE NUMBERS THE CONFIRM AND THE RESULT MESSAGE ARE BUILT FROM. "cut off from 1
  // of your 3 shared spaces" is a sentence that had never been produced by real
  // state before this test.
  const total = out.revoked + out.blocked.length
  assert.equal(total, 3, 'every space is accounted for, exactly once')
  assert.ok(out.revoked < total, 'this is the PARTIAL case, which is the one never seen')
})

test('the removed phone really cannot write to the space it was cut off from', async (t) => {
  t.after(cleanup)
  const me = await person()
  const owner = await me()
  const target = await me()

  const s = await mkSpace({ groupId: 'g1', ownerDev: owner, targetDev: target })
  t.after(() => closeAll([s]))

  const ctx = mkCtx(owner, { g1: s.owner })
  const out = await revokeDeviceFromSpaces(ctx, target.pubkey)
  assert.equal(out.revoked, 1, 'precondition: it reported the space as cut off')

  await settle(s.peers, 3000)
  await settle(s.peers, 2000)

  // `base.writable` is the signal to trust - getIndexedInfo() LAGS and gave the
  // wrong answer twice on 2026-07-30.
  assert.equal(s.target.base.writable, false,
    'reporting a revocation and performing one are different things; this is the second')
})

test('a space the removed phone OWNS is handed over before it is revoked', async (t) => {
  t.after(cleanup)
  const me = await person()
  const owner = await me()   // the phone doing the removing
  const target = await me()  // owns this space, and is the one being removed

  // Reversed: the TARGET creates and owns the space. Revoking an owner without
  // transferring first leaves the space permanently unmanageable - only the owner
  // may rename, delete, evict or arm. Watched on hardware 2026-07-29.
  const s = await mkSpace({ groupId: 'g1', ownerDev: target, targetDev: owner })
  t.after(() => closeAll([s]))

  // ctx is the OTHER phone (s.target here), which is the one doing the removing.
  const ctx = mkCtx(owner, { g1: s.target })
  const out = await revokeDeviceFromSpaces(ctx, target.pubkey)

  // Asserted outright rather than tolerated as one of two acceptable branches.
  // Measured deterministic over repeated runs, and a tolerant branch here would let
  // the exact regression this guards - a transfer failing quietly, leaving the space
  // revoked and unmanageable - pass as "blocked, fine".
  assert.equal(out.revoked, 1, 'the space is cut off')
  assert.deepEqual(out.blocked, [], 'and nothing was skipped')

  const meta = (await s.target.base.view.get('space'))?.value
  assert.equal(meta.owner, owner.pubkey,
    'ownership moved to the remaining phone BEFORE the revocation, or the space would be bricked')
  assert.notEqual(meta.owner, target.pubkey, 'the removed phone no longer owns it')
})

test('A REAL THIRD PARTY: a housemate sees the removal and is not disturbed by it', async (t) => {
  t.after(cleanup)
  // The other case that had never run. Everything proven before this was ONE
  // person with two phones - so a removal had never once happened with a genuine
  // second identity in the space, and "does it disturb the housemate" had never
  // been asked of anything but intuition. Filed as needing a third device and Tim
  // driving the Pixel; it needs neither.
  //
  // `housemate` comes from a DIFFERENT mnemonic, so it is a different person, not
  // just a different key. That distinction is the whole point: the same-identity
  // rules (owner transfer, promotion, self-revocation) must not reach it.
  const me = await person()
  const owner = await me()
  const target = await me()
  const them = await person()
  const housemate = await them()

  const s = await mkSpace({ groupId: 'g1', ownerDev: owner, targetDev: target })
  const third = await mkPeer({ bootstrap: s.owner.base.key, selfKey: housemate.publicKey, groupId: 'g1' })
  const stop3 = connect(s.owner, third)
  const peers = [...s.peers, third]
  t.after(async () => {
    try { stop3() } catch {}
    try { await third.base.close() } catch {}; try { await third.store.close() } catch {}
    await closeAll([s])
  })

  await s.owner.base.append({ type: 'addWriter', pubkey: hex(third.base.local.key), indexer: false })
  await settle(peers, 2500)
  await put(third, housemate, 'member:' + housemate.pubkey, {
    displayName: 'housemate', caps: [listWire.REVOKE_CAP, listWire.REVOKE_SELF_CAP], identityProof: housemate.identityProof,
  })
  await settle(peers, 2500)
  assert.equal(third.base.writable, true, 'precondition: the housemate is a writer')

  const ctx = mkCtx(owner, { g1: s.owner })
  const out = await revokeDeviceFromSpaces(ctx, target.pubkey)
  assert.equal(out.revoked, 1, 'precondition: the removal landed')
  await settle(peers, 3000)
  await settle(peers, 2000)

  // 1. THE HOUSEMATE IS NOT DISTURBED. This is the fear: a removal is a writer-set
  // change, and a writer-set change is what rotates the view and forks careless
  // peers. They must come out of it still able to write.
  assert.equal(third.base.writable, true,
    'a housemate must survive a removal they had nothing to do with')
  await put(third, housemate, 'item:l1:' + housemate.pubkey + ':0000000001', { text: 'still here' })
  await settle(peers, 2500)
  const written = await third.base.view.get('item:l1:' + housemate.pubkey + ':0000000001')
  assert.ok(written?.value, 'and can still actually write, not merely report writable')

  // 2. THEY SEE THE CHANGE. A roster that silently keeps showing a removed phone is
  // the failure this half is for.
  const seen = await s.owner.base.view.get('member:' + target.pubkey)
  const seenByThird = await third.base.view.get('member:' + target.pubkey)
  assert.deepEqual(seenByThird?.value ?? null, seen?.value ?? null,
    'the housemate sees the same roster row the remover does, not a stale one')

  // 3. AND THE REMOVAL STILL BIT. Proving the housemate is fine is worthless if the
  // removal quietly did nothing in a three-peer space.
  assert.equal(s.target.base.writable, false, 'the removed phone is still cut off')
})

test('the phone you are HOLDING is never revoked, whatever it is asked', async (t) => {
  t.after(cleanup)
  const me = await person()
  const owner = await me()
  const target = await me()
  const s = await mkSpace({ groupId: 'g1', ownerDev: owner, targetDev: target })
  t.after(() => closeAll([s]))

  const ctx = mkCtx(owner, { g1: s.owner })
  const out = await revokeDeviceFromSpaces(ctx, owner.pubkey) // ask it to remove ITSELF

  assert.deepEqual(out, { revoked: 0, blocked: [] },
    'removing the device in your hand is refused outright, before any space is touched')
  assert.equal(s.owner.base.writable, true, 'and it can still write')
})
