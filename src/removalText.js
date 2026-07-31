// What removing one of your own phones actually does, in the user's terms.
//
// Its own module because this sentence went out of step with the code TWICE on
// 2026-07-30, in one day, in opposite directions:
//
//   1. It promised the removed phone would NOT be locked out of shared lists.
//      Written when that was true of every space, left behind when space-side
//      revocation shipped. On an armed space the user was told it kept access and
//      then, seconds later, told it had been cut off. Both dialogs, one flow.
//   2. It then said "to use that phone again you would have to delete PearList on
//      it and set it up from scratch". That was true in the morning and false by
//      the evening: re-pairing a removed phone WITHOUT a reinstall was proven on
//      the TCL + iPhone SE the same day (DONE.md 2026-07-30, pearlist #140).
//
// Twice in a day is not bad luck, it is hand-written copy about behaviour that
// keeps moving. So it lives here, derived from the removal preview and covered by
// tests, the same reasoning as syncStatus.js and userText.js.
//
// THE THREE THINGS IT MUST KEEP SAYING, none of them optional:
//   - what happens to your own account (always the same)
//   - what happens to SHARED spaces (depends on how many are armed and ready)
//   - that the removal is permanent, and that the phone coming back needs a phone
//     you are HOLDING. A person removing a lost phone is asking exactly one
//     question: can whoever has it get back in. They cannot.

// The part that never varies: the personal base.
const ACCOUNT = 'It stops showing in this list and can no longer change your own account.'

// The shared-space half, from `device:removalPreview`. `ready` is a FLOOR, not a
// promise - the owner-transfer step can still fail, and the result message reports
// what actually landed - so nothing here may claim a clean sweep.
function spaceLine (ready, total) {
  if (!(ready > 0)) {
    return 'It does NOT lock that phone out of your shared lists - it still has your recovery phrase and your spaces, and can still edit them. To take it off those for real you would need to move them to a new space.'
  }
  if (ready >= total) {
    return `It will also be cut off from your shared lists${total > 1 ? ` (${total} spaces)` : ''}, so it can no longer change them. It keeps your recovery phrase and can still SEE what it already has.`
  }
  return `It will also be cut off from ${ready} of your ${total} shared spaces. In the rest it can still edit, because everyone there has to be on the latest version first. It keeps your recovery phrase and can still SEE what it already has.`
}

// PERMANENCE, and it is about CONSEQUENCE rather than reversibility.
//
// What is permanent: removal writes a `revokedWriter:` record into the personal
// base's view and the admission path refuses that key forever, on every device
// (peerloom-device-link src/personal.js). That key never comes back.
//
// What is NOT permanent, and is why the old wording was wrong: the PHONE can come
// back. Re-pairing mints a NEW writer key, which was never revoked, so it is
// admitted normally. No reinstall, proven on hardware.
//
// Those two facts only sound contradictory if the sentence is about undoing. It is
// not. It is about who can walk back in, and the answer is: only someone holding
// one of your phones, because re-pairing needs the link from Settings on a phone
// you already have. Losing the phone does not lose that.
const FOREVER = 'This cannot be undone: that phone loses its access for good. If you get the phone back you can set it up again by pairing it from a phone you are holding. Whoever has it cannot do that on their own.'

// The whole confirm body. `preview` is the `device:removalPreview` reply, or null
// when that call failed - in which case we still must not go silent, so it
// degrades to the no-spaces wording, which is the one that promises least.
function deviceRemovalMessage (preview) {
  const ready = preview?.ready || 0
  const total = preview?.total || 0
  return `${ACCOUNT} ${spaceLine(ready, total)} ${FOREVER}`
}

module.exports = { deviceRemovalMessage, ACCOUNT, FOREVER, _spaceLine: spaceLine }
