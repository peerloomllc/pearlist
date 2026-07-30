// Self-revocation authorisation: you may evict YOUR OWN phone from a space, proven
// by the identity attestation on the member rows, not by being the space owner.
//
// Implements proposals/2026-07-29-removing-a-phone-should-remove-it.md. The forcing
// function: `device:remove` removes MY phone, but the space may belong to a
// housemate, so the owner-only rule meant I could never revoke my own lost device.
//
// THE PROPERTY THAT MUST HOLD is the negative one - a housemate must NOT be able to
// revoke my phone - so that is what most of this file is about. Real proofs, not
// fixtures, so it fails if keet-identity-key's behaviour changes underneath us.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { generateKeypair } = require('@peerloom/core/identity')
const { signValue } = require('@peerloom/core/records')
const { authorizeRevoke, armed, armedSelf, provesSamePerson } = require('../src/revocation.js')
const { REVOKE_CAP, REVOKE_SELF_CAP, allMembersSupportSelfRevoke } = require('../src/listWire.js')

const hex = (b) => b4a.toString(b, 'hex')

// One person: a mnemonic, and any number of devices each attesting its own key.
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  const id = await IdentityKey.from({ mnemonic })
  return {
    async device () {
      const kp = generateKeypair()
      const pubkey = hex(kp.publicKey)
      const proof = hex(await id.bootstrap(b4a.from(pubkey, 'hex')))
      // `_w` is the writer-core key, a DIFFERENT key space from `pubkey`. apply
      // derives it from the authoring core; here we just need it distinct.
      const w = b4a.alloc(32); sodium.randombytes_buf(w)
      return { kp, pubkey, identityProof: proof, _w: hex(w) }
    },
  }
}

// A view stub over member rows + the space meta. Mirrors the shape revocation.js
// reads: view.get('space') and view.createReadStream(MEMBER_RANGE).
function viewOf (meta, members) {
  const m = new Map()
  if (meta) m.set('space', meta)
  for (const r of members) m.set('member:' + r.pubkey, r)
  return {
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async * createReadStream (range = {}) {
      const { gt, lt } = range
      for (const [k, v] of m) {
        if (gt != null && !(k > gt)) continue
        if (lt != null && !(k < lt)) continue
        yield { key: k, value: v }
      }
    },
  }
}

const memberRow = (d, extra = {}) => ({
  pubkey: d.pubkey, identityProof: d.identityProof, _w: d._w,
  caps: [REVOKE_CAP, REVOKE_SELF_CAP], displayName: 'D', updatedAt: 1, ...extra,
})

// A signed revokeWriter op, exactly as listMethods appends one.
const revokeOp = (signer, targetWriterKey, groupId) =>
  signValue({ type: 'revokeWriter', pubkey: targetWriterKey, by: signer.pubkey, groupId }, signer.kp.secretKey)

const GID = 'g1'

test('armedSelf requires BOTH revokeV1 and revokeV2', () => {
  assert.equal(armedSelf({ owner: 'o', revokeV1: true, revokeV2: true }), true)
  assert.equal(armedSelf({ owner: 'o', revokeV1: true }), false, 'v1 alone is not self-armed')
  assert.equal(armedSelf({ owner: 'o', revokeV2: true }), false, 'v2 without v1 is not armed at all')
  assert.equal(armed({ owner: 'o', revokeV1: true }), true, 'v1 alone still arms owner revocation')
})

test('a device may revoke ANOTHER OF ITS OWN, on a v2-armed space', async () => {
  const me = await person()
  const phoneA = await me.device()
  const phoneB = await me.device()
  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  const view = viewOf(meta, [memberRow(phoneA), memberRow(phoneB)])

  // A revokes B. A is NOT the owner - that is the whole point.
  const op = revokeOp(phoneA, phoneB._w, GID)
  assert.equal(await authorizeRevoke(op, { view, groupId: GID }), true)
})

test('THE SECURITY PROPERTY: a housemate may NOT revoke my phone', async () => {
  const me = await person()
  const housemate = await person()
  const mine = await me.device()
  const theirs = await housemate.device()
  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  const view = viewOf(meta, [memberRow(mine), memberRow(theirs)])

  const op = revokeOp(theirs, mine._w, GID)
  assert.equal(await authorizeRevoke(op, { view, groupId: GID }), false,
    'different identity root must not authorise')

  // And the direct check, so a future refactor cannot quietly invert it.
  assert.equal(await provesSamePerson(view, theirs.pubkey, mine._w), false)
  assert.equal(await provesSamePerson(view, mine.pubkey, mine._w), true, 'my own device does match')
})

test('the OWNER rule still works, and does not need v2', async () => {
  const owner = await (await person()).device()
  const other = await (await person()).device()
  const meta = { owner: owner.pubkey, revokeV1: true } // no revokeV2
  const view = viewOf(meta, [memberRow(owner), memberRow(other)])

  assert.equal(await authorizeRevoke(revokeOp(owner, other._w, GID), { view, groupId: GID }), true,
    'owner may revoke anyone, as before')
})

test('same-identity revocation is REFUSED on a space armed only for v1', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const meta = { owner: 'someone-else', revokeV1: true } // v2 NOT armed
  const view = viewOf(meta, [memberRow(a), memberRow(b)])

  assert.equal(await authorizeRevoke(revokeOp(a, b._w, GID), { view, groupId: GID }), false,
    'without revokeV2 an old peer would disagree, so we must refuse too')
})

test('nothing is honoured on an UN-armed space', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const view = viewOf({ owner: a.pubkey }, [memberRow(a), memberRow(b)])
  assert.equal(await authorizeRevoke(revokeOp(a, b._w, GID), { view, groupId: GID }), false)
})

test('an ABSENT proof never matches - not even against another absent one', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  // Both rows stripped of their proofs: two absences must not read as one person.
  const view = viewOf(meta, [
    memberRow(a, { identityProof: undefined }),
    memberRow(b, { identityProof: undefined }),
  ])
  assert.equal(await authorizeRevoke(revokeOp(a, b._w, GID), { view, groupId: GID }), false)
  assert.equal(await provesSamePerson(view, a.pubkey, b._w), false)
})

test('a FORGED proof does not authorise', async () => {
  const victim = await person()
  const vDevice = await victim.device()
  const attackerKp = generateKeypair()
  const attackerPub = hex(attackerKp.publicKey)
  // Attest the attacker's own key against the victim's proof, signed by the
  // attacker - the same forgery memberIdentity.test.js pins as unverifiable.
  const forged = hex(await IdentityKey.attestDevice(
    b4a.from(attackerPub, 'hex'), attackerKp, b4a.from(vDevice.identityProof, 'hex')
  ))
  const w = b4a.alloc(32); sodium.randombytes_buf(w)
  const attacker = { kp: attackerKp, pubkey: attackerPub, identityProof: forged, _w: hex(w) }

  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  const view = viewOf(meta, [memberRow(vDevice), memberRow(attacker)])
  assert.equal(await authorizeRevoke(revokeOp(attacker, vDevice._w, GID), { view, groupId: GID }), false,
    'a forged proof must not let an attacker revoke the victim')
})

test('an op for a DIFFERENT group is refused (no cross-space replay)', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  const view = viewOf(meta, [memberRow(a), memberRow(b)])
  assert.equal(await authorizeRevoke(revokeOp(a, b._w, 'OTHER'), { view, groupId: GID }), false)
})

test('an UNSIGNED or tampered op is refused', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const meta = { owner: 'someone-else', revokeV1: true, revokeV2: true }
  const view = viewOf(meta, [memberRow(a), memberRow(b)])

  const unsigned = { type: 'revokeWriter', pubkey: b._w, by: a.pubkey, groupId: GID }
  assert.equal(await authorizeRevoke(unsigned, { view, groupId: GID }), false, 'no signature')

  // Tamper with the target after signing: the signature must no longer verify.
  const tampered = { ...revokeOp(a, b._w, GID), pubkey: 'ff'.repeat(32) }
  assert.equal(await authorizeRevoke(tampered, { view, groupId: GID }), false, 'tampered target')
})

test('the v2 cap gate needs every member to advertise revoke2', () => {
  const rows = [
    { pubkey: 'a', caps: [REVOKE_CAP, REVOKE_SELF_CAP] },
    { pubkey: 'b', caps: [REVOKE_CAP] }, // old build: understands v1 only
  ]
  assert.equal(allMembersSupportSelfRevoke(rows), false, 'one old member blocks v2')
  assert.equal(allMembersSupportSelfRevoke(rows, ['b']), true, 'unless they are the eviction target')
})
