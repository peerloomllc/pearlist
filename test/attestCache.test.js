// The proof cache across a MNEMONIC CHANGE - i.e. across pairing.
//
// This is the case the rest of the suite structurally could not see. Every other
// test either builds proofs directly or drives a mock view, so none of them ever
// changes the mnemonic while the module is loaded. Pairing does exactly that: a
// phone boots with its own phrase, mints a proof, and then ADOPTS the primary's
// phrase. Cached wrongly, it keeps publishing a proof for the person it used to
// be, and the members list shows one person as two.
//
// Found on hardware 2026-07-29 (fresh Pixel + fresh TCL, linked): RoutingGate sat
// at 2 members until a forced republish dropped it to 1. See TODO.md / DONE.md.

const test = require('node:test')
const assert = require('node:assert/strict')
const sodium = require('sodium-universal')
const b4a = require('b4a')

const deviceLink = require('../src/deviceLink.js')
const { identityRootOf } = require('../src/memberIdentity.js')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')

const kp = () => {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
const hex = (b) => b4a.toString(b, 'hex')

const rootOfMnemonic = async (m) => hex((await IdentityKey.from({ mnemonic: m })).identityPublicKey)

test('attestSelf re-derives when the mnemonic changes (pairing), and caches when it does not', async () => {
  deviceLink._resetForTest()

  const device = kp()
  const devHex = hex(device.publicKey)

  // 1. Unpaired: this phone has its own phrase and attests itself under it.
  const own = IdentityKey.generateMnemonic()
  deviceLink.provisionMnemonic(own)
  const before = await deviceLink.attestSelf(devHex)
  assert.ok(before, 'a proof is produced while unpaired')
  assert.equal(await identityRootOf(before), await rootOfMnemonic(own))

  // Same mnemonic + same device key must not re-derive: the cache still has to do
  // its job, or publishMember pays for an attestation on every space refresh.
  assert.equal(await deviceLink.attestSelf(devHex), before, 'cached while nothing changed')

  // 2. Pairing: the phone adopts the primary's phrase. THE REGRESSION - the old
  // code returned `before` here, attesting to a person this device no longer is.
  const theirs = IdentityKey.generateMnemonic()
  deviceLink.provisionMnemonic(theirs)
  const after = await deviceLink.attestSelf(devHex)

  assert.notEqual(after, before, 'a new proof after the mnemonic changed')
  assert.equal(await identityRootOf(after), await rootOfMnemonic(theirs),
    'the proof attests to the NEW identity, i.e. the person we just became')
  assert.notEqual(await identityRootOf(after), await identityRootOf(before))

  deviceLink._resetForTest()
})

test('attestSelf returns null with no mnemonic, and does not serve a stale proof after one is cleared', async () => {
  deviceLink._resetForTest()
  const device = kp()
  const devHex = hex(device.publicKey)

  assert.equal(await deviceLink.attestSelf(devHex), null, 'no mnemonic, no proof')

  const m = IdentityKey.generateMnemonic()
  deviceLink.provisionMnemonic(m)
  assert.ok(await deviceLink.attestSelf(devHex))

  // Clearing the phrase must not leave the cached proof reachable.
  deviceLink.provisionMnemonic(null)
  assert.equal(await deviceLink.attestSelf(devHex), null, 'proof is gone with the phrase')

  deviceLink._resetForTest()
})

test('a proof for a DIFFERENT device key is not served from cache', async () => {
  deviceLink._resetForTest()
  const m = IdentityKey.generateMnemonic()
  deviceLink.provisionMnemonic(m)

  const a = hex(kp().publicKey)
  const b = hex(kp().publicKey)
  const pa = await deviceLink.attestSelf(a)
  const pb = await deviceLink.attestSelf(b)

  assert.notEqual(pa, pb, 'each device key gets its own proof')
  // Both are the same person, which is the whole point of the collapse.
  assert.equal(await identityRootOf(pa), await identityRootOf(pb))

  deviceLink._resetForTest()
})
