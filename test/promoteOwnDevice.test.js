// The owner's OWN second phone is promoted to an indexer, so the space's creator
// stops being un-removable.
//
// proposals/2026-07-30-the-space-creator-cannot-be-removed.md. The forcing case,
// found on hardware: removing the TCL from the iPhone reported success and the TCL
// went on editing. Autobase will not remove the last indexer, `admitWriter` admits
// post-arming writers as non-indexers, so the phone that CREATED a space is its only
// indexer forever - the worst phone for it to be.
//
// REAL Autobase and the REAL applyListOp: the property is "does Autobase now let the
// creator go", which no mock can answer.

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
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-promo-')); _dirs.push(d); return d }
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

// The engine's apply loop, with PearList's admitWriter policy: once armed, new
// writers are admitted as NON-indexers. That policy is what creates the trap, so the
// test has to reproduce it rather than assume indexers everywhere.
function makeApply (groupId, selfKey) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        let indexer = true
        try {
          const meta = (await view.get('space'))?.value
          if (meta && meta.revokeV1 === true) indexer = false
        } catch {}
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer })
        continue
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
async function mkPeer ({ bootstrap, selfKey }) {
  const store = new Corestore(tmpDir())
  await store.ready()
  const base = new Autobase(store.namespace('g'), bootstrap, {
    open: openView, apply: makeApply('g', selfKey), valueEncoding: 'json',
  })
  await base.ready()
  return { store, base }
}
function connect (a, b) {
  const s1 = a.store.replicate(true); const s2 = b.store.replicate(false); s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}
async function settle (ps, ms = 2500) {
  for (const p of ps) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of ps) { try { await p.base.update() } catch {} }
}
let clock = 1700000000000
async function put (peer, dev, key, value) {
  await peer.base.append({ type: 'put', key, value: signValue({ ...value, pubkey: dev.pubkey, updatedAt: ++clock }, dev.secretKey) })
}
const CAPS = ['revoke1', 'revoke2', 'promote1']

// Owner + the owner's second phone + a housemate. Armed, with promoteV1 set by
// `armed`, so the same setup exercises both the promoted and the un-promoted case.
async function household (t, { promote }) {
  const mkTim = await person(); const mkSam = await person()
  const A = await mkTim(); const B = await mkTim(); const C = await mkSam()

  const owner = await mkPeer({ bootstrap: null, selfKey: A.pubkey })
  const mine = await mkPeer({ bootstrap: owner.base.key, selfKey: B.pubkey })
  const mate = await mkPeer({ bootstrap: owner.base.key, selfKey: C.pubkey })
  const stops = [connect(owner, mine), connect(owner, mate), connect(mine, mate)]
  t.after(() => stops.forEach((s) => s()))

  await put(owner, A, 'space', { owner: A.pubkey, name: 'House' })
  await settle([owner, mine, mate])
  // ARM FIRST, so the two joiners are admitted as non-indexers - the real sequence,
  // and the one that leaves the creator alone in the indexer set.
  await put(owner, A, 'space', {
    ...(await owner.base.view.get('space')).value,
    revokeV1: true, revokeV2: true, ...(promote ? { promoteV1: true } : {}),
  })
  await settle([owner, mine, mate])

  await owner.base.append({ type: 'addWriter', pubkey: hex(mine.base.local.key) })
  await owner.base.append({ type: 'addWriter', pubkey: hex(mate.base.local.key) })
  await settle([owner, mine, mate], 3000)

  await put(owner, A, 'member:' + A.pubkey, { displayName: 'Tim', caps: CAPS, identityProof: A.identityProof })
  await put(mine, B, 'member:' + B.pubkey, { displayName: 'Tim', caps: CAPS, identityProof: B.identityProof })
  await put(mate, C, 'member:' + C.pubkey, { displayName: 'Sam', caps: CAPS, identityProof: C.identityProof })
  await settle([owner, mine, mate], 3000)
  await settle([owner, mine, mate], 2000)

  return { A, B, C, owner, mine, mate }
}

test('WITHOUT promoteV1 the creator is stuck as the only indexer - the trap', async (t) => {
  t.after(cleanup)
  const { owner } = await household(t, { promote: false })
  assert.equal(owner.base.removeable(owner.base.local.key), false,
    'the space creator cannot be removed, which is what made the removal lie on hardware')
})

test('WITH promoteV1 the owner\'s own second phone signs, and the creator becomes removeable', async (t) => {
  t.after(cleanup)
  const { A, B, C, owner, mine, mate } = await household(t, { promote: true })

  assert.equal(owner.base.removeable(owner.base.local.key), true,
    'promoting the owner\'s other phone frees the creator')

  // NARROW: the housemate must NOT have been promoted. Keeping a housemate a
  // non-indexer is the whole reason post-arming writers are admitted that way, so
  // revoking one never disturbs who signs.
  const mineW = (await owner.base.view.get('member:' + B.pubkey)).value._w
  const mateW = (await owner.base.view.get('member:' + C.pubkey)).value._w
  assert.equal(typeof mineW, 'string', 'own phone has a writer binding')
  assert.equal(typeof mateW, 'string', 'housemate has a writer binding')
  assert.equal(owner.base.removeable(b4a.from(mateW, 'hex')), true,
    'the housemate is still removeable, i.e. still a non-indexer')

  // AND THE POINT OF ALL OF IT: the creator can now actually be cut off, and the
  // remaining phone keeps working.
  const ownerW = (await owner.base.view.get('member:' + A.pubkey)).value._w
  await mine.base.append({ type: 'revokeWriter', pubkey: ownerW })
  await settle([owner, mine, mate], 4000)
  await settle([owner, mine, mate], 3000)
  assert.equal(owner.base.writable, false, 'the creator is genuinely cut off')

  await put(mine, B, 'list:l1', { listId: 'l1', name: 'Groceries' })
  await settle([owner, mine, mate], 3000)
  assert.equal((await mate.base.view.get('list:l1'))?.value?.name, 'Groceries',
    'the household keeps working with the creator gone')
})

test('re-publishing a member row does not run away - the promotion is idempotent', async (t) => {
  t.after(cleanup)
  const { B, mine, mate, owner } = await household(t, { promote: true })

  // The promotion fires on EVERY member write, by design: there is no safe "is it
  // already an indexer" read to branch on inside apply, because indexed state lags
  // and two peers could answer differently - which is the fork this is gated to
  // avoid. So it must be genuinely idempotent. This app has already had one write
  // amplification loop; a re-admit that appends every time would be another.
  const before = mine.base.view.core.length
  for (let i = 0; i < 6; i++) {
    await put(mine, B, 'member:' + B.pubkey, { displayName: 'Tim', caps: CAPS, identityProof: B.identityProof })
  }
  await settle([owner, mine, mate], 3000)
  await settle([owner, mine, mate], 2000)
  const after = mine.base.view.core.length

  // Six writes may add at most a handful of blocks. A promotion that re-admitted on
  // every apply would multiply this.
  assert.ok(after - before <= 20,
    `six member re-publishes must not amplify (grew ${after - before} blocks)`)
  assert.equal(mine.base.writable, true, 'and the base is still healthy')
  assert.equal(owner.base.removeable(owner.base.local.key), true, 'creator still removeable')
})

test('the gate refuses to arm promoteV1 while any member lacks the capability', () => {
  const rows = [
    { pubkey: 'a'.repeat(64), caps: ['revoke1', 'revoke2', 'promote1'] },
    { pubkey: 'b'.repeat(64), caps: ['revoke1', 'revoke2'] }, // knows revocation, not this
  ]
  assert.equal(CURRENT.allMembersSupportPromote(rows), false,
    'one member without promote1 blocks it - otherwise that peer computes a different indexer set and forks')
  assert.equal(CURRENT.allMembersSupportPromote(rows.slice(0, 1)), true, 'an all-current roster arms')
  // Same exemption as the other caps: the device being removed is precisely the one
  // that will never advertise support.
  assert.equal(CURRENT.allMembersSupportPromote(rows, ['b'.repeat(64)]), true, 'the eviction target is exempt')
})

test('promote1 is advertised and armed alongside the other capabilities', () => {
  const wire = fs.readFileSync(path.join(__dirname, '../src/listWire.js'), 'utf8')
  const methods = fs.readFileSync(path.join(__dirname, '../src/listMethods.js'), 'utf8')

  // A THIRD gate, because it changes the INDEXER SET - which decides who signs the
  // view, so a peer that skips it forks. Same reasoning as revoke1 and revoke2.
  assert.match(wire, /const PROMOTE_CAP = 'promote1'/)
  assert.match(methods, /caps: \[REVOKE_CAP, REVOKE_SELF_CAP, PROMOTE_CAP\]/, 'advertised on every member row')
  assert.match(methods, /const promoteOk = allMembersSupportPromote\(rows, evicted\)/, 'gated on everyone supporting it')
  assert.match(methods, /if \(promoteOk\) next\.promoteV1 = true/, 'armed with the rest')

  // The promotion itself must be gated on the armed flag, not merely on the cap -
  // the cap says a peer UNDERSTANDS it, the flag says the space has turned it on.
  assert.match(wire, /meta\.promoteV1 !== true/, 'dormant until the space arms it')
  // ...and it must never promote a housemate.
  assert.match(wire, /if \(!await sameIdentityAsOwner\(view, row\.pubkey, meta\.owner\)\) return/,
    'only the owner\'s own devices')

  // AND IT MUST BE REACHABLE ON AN ALREADY-ARMED SPACE. The Turn-on control
  // disappears once armed - correctly, arming is one way - so without a catch-up
  // path any capability added later is unreachable on every existing space, however
  // long everyone waits. promoteV1 was the first to hit that.
  assert.match(methods, /meta\.revokeV2 !== true \|\| meta\.promoteV1 !== true/,
    'an armed space notices it is missing a later flag')
  assert.match(methods, /armRevocation\(ctx, groupId\)\.catch/, 'and re-runs the gate to pick it up')
})
