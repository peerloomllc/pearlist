// The device-removal confirm, pinned against a THIRD drift.
//
// This sentence was wrong twice on 2026-07-30, in opposite directions - first
// promising the phone kept access to shared lists after space revocation shipped,
// then promising a reinstall was the only way back after re-pairing was proven on
// hardware. Both were hand-written copy about behaviour that had moved.
//
// So these tests pin the PROPERTIES the copy has to keep, not its wording. A
// rewrite that still tells the truth passes; one that quietly drops the safety
// half does not.

const test = require('node:test')
const assert = require('node:assert/strict')
const { deviceRemovalMessage, FOREVER, _spaceLine } = require('../src/removalText.js')

test('the confirm never claims a reinstall is the only way back', () => {
  // The 2026-07-30 regression, exactly. Re-pairing a removed phone WITHOUT a
  // reinstall is proven on the TCL + iPhone SE (DONE.md, pearlist #140), so any
  // wording that sends the user to delete the app is a lie.
  for (const preview of [null, { ready: 0, total: 0 }, { ready: 1, total: 1 }, { ready: 1, total: 3 }]) {
    const msg = deviceRemovalMessage(preview)
    assert.ok(!/delete PearList/i.test(msg), 'does not tell the user to delete the app')
    assert.ok(!/from scratch/i.test(msg), 'does not claim setting up from scratch is required')
  }
})

test('but it still says the removal itself is permanent', () => {
  // The writer key is denylisted forever, on every device. Softening this to make
  // room for the re-pair fact would be the opposite mistake.
  assert.match(FOREVER, /cannot be undone/i, 'the removal is permanent and says so')
  assert.match(FOREVER, /for good/i, 'and that the access loss is not temporary')
})

test('and it answers the question a person removing a LOST phone is actually asking', () => {
  // "Can whoever has it get back in?" No: re-pairing needs the link from Settings
  // on a phone you are holding. Dropping this half would leave someone who just
  // lost a phone with no answer to the only thing they care about.
  assert.match(FOREVER, /holding/i, 'says the way back needs a phone you hold')
  assert.match(FOREVER, /cannot do that on their own/i, 'and says the finder cannot')
})

test('the shared-space half tracks the preview and never over-promises', () => {
  // `ready` is a FLOOR - owner transfer can still fail - so no wording may promise
  // a clean sweep. Three states, three different truths.
  const none = _spaceLine(0, 0)
  assert.match(none, /does NOT lock that phone out/, 'no armed spaces: says so plainly')

  const all = _spaceLine(3, 3)
  assert.match(all, /\(3 spaces\)/, 'all ready: counts them')
  assert.match(all, /can still SEE what it already has/, 'and does not pretend reading is revoked')

  const some = _spaceLine(1, 4)
  assert.match(some, /1 of your 4 shared spaces/, 'partial: names both numbers')
  assert.match(some, /In the rest it can still edit/, 'and is explicit about the remainder')

  // Singular reads as a sentence rather than "(1 spaces)".
  assert.ok(!/\(1 spaces?\)/.test(_spaceLine(1, 1)), 'one space is not parenthesised')
})

test('a failed preview degrades to the wording that promises least', () => {
  // device:removalPreview can fail. Going silent is not an option, and neither is
  // guessing high: an unknown state must not be described as "cut off".
  assert.equal(deviceRemovalMessage(null), deviceRemovalMessage({ ready: 0, total: 0 }),
    'null preview reads as the no-spaces case')
  assert.ok(!/cut off/i.test(deviceRemovalMessage(null)),
    'and never claims a cut-off it could not verify')
})

test('every variant is one plain paragraph, with all three parts present', () => {
  for (const preview of [{ ready: 0, total: 0 }, { ready: 2, total: 2 }, { ready: 1, total: 5 }]) {
    const msg = deviceRemovalMessage(preview)
    assert.match(msg, /^It stops showing in this list/, 'opens with what it does to your account')
    assert.ok(msg.includes(FOREVER), 'and always ends with the permanence half')
    assert.ok(!msg.includes('—'), 'no em dashes, per CLAUDE.md')
    assert.ok(!/\n/.test(msg), 'a single paragraph, not a list')
  }
})
