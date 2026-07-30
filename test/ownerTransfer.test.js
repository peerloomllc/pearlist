// Same-identity OWNERSHIP TRANSFER: another of the owner's own phones may take a
// space over. Implements the last piece of
// proposals/2026-07-29-removing-a-phone-should-remove-it.md.
//
// WHY IT EXISTS, watched on hardware 2026-07-29: revoking a phone that OWNED a space
// left that space permanently unmanageable, because the owner is the only device that
// may rename, delete, evict or arm. A button labelled "remove this phone" locked its
// own user out. So removal transfers ownership first and revokes second.
//
// THE PROPERTY THAT MUST HOLD is that this is NOT a seizure button - which is exactly
// what got ownership RECOVERY declined in July (2026-07-28-space-ownership-recovery.md).
// That was about letting somebody else claim a space when the owner is gone, and
// nothing can tell a legitimate claim from a grab. This is the same person's other
// device, and it is checkable. Most of this file is therefore the negative cases.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { generateKeypair } = require('@peerloom/core/identity')
const { signValue } = require('@peerloom/core/records')
const { applyListOp, memberKey, REVOKE_CAP, REVOKE_SELF_CAP } = require('../src/listWire.js')

const hex = (b) => b4a.toString(b, 'hex')

async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  const id = await IdentityKey.from({ mnemonic })
  return {
    async device () {
      const kp = generateKeypair()
      const pubkey = hex(kp.publicKey)
      const identityProof = hex(await id.bootstrap(b4a.from(pubkey, 'hex')))
      return { kp, pubkey, identityProof }
    },
  }
}

// A mutable view stub matching what applyListOp uses.
function mkView (initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    map: m,
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { m.set(k, v) },
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

const memberRow = (d, ts = 1) => signValue({
  pubkey: d.pubkey, updatedAt: ts, displayName: 'D',
  identityProof: d.identityProof, caps: [REVOKE_CAP, REVOKE_SELF_CAP],
}, d.kp.secretKey)

// The `space` row as the owner would sign it.
const spaceRow = (signer, owner, extra = {}, ts = 100) =>
  signValue({ pubkey: signer.pubkey, owner, updatedAt: ts, ...extra }, signer.kp.secretKey)

const apply = (op, view) => applyListOp(op, { view, groupId: 'g', emit: () => {} })

// Space armed for v2, owned by `ownerDev`, with both devices as members.
async function armedSpace (ownerDev, otherDev) {
  const view = mkView()
  await apply({ type: 'put', key: memberKey(ownerDev.pubkey), value: memberRow(ownerDev) }, view)
  await apply({ type: 'put', key: memberKey(otherDev.pubkey), value: memberRow(otherDev) }, view)
  await apply({ type: 'put', key: 'space', value: spaceRow(ownerDev, ownerDev.pubkey) }, view)
  await apply({ type: 'put', key: 'space', value: spaceRow(ownerDev, ownerDev.pubkey, { revokeV1: true, revokeV2: true }, 200) }, view)
  const meta = (await view.get('space')).value
  assert.equal(meta.revokeV2, true, 'space is armed for v2')
  return view
}

test("another of the owner's OWN phones may take the space over", async () => {
  const me = await person()
  const phoneA = await me.device()   // owner
  const phoneB = await me.device()   // the one taking over
  const view = await armedSpace(phoneA, phoneB)

  await apply({ type: 'put', key: 'space', value: spaceRow(phoneB, phoneB.pubkey, { revokeV1: true, revokeV2: true }, 300) }, view)
  assert.equal((await view.get('space')).value.owner, phoneB.pubkey, 'ownership moved')
})

test('NO SEIZURE: a housemate may NOT take the space over', async () => {
  const me = await person()
  const them = await person()
  const mine = await me.device()
  const theirs = await them.device()
  const view = await armedSpace(mine, theirs)

  await apply({ type: 'put', key: 'space', value: spaceRow(theirs, theirs.pubkey, { revokeV1: true, revokeV2: true }, 300) }, view)
  assert.equal((await view.get('space')).value.owner, mine.pubkey, 'ownership must NOT move')
})

test('a phone may not hand the space to a STRANGER, even its own owner', async () => {
  const me = await person()
  const them = await person()
  const phoneA = await me.device()
  const phoneB = await me.device()
  const stranger = await them.device()
  const view = await armedSpace(phoneA, phoneB)
  await apply({ type: 'put', key: memberKey(stranger.pubkey), value: memberRow(stranger) }, view)

  // B proves the same person as the owner, but names the STRANGER as new owner.
  await apply({ type: 'put', key: 'space', value: spaceRow(phoneB, stranger.pubkey, { revokeV1: true, revokeV2: true }, 300) }, view)
  assert.equal((await view.get('space')).value.owner, phoneA.pubkey,
    'the new owner must also prove the same identity')
})

test('transfer is REFUSED on a space not armed for v2', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const view = mkView()
  await apply({ type: 'put', key: memberKey(a.pubkey), value: memberRow(a) }, view)
  await apply({ type: 'put', key: memberKey(b.pubkey), value: memberRow(b) }, view)
  await apply({ type: 'put', key: 'space', value: spaceRow(a, a.pubkey, { revokeV1: true }, 200) }, view)

  await apply({ type: 'put', key: 'space', value: spaceRow(b, b.pubkey, { revokeV1: true }, 300) }, view)
  assert.equal((await view.get('space')).value.owner, a.pubkey,
    'without revokeV2 an old peer would disagree, so refuse')
})

test('an ABSENT proof never transfers - not even against another absent one', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const view = mkView()
  // Member rows with the proofs stripped.
  const strip = (d) => signValue({ pubkey: d.pubkey, updatedAt: 1, displayName: 'D', caps: [REVOKE_CAP, REVOKE_SELF_CAP] }, d.kp.secretKey)
  await apply({ type: 'put', key: memberKey(a.pubkey), value: strip(a) }, view)
  await apply({ type: 'put', key: memberKey(b.pubkey), value: strip(b) }, view)
  await apply({ type: 'put', key: 'space', value: spaceRow(a, a.pubkey, { revokeV1: true, revokeV2: true }, 200) }, view)

  await apply({ type: 'put', key: 'space', value: spaceRow(b, b.pubkey, { revokeV1: true, revokeV2: true }, 300) }, view)
  assert.equal((await view.get('space')).value.owner, a.pubkey, 'two absences are not one person')
})

test('the owner can still update its own row, and a stale write is still dropped', async () => {
  const me = await person()
  const a = await me.device(); const b = await me.device()
  const view = await armedSpace(a, b)

  await apply({ type: 'put', key: 'space', value: spaceRow(a, a.pubkey, { revokeV1: true, revokeV2: true, name: 'renamed' }, 300) }, view)
  assert.equal((await view.get('space')).value.name, 'renamed', 'owner still writes normally')

  // Older timestamp from the legitimate owner: still rejected.
  await apply({ type: 'put', key: 'space', value: spaceRow(a, a.pubkey, { revokeV1: true, revokeV2: true, name: 'stale' }, 250) }, view)
  assert.equal((await view.get('space')).value.name, 'renamed', 'stale write dropped')
})
