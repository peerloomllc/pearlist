// A SPACE ARMS ITSELF. Nobody is asked.
//
// Tim, 2026-07-31: "the Stronger Removal language doesn't make sense to me and doesn't
// seem intuitive ... I don't think the regular user will understand it." He reached
// that from the naming. The deeper problem is that the control was the hidden
// prerequisite for something it never mentioned: until a space is armed, the owner's
// OWN other phone inherits none of their ownership, because canActAsOwner needs
// revokeV2. So the thing gating "does my second phone work" was a security toggle
// about removals, and nothing joined them up.
//
// It was never a decision a person could make either. The safety condition is "every
// member runs a build that understands the new apply rules", computed from replicated
// state. revokeV2 and promoteV1 have already turned themselves on with no confirm
// since PR #150; only revokeV1 still demanded a dialog, for historical reasons.
// See proposals/2026-07-31-arming-should-not-be-a-user-decision.md.
//
// REAL AUTOBASE, not the mock view. Arming writes a `space` row, and the whole point
// of the change is that the row lands and every peer keeps it. A mock view would
// accept a write apply drops, which is the exact failure this must not have
// ([[mock-view-hides-apply-bugs]]). Harness borrowed from ownerOtherPhone.test.js.

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
const methods = require('../src/listMethods.js')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-arms-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAPS = [listWire.REVOKE_CAP, listWire.REVOKE_SELF_CAP, listWire.PROMOTE_CAP]

function kp () {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  const id = await IdentityKey.from({ mnemonic })
  return async function device () {
    const d = kp()
    return { ...d, pubkey: hex(d.publicKey), identityProof: hex(await id.bootstrap(d.publicKey)) }
  }
}
function makeApply (groupId, selfKey) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: op.indexer !== false })
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
function mkCtx (dev, groupId, peer) {
  const bases = new Map([[groupId, peer.base]])
  return {
    identity: { publicKey: dev.publicKey, secretKey: dev.secretKey },
    bases,
    async append (gid, value) { await bases.get(gid).append(value) },
    emit () {},
  }
}
const GID = 'g1'
const metaOf = async (peer) => (await peer.base.view.get('space'))?.value
async function closeAll (o) {
  for (const s of o.stops || []) s()
  for (const p of o.peers || []) { try { await p.base.close() } catch {}; try { await p.store.close() } catch {} }
}

// A space as `createSpace` actually leaves it: the `space` row written by space:init,
// the creator's member row published, nothing armed and nobody else in it.
async function freshSpace (a, { publishMember = true } = {}) {
  const pa = await mkPeer({ bootstrap: null, selfKey: a.publicKey, groupId: GID })
  await put(pa, a, 'space', { owner: a.pubkey, name: 'New' })
  if (publishMember) await put(pa, a, 'member:' + a.pubkey, { displayName: 'A', caps: CAPS, identityProof: a.identityProof })
  await settle([pa], 800)
  return { pa, peers: [pa], stops: [] }
}

test('a brand new space arms itself on the first status check, with nobody asked', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const s = await freshSpace(a)
  t.after(() => closeAll(s))

  assert.equal((await metaOf(s.pa)).revokeV1, undefined, 'precondition: it starts un-armed')

  const st = await methods['space:revocationStatus']({ groupId: GID }, mkCtx(a, GID, s.pa))
  assert.equal(st.armed, false, 'the status READ still reports the state it found')

  // The arm is fire-and-forget inside the status call, so let it land.
  await settle(s.peers, 1200)
  const meta = await metaOf(s.pa)
  assert.equal(meta.revokeV1, true, 'armed without anyone tapping anything')
  assert.equal(meta.revokeV2, true, 'and all three capabilities in one write')
  assert.equal(meta.promoteV1, true)
  assert.equal(meta.owner, a.pubkey, 'ownership untouched')
  assert.equal(meta.name, 'New', 'and so is everything else on the row')
})

// THE ORDERING TRAP, pinned because getting it wrong is silent and permanent-looking.
// allMembersSupportCap returns FALSE on an empty row set, so a space whose creator's
// member row has not been applied yet must NOT arm. The temptation is to "fix" that by
// dropping the empty check, which would arm a space with no evidence anyone supports
// anything. The right behaviour is to decline now and arm on the next refresh.
test('a space with no member rows yet does NOT arm, and arms once the row lands', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const s = await freshSpace(a, { publishMember: false })
  t.after(() => closeAll(s))

  await methods['space:revocationStatus']({ groupId: GID }, mkCtx(a, GID, s.pa))
  await settle(s.peers, 1000)
  assert.equal((await metaOf(s.pa)).revokeV1, undefined, 'no rows, no evidence, no arming')

  // Now publish, exactly as member:publish does once the space is writable.
  await put(s.pa, a, 'member:' + a.pubkey, { displayName: 'A', caps: CAPS, identityProof: a.identityProof })
  await settle(s.peers, 800)

  await methods['space:revocationStatus']({ groupId: GID }, mkCtx(a, GID, s.pa))
  await settle(s.peers, 1200)
  assert.equal((await metaOf(s.pa)).revokeV1, true, 'and the next refresh picks it up')
})

// The gate is unchanged, and this is the test that proves the automation did not
// quietly widen it. A member on an old build advertises no caps, and a space
// containing one must stay un-armed no matter how many times status is polled -
// which is exactly the protection those users have today.
//
// PASSES WITH OR WITHOUT THE AUTOMATIC ARMING, and says so rather than posing as
// coverage it is not. Its job is to fail if someone later decides the empty-caps case
// is a false negative worth "fixing". That is the one change here that could hurt a
// real 1.0.4 user, since a peer that does not understand a revocation computes a
// different writer set and forks rather than erroring.
test('a space with a member on an OLD build never arms itself', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const other = await (await person())()

  const pa = await mkPeer({ bootstrap: null, selfKey: a.publicKey, groupId: GID })
  const pb = await mkPeer({ bootstrap: pa.base.key, selfKey: other.publicKey, groupId: GID })
  const stops = [connect(pa, pb)]
  const peers = [pa, pb]
  t.after(() => closeAll({ peers, stops }))

  await put(pa, a, 'space', { owner: a.pubkey, name: 'Mixed' })
  await pa.base.append({ type: 'addWriter', pubkey: hex(pb.base.local.key), indexer: true })
  await settle(peers, 1500)
  await put(pa, a, 'member:' + a.pubkey, { displayName: 'A', caps: CAPS, identityProof: a.identityProof })
  // NO `caps` at all: an old build does not know the field exists.
  await put(pb, other, 'member:' + other.pubkey, { displayName: 'Old', identityProof: other.identityProof })
  await settle(peers, 1500)

  for (let i = 0; i < 3; i++) {
    await methods['space:revocationStatus']({ groupId: GID }, mkCtx(a, GID, pa))
    await settle(peers, 600)
  }
  assert.equal((await metaOf(pa)).revokeV1, undefined, 'still un-armed on the owner')
  assert.equal((await metaOf(pb)).revokeV1, undefined, 'and on the old peer, which is the one being protected')
})

// The linked phone must not be able to arm a space for the first time. canActAsOwner
// needs revokeV2, and revokeV2 implies revokeV1, so it cannot reach the first arming -
// and it must not, because an un-armed space is exactly the one whose peers would drop
// its write. Automating the arming makes this worth re-pinning: the automatic path
// runs on whichever phone happens to refresh the roster.
test("the owner's other phone does not perform the FIRST arming", async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()

  const pa = await mkPeer({ bootstrap: null, selfKey: a.publicKey, groupId: GID })
  const pb = await mkPeer({ bootstrap: pa.base.key, selfKey: b.publicKey, groupId: GID })
  const stops = [connect(pa, pb)]
  const peers = [pa, pb]
  t.after(() => closeAll({ peers, stops }))

  await put(pa, a, 'space', { owner: a.pubkey, name: 'Two phones' })
  await pa.base.append({ type: 'addWriter', pubkey: hex(pb.base.local.key), indexer: true })
  await settle(peers, 1500)
  await put(pb, b, 'member:' + b.pubkey, { displayName: 'B', caps: CAPS, identityProof: b.identityProof })
  await settle(peers, 1200)

  // B refreshes first. It is the same person and every member advertises support, but
  // B is not the owner DEVICE, so it must decline.
  await methods['space:revocationStatus']({ groupId: GID }, mkCtx(b, GID, pb))
  await settle(peers, 1200)
  assert.equal((await metaOf(pb)).revokeV1, undefined, 'the linked phone did not arm it')

  // The owner device does, and then B sees it.
  await put(pa, a, 'member:' + a.pubkey, { displayName: 'A', caps: CAPS, identityProof: a.identityProof })
  await settle(peers, 800)
  await methods['space:revocationStatus']({ groupId: GID }, mkCtx(a, GID, pa))
  await settle(peers, 1500)
  assert.equal((await metaOf(pa)).revokeV1, true, 'the owner device armed it')
  assert.equal((await metaOf(pb)).revokeV1, true, 'and every peer kept the write')
})
