// Real proofs, not fixtures: these build actual keet-identity-key attestations so
// the tests fail if the library's behaviour changes under us. That matters more
// than usual here - the whole design rests on "a forged proof does not verify",
// and a hand-rolled fixture would keep passing long after that stopped being true.

const test = require('node:test')
const assert = require('node:assert/strict')
// device-link's package.json `exports` blocks deep subpath imports, so the test
// reaches the library by path. Only the TEST needs it - src/memberIdentity.js goes
// through device-link's own identity module, which is the point.
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const sodium = require('sodium-universal')
const b4a = require('b4a')

const { identityRootOf, collapseMembers, sameIdentityKeys, _cache } = require('../src/memberIdentity.js')

const kp = () => {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
const hex = (b) => b4a.toString(b, 'hex')

// One person's two phones: same mnemonic, separate device keys, each attesting
// itself. This is exactly what happens after pairing.
async function person () {
  const mnemonic = IdentityKey.generateMnemonic()
  const id = await IdentityKey.from({ mnemonic })
  const device = async () => {
    const d = kp()
    const proof = await IdentityKey.from({ mnemonic }).then((i) => i.bootstrap(d.publicKey))
    return { pubkey: hex(d.publicKey), identityProof: hex(proof) }
  }
  return { id, device }
}

test('a self-bootstrapped proof verifies to the identity root', async () => {
  const p = await person()
  const a = await p.device()
  const root = await identityRootOf(a.identityProof)
  assert.ok(root, 'should verify')
  assert.equal(root, hex(p.id.identityPublicKey))
})

test('two phones of one person verify to the SAME root, with no coordination', async () => {
  const p = await person()
  const [a, b] = [await p.device(), await p.device()]
  assert.notEqual(a.pubkey, b.pubkey, 'different device keys')
  assert.equal(await identityRootOf(a.identityProof), await identityRootOf(b.identityProof))
})

test('two different people never share a root', async () => {
  const [p, q] = [await person(), await person()]
  const [a, b] = [await p.device(), await q.device()]
  assert.notEqual(await identityRootOf(a.identityProof), await identityRootOf(b.identityProof))
})

test('junk proofs return null instead of throwing', async () => {
  for (const bad of [null, undefined, '', 'zz', 'deadbeef', 42, {}]) {
    assert.equal(await identityRootOf(bad), null)
  }
})

test('collapse merges one person and leaves everyone else alone', async () => {
  const [p, q] = [await person(), await person()]
  const a1 = { ...(await p.device()), displayName: 'Tim', updatedAt: 100 }
  const a2 = { ...(await p.device()), displayName: 'Tim (new phone)', updatedAt: 200 }
  const other = { ...(await q.device()), displayName: 'Partner', updatedAt: 150 }

  const out = await collapseMembers([a1, a2, other])
  assert.equal(out.length, 2, 'one person, plus the other person')
  // Most recently updated row supplies the name.
  assert.equal(out[0].displayName, 'Tim (new phone)')
  assert.equal(out[1].displayName, 'Partner')
})

test('the collapsed row keeps its position rather than jumping to the end', async () => {
  const [p, q] = [await person(), await person()]
  const first = { ...(await q.device()), displayName: 'Alice', updatedAt: 10 }
  const a1 = { ...(await p.device()), displayName: 'Tim', updatedAt: 100 }
  const a2 = { ...(await p.device()), displayName: 'Tim2', updatedAt: 200 }
  const out = await collapseMembers([first, a1, a2])
  assert.deepEqual(out.map((m) => m.displayName), ['Alice', 'Tim2'])
})

// The one rule with no exception.
test('rows without a proof are NEVER merged with each other', async () => {
  const bare = [
    { pubkey: 'aa', displayName: 'Housemate one' },
    { pubkey: 'bb', displayName: 'Housemate two' },
    { pubkey: 'cc', displayName: 'Housemate three', identityProof: 'garbage' },
  ]
  const out = await collapseMembers(bare)
  assert.equal(out.length, 3, 'absence of proof is not evidence of sameness')
})

// A collapsed person must resolve for EVERY key they sign with, or an assignment
// to their other phone renders as "?" - which is what happened on hardware before
// `keys` existed.
test('a collapsed person carries every device key they sign with', async () => {
  const p = await person()
  const a1 = { ...(await p.device()), displayName: 'Tim', updatedAt: 100 }
  const a2 = { ...(await p.device()), displayName: 'Tim', updatedAt: 200 }
  const [row] = await collapseMembers([a1, a2])
  assert.equal(row.keys.length, 2)
  assert.ok(row.keys.includes(a1.pubkey) && row.keys.includes(a2.pubkey))
  // Including when the newer row wins and replaces the representative.
  assert.equal(row.pubkey, a2.pubkey)
})

test('an uncollapsed member still resolves by its own key', async () => {
  const p = await person()
  const solo = { ...(await p.device()), displayName: 'Solo', updatedAt: 1 }
  const [row] = await collapseMembers([solo])
  assert.deepEqual(row.keys, [solo.pubkey])
})

test('the UI copy carries nothing device-shaped', async () => {
  const p = await person()
  const a = { ...(await p.device()), displayName: 'Tim', updatedAt: 5 }
  const [row] = await collapseMembers([a])
  // Tim's call: the members list shows people, never hardware.
  assert.equal(row.identityProof, undefined)
  assert.equal(row.updatedAt, undefined)
  assert.equal(row.deviceCount, undefined)
  assert.equal(row.displayName, 'Tim')
  // `keys` IS present - it is what resolves an assignment back to a person. It is
  // never rendered, and nothing may derive a visible device count from it.
})

test('collapse is safe on empty and malformed input', async () => {
  assert.deepEqual(await collapseMembers([]), [])
  assert.deepEqual(await collapseMembers(null), [])
  assert.deepEqual(await collapseMembers(undefined), [])
})

test('sameIdentityKeys finds my other phones and nobody else', async () => {
  const [p, q] = [await person(), await person()]
  const mine1 = await p.device()
  const mine2 = await p.device()
  const theirs = await q.device()

  const keys = await sameIdentityKeys([mine1, mine2, theirs], mine1.pubkey)
  assert.ok(keys.has(mine1.pubkey), 'includes me')
  assert.ok(keys.has(mine2.pubkey), 'includes my other phone')
  assert.ok(!keys.has(theirs.pubkey), 'excludes the other person')
})

// If we cannot prove who we are, we must not claim anyone. The dangerous failure
// is the opposite of the obvious one: matching everything unproven would route a
// housemate's assignments to us.
test('sameIdentityKeys claims nobody when we have no proof of our own', async () => {
  const q = await person()
  const theirs = await q.device()
  const me = { pubkey: 'mine-no-proof' }
  const keys = await sameIdentityKeys([me, theirs], 'mine-no-proof')
  assert.deepEqual([...keys], ['mine-no-proof'])
})

test('verification is cached, including negative results', async () => {
  _cache.clear()
  const p = await person()
  const a = await p.device()
  await identityRootOf(a.identityProof)
  await identityRootOf(a.identityProof)
  await identityRootOf('not-a-proof')
  await identityRootOf('not-a-proof')
  assert.equal(_cache.size, 2, 'one entry per distinct input, failures included')
  assert.equal(_cache.get('not-a-proof'), null)
})

// The security property the whole design rests on. If this ever passes, the
// members list can be spoofed and assignments can be stolen.
test('a FORGED proof does not verify', async () => {
  const victim = await person()
  const real = await victim.device()

  const attacker = kp()
  const forged = await IdentityKey.attestDevice(
    attacker.publicKey, attacker, b4a.from(real.identityProof, 'hex')
  )
  assert.equal(await identityRootOf(hex(forged)), null, 'forgery must not verify')

  // And it must not collapse into the victim's row.
  const out = await collapseMembers([
    { ...real, displayName: 'Victim', updatedAt: 1 },
    { pubkey: hex(attacker.publicKey), identityProof: hex(forged), displayName: 'Attacker', updatedAt: 2 },
  ])
  assert.equal(out.length, 2, 'attacker stays their own row')
  assert.equal(out[0].displayName, 'Victim')
})
