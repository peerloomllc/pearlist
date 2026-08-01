// DOES A REMOVAL FROM A SPACE ACTUALLY STICK?
//
// Raised while validating peerloom-core#19, which makes a revoked writer ask to be
// let back in without needing a reconnect (so "Add back" takes immediately instead of
// after a force-quit). The worry it raised: the pair channel admits ANY non-writer
// that asks, and shared spaces deliberately keep no denylist -
// test/readmission.test.js pins that as an intentional choice, because it is what
// lets a phone removed by accident be re-paired.
//
// Put together, those two say a removed phone gets let straight back in. If true,
// removal from a space is cosmetic against a phone that is still on the network, and
// the confirm copy - "can no longer change anything here" - is a lie.
//
// MEASURED, NOT REASONED. This repo has been wrong about Autobase semantics from
// confident reasoning before and wrote it into a merged commit message
// (proposals/2026-07-30-repairing-a-removed-phone.md, corrected the same day). So this
// file drives the real `member:remove` over a real pair channel and asks what actually
// happens. Whatever it prints is the answer, including if it exonerates the change.
//
// The connection carries BOTH corestore replication and the pair channel over one
// SecretStream, which is the shape engine.js gives it from a swarm connection. A
// hand-piped store.replicate(true) makes its own stream, Protomux.from() then sees a
// different mux, and the channels never pair at all - a failure indistinguishable from
// "nothing was re-admitted", i.e. from a passing test. That trap cost two runs in
// peerloom-core and is why the wiring is spelled out here.

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
const SecretStream = require('@hyperswarm/secret-stream')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { signValue } = require('@peerloom/core/records')
const { setupPairChannel } = require('@peerloom/core/pairing')
const listWire = require('../src/listWire.js')
const { authorizeRevoke, admitWriter } = require('../src/revocation.js')
const methods = require('../src/listMethods.js')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-stays-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAPS = [listWire.REVOKE_CAP, listWire.REVOKE_SELF_CAP, listWire.PROMOTE_CAP]
const GID = 'g-stays-removed'

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

// The same three branches engine.js runs, with PearList's hooks.
//
// `seen` COUNTS ADMISSIONS AND REVOCATIONS BY KEY, which is the whole measurement.
// The first cut asserted on `base.writable` going false and then staying false, and
// both tests failed on the precondition - writable never observably dropped at all.
// That is ambiguous in the worst way: it reads identically whether the removal never
// worked or whether it worked and was undone within a poll interval. Counting the ops
// answers the actual question, and cannot be raced.
function makeApply (groupId, selfKey, seen) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        if (seen) seen.admits.push({ pubkey: op.pubkey, at: Date.now() })
        const how = await admitWriter(op, { view })
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: how.indexer !== false })
        continue
      }
      if (op.type === 'revokeWriter' && typeof op.pubkey === 'string') {
        if (!await authorizeRevoke(op, { view, groupId })) continue
        if (seen) seen.revokes.push({ pubkey: op.pubkey, at: Date.now() })
        const key = b4a.from(op.pubkey, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(key)) continue
        try { await base.removeWriter(key) } catch {}
        continue
      }
      await listWire.applyListOp(op, { view, base, groupId, node, emit () {}, selfKey })
    }
  }
}

async function mkPeer ({ bootstrap, selfKey, seen }) {
  const store = new Corestore(tmpDir())
  await store.ready()
  const base = new Autobase(store.namespace(GID), bootstrap, {
    open: openView, apply: makeApply(GID, selfKey, seen), valueEncoding: 'json',
  })
  base.on('error', () => {})
  await base.ready()
  return { store, base }
}

// One connection, both protocols, pair channels on each side - as a phone has it.
function link (a, b, opts = {}, pair = true) {
  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)
  s1.on('error', () => {}); s2.on('error', () => {})
  s1.rawStream.pipe(s2.rawStream).pipe(s1.rawStream)
  a.store.replicate(s1)
  b.store.replicate(s2)
  if (pair) {
    setupPairChannel({ ...opts, conn: s1, groupId: GID, base: a.base })
    setupPairChannel({ ...opts, conn: s2, groupId: GID, base: b.base })
  }
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}

async function settle (peers, ms = 1500) {
  for (const p of peers) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of peers) { try { await p.base.update() } catch {} }
}
async function until (fn, peers, ms = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    for (const p of peers) { try { await p.base.update() } catch {} }
    if (await fn()) return true
    await sleep(150)
  }
  return false
}

let clock = 1700000000000
async function put (peer, dev, key, value) {
  await peer.base.append({
    type: 'put', key, value: signValue({ ...value, pubkey: dev.pubkey, updatedAt: ++clock }, dev.secretKey),
  })
}
function mkCtx (dev, peer) {
  const bases = new Map([[GID, peer.base]])
  return {
    identity: { publicKey: dev.publicKey, secretKey: dev.secretKey },
    bases,
    async append (gid, value) { await bases.get(gid).append(value) },
    emit () {},
    localDb: { async get () { return null } },
  }
}

// An ARMED space with the housemate admitted before arming, which is the real order on
// a phone and the harder case: a pre-arming joiner is an INDEXER, not a plain writer.
async function armedSpace (o, m, opts, { pair = true } = {}) {
  // ONE COUNTER PER PEER. Sharing a single object double-counts every op, because both
  // peers apply the same block - the first cut read "2 admissions" for one admission
  // and made the numbers unreadable. `seen` below is the OWNER's view, i.e. the
  // admitter's, which is where an admission is decided.
  const seen = { admits: [], revokes: [] }
  const seenMate = { admits: [], revokes: [] }
  const po = await mkPeer({ bootstrap: null, selfKey: o.publicKey, seen })
  const pm = await mkPeer({ bootstrap: po.base.key, selfKey: m.publicKey, seen: seenMate })
  const stop = link(po, pm, opts, pair)
  const peers = [po, pm]

  await put(po, o, 'space', { owner: o.pubkey, name: 'House' })
  await po.base.append({ type: 'addWriter', pubkey: hex(pm.base.local.key), indexer: true })
  await settle(peers, 2000)

  const meta = (await po.base.view.get('space')).value
  await put(po, o, 'space', { ...meta, revokeV1: true, revokeV2: true })
  await settle(peers, 1500)

  // Published AFTER arming so apply stamps the `_w` writer binding, without which a
  // removal silently degrades to hide-only and the test would prove nothing.
  await put(po, o, 'member:' + o.pubkey, { displayName: 'Owner', caps: CAPS, identityProof: o.identityProof })
  await put(pm, m, 'member:' + m.pubkey, { displayName: 'Mate', caps: CAPS, identityProof: m.identityProof })
  await settle(peers, 2000)
  return { po, pm, peers, stop, seen, seenMate }
}

async function closeAll (s) {
  try { s.stop() } catch {}
  for (const p of s.peers || []) { try { await p.base.close() } catch {}; try { await p.store.close() } catch {} }
}

// CONTROL FIRST. Without the pair channel there is nothing that could re-admit, so
// this establishes that the removal itself works and that the harness can SEE it work.
// Without this, a "removal took effect" failure in the next test is unreadable.
test('CONTROL: with no pair channel, a removal takes effect and stays', async (t) => {
  t.after(cleanup)
  const owner = await (await person())()
  const mate = await (await person())()
  const s = await armedSpace(owner, mate, {}, { pair: false })
  t.after(() => closeAll(s))

  assert.equal(s.pm.base.writable, true, 'the housemate could write to begin with')
  const mateWriter = hex(s.pm.base.local.key)

  const res = await methods['member:remove']({ groupId: GID, pubkey: mate.pubkey }, mkCtx(owner, s.po))
  assert.equal(res.revoked, true, 'the removal revoked the writer')
  assert.equal(await until(() => s.pm.base.writable === false, s.peers), true,
    'and the removed peer really did lose write access')

  await settle(s.peers, 3000)
  assert.equal(s.pm.base.writable, false, 'and it stayed lost')
  assert.equal(s.seen.admits.filter((a) => a.pubkey === mateWriter).length, 1,
    'exactly the one admission from joining, and none after')
})

// THE MEASUREMENT, now pinned as the DECIDED behaviour rather than as a defect.
//
// A removed housemate is a non-writer, and the pair channel exists to admit
// non-writers. Nothing in that path consults the eviction, and spaces keep no
// denylist. So the removed phone IS let back in while the connection is up - measured
// here, and measured as a REGRESSION from peerloom-core#19: on the previous engine
// this same test found no re-admission, because a revoked device stopped asking.
//
// Tim decided to keep that trade, 2026-07-31: "I don't care about 'if they lose their
// phone and need to revoke access' because they can just delete a space and create a
// new one." Removal is a roster action, not a lock. What it bought is that a phone the
// owner ADDS BACK works instantly instead of after a force-quit, which is a thing
// people actually do. See DECISIONS.md.
//
// SO THIS TEST EXISTS TO STOP THE COPY DRIFTING BACK. If someone later makes removal
// a real lock, this goes red and points them at the confirm wording that would then be
// wrong in the other direction.
test('MEASURED: a removed member IS re-admitted over a live pair channel (decided)', async (t) => {
  t.after(cleanup)
  const owner = await (await person())()
  const mate = await (await person())()
  // Fast timings so the answer arrives in seconds rather than the production 30s.
  const s = await armedSpace(owner, mate, { helloRetryMs: 150, admitSuppressMs: 400 })
  t.after(() => closeAll(s))

  assert.equal(s.pm.base.writable, true, 'precondition: the housemate can write')
  const mateWriter = hex(s.pm.base.local.key)
  const admitsBefore = s.seen.admits.filter((a) => a.pubkey === mateWriter).length

  const res = await methods['member:remove']({ groupId: GID, pubkey: mate.pubkey }, mkCtx(owner, s.po))
  assert.equal(res.revoked, true, 'precondition: the removal actually revoked the writer')
  assert.equal(await until(() => s.seen.revokes.some((r) => r.pubkey === mateWriter), s.peers), true,
    'precondition: the revocation was APPLIED, not merely appended')

  // Now leave everything running. No reconnect, no restart - just time.
  await settle(s.peers, 4000)

  // COUNTED, NOT SAMPLED. Whether `writable` is true at any instant is a race against
  // the retry cadence; whether a NEW addWriter was applied for a key the owner just
  // revoked is a fact. This is the measurement the whole file exists for.
  const admitsAfter = s.seen.admits.filter((a) => a.pubkey === mateWriter).length
  const readmitted = admitsAfter > admitsBefore

  assert.equal(readmitted, true,
    `removal is deliberately NOT a lock: the pair channel re-admits a revoked writer ` +
    `(admissions for that writer: ${admitsBefore} before the removal, ${admitsAfter} after; ` +
    `writable now: ${s.pm.base.writable}). If this goes red, removal has become a lock ` +
    `and the confirm copy in App.jsx - which says it is NOT one - needs rewriting.`)
  assert.equal(s.pm.base.writable, true, 'and the removed peer really can write again')
})

// The other half, and the one that must keep working: a member the owner DELIBERATELY
// restores has to get back in without a reconnect. That is what peerloom-core#19 was
// for, and it is the behaviour any fix to the test above must not break.
test('a member the owner ADDS BACK is re-admitted without a reconnect', async (t) => {
  t.after(cleanup)
  const owner = await (await person())()
  const mate = await (await person())()
  const s = await armedSpace(owner, mate, { helloRetryMs: 150, admitSuppressMs: 400 })
  t.after(() => closeAll(s))

  const ctx = mkCtx(owner, s.po)
  const mateWriter = hex(s.pm.base.local.key)
  await methods['member:remove']({ groupId: GID, pubkey: mate.pubkey }, ctx)
  assert.equal(await until(() => s.seen.revokes.some((r) => r.pubkey === mateWriter), s.peers), true,
    'removed first (asserted on the APPLIED revocation, not on a raced writable flag)')

  await methods['member:restore']({ groupId: GID, pubkey: mate.pubkey }, ctx)
  await settle(s.peers, 1000)

  assert.equal(await until(() => s.pm.base.writable === true, s.peers), true,
    'Add back gets them writing again with the connection still up')
})
