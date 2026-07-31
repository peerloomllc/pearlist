// THE OWNER'S OTHER PHONE MAY MANAGE THE SPACE.
//
// Tim, from the iPhone the day after it linked to the TCL, 2026-07-31: "Even though
// the iPhone and the TCL are now one person, the iPhone doesn't inherit the Space
// ownership - I can't remove members on the iPhone but I can on the TCL." Every owner
// check compared DEVICE keys, so a linked phone could do none of the things its owner
// could. "This phone becomes you" is the entire promise of linking.
//
// WHY THIS RUNS ON REAL AUTOBASES rather than a mock view, which would be faster and
// would prove the wrong thing. The danger in this change is not that the client
// refuses too much - that is visible immediately. It is that the client accepts MORE
// than apply does, in which case the removal succeeds locally, the UI reports it, and
// every peer (including this one after a restart) silently drops it. Only a second
// peer applying the block can tell those apart, so every positive case below is
// asserted on the OTHER phone's view, never on the writer's own.
//
// See test/multiSpaceRemoval.test.js, whose harness this borrows.

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
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-owner2-')); _dirs.push(d); return d }
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
// One PERSON, many devices. The identity proof is the only thing that makes two
// device keys the same human, and it is what this whole feature turns on.
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

// A `ctx` shaped the way peerloom-core's methodCtx builds one.
function mkCtx (dev, groupId, peer) {
  const bases = new Map([[groupId, peer.base]])
  return {
    identity: { publicKey: dev.publicKey, secretKey: dev.secretKey },
    bases,
    async append (gid, value) { await bases.get(gid).append(value) },
    emit () {},
  }
}

// One space: founded by `a`, joined by `b` (a's other phone) and `h` (a housemate,
// a different person). `armed` turns on revokeV1 + revokeV2, which is the exact
// precondition apply puts on a same-identity `space` write.
const GID = 'g1'
async function mkSpace ({ a, b, h, armed = true }) {
  const pa = await mkPeer({ bootstrap: null, selfKey: a.publicKey, groupId: GID })
  const pb = await mkPeer({ bootstrap: pa.base.key, selfKey: b.publicKey, groupId: GID })
  const ph = await mkPeer({ bootstrap: pa.base.key, selfKey: h.publicKey, groupId: GID })
  const stops = [connect(pa, pb), connect(pa, ph), connect(pb, ph)]
  const peers = [pa, pb, ph]

  await put(pa, a, 'space', { owner: a.pubkey, name: 'CleanTest' })
  await pa.base.append({ type: 'addWriter', pubkey: hex(pb.base.local.key), indexer: true })
  await pa.base.append({ type: 'addWriter', pubkey: hex(ph.base.local.key), indexer: true })
  await settle(peers, 2000)

  if (armed) {
    const meta = (await pa.base.view.get('space')).value
    await put(pa, a, 'space', { ...meta, revokeV1: true, revokeV2: true })
    await settle(peers, 1500)
  }

  // Published AFTER arming, so apply stamps the `_w` writer binding on each row.
  await put(pa, a, 'member:' + a.pubkey, { displayName: 'A', caps: CAPS, identityProof: a.identityProof })
  await put(pb, b, 'member:' + b.pubkey, { displayName: 'B', caps: CAPS, identityProof: b.identityProof })
  await put(ph, h, 'member:' + h.pubkey, { displayName: 'H', caps: CAPS, identityProof: h.identityProof })
  await settle(peers, 2000)

  const stop = () => { for (const s of stops) { try { s() } catch {} } }
  return { pa, pb, ph, peers, stop }
}

async function closeAll (s) {
  try { s.stop() } catch {}
  for (const p of s.peers) { try { await p.base.close() } catch {}; try { await p.store.close() } catch {} }
}

const evictedOn = async (peer, pubkey) => {
  await peer.base.update()
  const meta = (await peer.base.view.get('space'))?.value
  return !!(meta && meta.evicted && meta.evicted[pubkey])
}

test("the owner's other phone can remove a member, and every peer keeps it", async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()          // the phone that created the space
  const b = await me()          // the linked phone - same person, different device key
  const housemate = await (await person())()
  const s = await mkSpace({ a, b, h: housemate })
  t.after(() => closeAll(s))

  const res = await methods['member:remove']({ groupId: GID, pubkey: housemate.pubkey }, mkCtx(b, GID, s.pb))
  assert.equal(res.ok, true)
  assert.equal(res.evicted, true)
  await settle(s.peers, 2000)

  // ON THE OTHER PHONES, which is the whole point: a write the client allowed but
  // apply rejected would still look like a success on the writer's own view.
  assert.equal(await evictedOn(s.pa, housemate.pubkey), true, 'the founding phone applied it')
  assert.equal(await evictedOn(s.ph, housemate.pubkey), true, 'the removed member applied it')
})

test('the removal is honest about the half it cannot do', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const s = await mkSpace({ a, b, h: housemate })
  t.after(() => closeAll(s))

  // Cutting a member's WRITER off has its own apply rule (revocation.js), which
  // honours the owner device or a device proving it is the same person as the
  // TARGET. The owner's second phone is neither, so it must not append a revokeWriter
  // and claim the cut - it reports the reason instead.
  const res = await methods['member:remove']({ groupId: GID, pubkey: housemate.pubkey }, mkCtx(b, GID, s.pb))
  assert.equal(res.revoked, false)
  assert.equal(res.why, 'not-owner-device')

  // The founding phone still does the whole job, unchanged.
  const own = await methods['member:remove']({ groupId: GID, pubkey: housemate.pubkey }, mkCtx(a, GID, s.pa))
  assert.equal(own.revoked, true)
  assert.equal(own.why, null)
})

test('an UNARMED space still refuses the other phone, because apply would drop it', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const s = await mkSpace({ a, b, h: housemate, armed: false })
  t.after(() => closeAll(s))

  const ctx = mkCtx(b, GID, s.pb)
  await assert.rejects(
    methods['member:remove']({ groupId: GID, pubkey: housemate.pubkey }, ctx),
    /only the owner can remove a member/,
    'refusing is the honest answer: a success here would be dropped by every peer',
  )
  await assert.rejects(
    methods['space:delete']({ groupId: GID }, ctx),
    /only the owner can delete a space/,
  )
  await settle(s.peers, 1000)
  assert.equal(await evictedOn(s.pa, housemate.pubkey), false, 'nothing landed')
})

test('a HOUSEMATE is still refused on an armed space', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()
  const other = await person()
  const housemate = await other()
  const s = await mkSpace({ a, b, h: housemate })
  t.after(() => closeAll(s))

  // The gate is a proven identity, not merely membership. This is the property that
  // keeps the change from being a seizure button.
  await assert.rejects(
    methods['member:remove']({ groupId: GID, pubkey: b.pubkey }, mkCtx(housemate, GID, s.ph)),
    /only the owner can remove a member/,
  )
  await assert.rejects(
    methods['space:delete']({ groupId: GID }, mkCtx(housemate, GID, s.ph)),
    /only the owner can delete a space/,
  )
})

test("the owner's other phone can delete the space, and members see the tombstone", async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const s = await mkSpace({ a, b, h: housemate })
  t.after(() => closeAll(s))

  const ctx = mkCtx(b, GID, s.pb)
  ctx.localDb = { async del () {} }
  ctx.destroyGroup = async () => {}
  const res = await methods['space:delete']({ groupId: GID }, ctx)
  assert.equal(res.ok, true)
  await settle(s.peers, 2000)

  for (const [label, peer] of [['founder', s.pa], ['housemate', s.ph]]) {
    await peer.base.update()
    const meta = (await peer.base.view.get('space'))?.value
    assert.equal(meta.deleted, true, `${label} applied the tombstone`)
    assert.equal(meta.owner, a.pubkey, 'and ownership did not move - acting on behalf, not taking over')
  }
})

test('the Spaces sheet offers the management controls on the linked phone', async (t) => {
  t.after(cleanup)
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const s = await mkSpace({ a, b, h: housemate })
  t.after(() => closeAll(s))

  // The server-side gate alone would be invisible: the Members sheet gates Remove and
  // Add back on the `owner` flag from spaces:list, and the Spaces sheet swaps trash
  // for leave on it. It has to say yes on the linked phone or nothing changes on
  // screen - which is exactly what Tim would report next.
  const ctx = mkCtx(b, GID, s.pb)
  ctx.localDb = {
    async * createReadStream () {
      yield {
        value: {
          groupId: GID,
          name: 'CleanTest',
          joinedAt: 1,
          groupKey: b4a.alloc(32),
          encryptionKey: b4a.alloc(32),
          bootstrap: b4a.alloc(32),
        },
      }
    },
  }
  const spaces = await methods['spaces:list']({}, ctx)
  assert.equal(spaces.length, 1)
  assert.equal(spaces[0].owner, true, 'the linked phone may manage this space')

  // And a housemate's phone must still say no.
  const hctx = mkCtx(housemate, GID, s.ph)
  hctx.localDb = ctx.localDb
  const hSpaces = await methods['spaces:list']({}, hctx)
  assert.equal(hSpaces[0].owner, false)
})
