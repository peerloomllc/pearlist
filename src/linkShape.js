// Telling a PAIRING link from a space INVITE, before either reaches the worklet.
//
// The two look alike to a person - both are `pear://` URLs full of hex that you
// paste into a box - and PearList now has a paste box for each. They are not
// interchangeable and the difference matters more than usual:
//
//   pear://pearlist/join#...     an INVITE. Safe to forward to a housemate. Gets
//                                the holder into ONE space you chose to share.
//   pear://pearlist-device?...   a PAIRING link. Hands over your IDENTITY. The
//                                holder becomes you, in every space you are in.
//
// Different hosts on purpose (see src/deviceLink.js), so a mis-pasted one of
// either kind is rejected outright rather than half-understood.
//
// THIS IS A SHAPE CHECK, NOT A PARSER, and it must not grow into one.
// src/deviceLink.js owns the real parsing and the real validation; a second
// implementation here would drift and the drift would be silent. All this buys is
// a useful error the instant someone pastes the wrong thing, instead of a worklet
// round trip that comes back "missing_params" - which is what the user actually
// saw during the 2026-07-29 hardware run.
//
// Lives in its own module rather than inside App.jsx so it can be unit-tested
// rather than eyeballed, same reasoning as syncStatus.js.

const PAIR_HOST = 'pearlist-device'
const INVITE_HOST = 'pearlist'

// True only for something shaped like a pairing link. Never throws: every caller
// is handling text a user just pasted.
function isPairLink (text) {
  return new RegExp('^pear://' + PAIR_HOST + '(?![\\w-])', 'i').test(String(text == null ? '' : text).trim())
}

// True only for something shaped like a space invite. Used to say "that is an
// invite, not a pairing link" instead of a generic rejection - the two mistakes
// have different fixes and the user should not have to guess which they made.
function isInviteLink (text) {
  return new RegExp('^(pear://' + INVITE_HOST + '(?![\\w-])|https?://[^/]+/' + INVITE_HOST + '/join)', 'i')
    .test(String(text == null ? '' : text).trim())
}

// The message for a paste that is not a pairing link. Named rather than inlined
// so the wording is testable and stays consistent between the two places that
// can open the link screen (onboarding and Settings).
function pairLinkProblem (text) {
  if (isPairLink(text)) return null
  if (isInviteLink(text)) return 'That is a space invite, not a pairing link. On your other phone open Settings and tap Pair.'
  return 'That does not look like a pairing link.'
}

module.exports = { isPairLink, isInviteLink, pairLinkProblem }
