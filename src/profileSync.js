// Your name follows YOU, not the phone you last touched.
//
// proposals/2026-07-29-profile-belongs-to-the-person.md, option D. The display
// name is stored per DEVICE (localDb `profile`, published on each device's own
// member row) and `collapseMembers` resolves a conflict by taking the most
// recently updated row. That rule is right for one person renaming themselves and
// wrong for one person holding two phones: the household sees whichever phone you
// touched last, and it FLIPS. Watched on hardware 2026-07-29 - the Pixel said
// "Tim", the TCL said "TCL", the household saw "TCL".
//
// The fix is to put the profile on the person: device-link already keeps a
// personal Autobase shared across one person's devices, so a rename on either
// phone reaches both and the conflict stops existing rather than being resolved.
//
// This file is the DECISION half - pure, no Autobase, no ctx - so the rules can be
// tested without a rig. The wiring is in deviceLink.js (registry + mirror) and
// listMethods.js (write on rename, apply on mirror).
//
// SPACE ROWS DO NOT CHANGE. Each device still publishes `member:{pubkey}` with
// `displayName` and the avatar reference on it, so an old peer reads exactly what
// it read before and cannot tell the difference. That is what keeps this T2.

// The fields that travel between a person's own devices. Deliberately the same
// shape localDb already stores, so the mirror can write it straight back and every
// existing reader (publishMember, profile:get) picks it up untouched.
//
// The avatar is a REFERENCE, not bytes: `{ key, id }` into a blob core plus the
// content hash. Moving the profile therefore moves a few dozen bytes and the
// personal base does not become a blob store. Making the BYTES reachable on a
// person's own devices is the second half of the proposal and is not this file.
function profileRecordOf (profile) {
  if (!profile || typeof profile !== 'object') return null
  const out = {
    displayName: String(profile.displayName || '').slice(0, 64),
    updatedAt: typeof profile.updatedAt === 'number' ? profile.updatedAt : 0,
    v: 1,
  }
  if (profile.avatarBlob && profile.avatarHash) {
    out.avatarBlob = { key: profile.avatarBlob.key, id: profile.avatarBlob.id }
    out.avatarHash = profile.avatarHash
    out.avatarType = profile.avatarType || 'image/png'
  }
  return out
}

// What the personal base will accept as a `profile` record. Runs inside
// device-link's apply on EVERY device, so it must be total and cheap.
function isProfileRecord (v) {
  return !!v && typeof v === 'object' &&
    typeof v.displayName === 'string' && v.displayName.length > 0 && v.displayName.length <= 64 &&
    typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)
}

// Do two profiles say the same thing about the person? Compares only what the
// household can see - the name and which image - and ignores `updatedAt`, which is
// the whole point: a republish that would not change a single visible field is not
// worth an append.
function sameProfileContent (a, b) {
  if (!a || !b) return false
  if (String(a.displayName || '') !== String(b.displayName || '')) return false
  // Hash first: it is the content identity, and two devices can hold different
  // blob ids for identical bytes.
  const ah = a.avatarHash || null
  const bh = b.avatarHash || null
  if (ah !== bh) return false
  if (!ah) return !a.avatarBlob === !b.avatarBlob // neither has an avatar, or both lack one
  return true
}

// Should a profile arriving from one of this person's OTHER devices replace the
// one this device holds?
//
// LAST WRITE WINS on `updatedAt`, the same rule the rest of the app uses, with the
// same known limit: a device with a fast clock wins. Consistent beats clever here -
// a different rule in one place is a rule nobody remembers.
//
// `<=` NOT `<`, and that matters more than it looks: the mirror fires on EVERY
// device that applies the op INCLUDING THE AUTHOR, whose localDb already holds
// this exact profile at this exact timestamp. Treating equal as stale is what
// stops the author echoing its own rename back into a republish.
//
// AND THE CONTENT GUARD. Even a genuinely newer record is dropped when nothing
// visible differs. This app has had two write-amplification bugs already - eight
// appends in twenty seconds, measured on hardware - both from a self-healing check
// that re-fired on stale state. A profile that syncs on every reconnect must not
// become the third.
function decideProfileMirror ({ incoming, current }) {
  if (!isProfileRecord(incoming)) return { accept: false, reason: 'bad_record' }
  if (!current) return { accept: true, reason: 'no_local_profile' }
  const cur = typeof current.updatedAt === 'number' ? current.updatedAt : 0
  if (incoming.updatedAt <= cur) return { accept: false, reason: 'stale' }
  if (sameProfileContent(incoming, current)) return { accept: false, reason: 'no_change' }
  return { accept: true, reason: 'newer' }
}

module.exports = { profileRecordOf, isProfileRecord, sameProfileContent, decideProfileMirror }
