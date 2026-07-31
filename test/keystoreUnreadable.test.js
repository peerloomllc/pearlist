// "Nothing stored" and "cannot read the store" are not the same answer.
//
// Collapsing them into null was a real bug: device-link has no "I do not know"
// state, so a false `hasMnemonic()` means "fresh device" and it MINTS a new
// identity. A phone that merely could not read its keystore this boot therefore
// became a different person - losing its place in every space and reappearing to
// the household as a stranger, silently.
//
// Watched for half a day on 2026-07-31: an unsigned iOS Simulator build cannot
// reach the Keychain at all (-34018) and re-minted on EVERY launch, which is what
// made two linked devices show up as two people.

const test = require('node:test')
const assert = require('node:assert/strict')
const deviceLink = require('../src/deviceLink')

test.beforeEach(() => deviceLink._resetForTest())
test.after(() => deviceLink._resetForTest())

test('an unreadable store with no phrase in hand is flagged', () => {
  deviceLink.provisionMnemonic(null, false)
  assert.equal(deviceLink.isKeystoreUnreadable(), true)
})

test('an empty but READABLE store is an ordinary fresh device', () => {
  deviceLink.provisionMnemonic(null, true)
  assert.equal(deviceLink.isKeystoreUnreadable(), false, 'minting here is correct - it really is a new device')
})

test('a phrase in hand means there is nothing to lose, whatever the store said', () => {
  deviceLink.provisionMnemonic('word '.repeat(11) + 'word', false)
  assert.equal(deviceLink.isKeystoreUnreadable(), false)
})

test('the default is readable, so an old shell that sends no flag behaves as before', () => {
  deviceLink.provisionMnemonic(null)
  assert.equal(deviceLink.isKeystoreUnreadable(), false)
})

// THE POINT OF THE FLAG. Starting device-link is what mints, so when the store is
// unreadable it must not start at all. Refusing makes linking unavailable until
// the keystore works and SAYS so; minting would discard the person permanently.
// An unavailable feature is recoverable on the next boot. A discarded identity is not.
test('device-link refuses to start when the store is unreadable, without touching ctx', async () => {
  deviceLink.provisionMnemonic(null, false)
  const ctx = new Proxy({}, { get (_t, p) { throw new Error('getDeviceLink touched ctx.' + String(p)) } })
  await assert.rejects(() => deviceLink.getDeviceLink(ctx), /secure storage is unavailable/)
  assert.equal(deviceLink.isDeviceLinkStarted(), false, 'and nothing was constructed')
})
