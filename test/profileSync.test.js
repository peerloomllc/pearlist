// Your name follows YOU, not the phone you last touched.
//
// proposals/2026-07-29-profile-belongs-to-the-person.md. The bug as observed on
// hardware 2026-07-29: the Pixel's profile said "Tim", the TCL's said "TCL", and
// the household saw "TCL" - whichever phone republished last. These pin the rules
// that make one person's phones agree, and the two guards that keep a profile
// which syncs on every reconnect from becoming a write-amplification bug.

const test = require('node:test')
const assert = require('node:assert/strict')
const { profileRecordOf, isProfileRecord, sameProfileContent, decideProfileMirror, shouldFetchAvatar } = require('../src/profileSync')

const AV = { avatarBlob: { key: 'k', id: 7 }, avatarHash: 'h1', avatarType: 'image/png' }

test('the record carries the name and the avatar REFERENCE, never bytes', () => {
  const r = profileRecordOf({ displayName: 'Tim', updatedAt: 5, v: 1, ...AV })
  assert.deepEqual(r, { displayName: 'Tim', updatedAt: 5, v: 1, ...AV })
  // A few dozen bytes, so the personal base does not become a blob store.
  assert.ok(JSON.stringify(r).length < 200)
})

test('a profile with no avatar carries no avatar fields', () => {
  const r = profileRecordOf({ displayName: 'Tim', updatedAt: 5 })
  assert.equal('avatarBlob' in r, false)
  assert.equal('avatarHash' in r, false)
})

test('the name is clamped and a junk profile makes no record', () => {
  assert.equal(profileRecordOf({ displayName: 'x'.repeat(200), updatedAt: 1 }).displayName.length, 64)
  assert.equal(profileRecordOf(null), null)
  assert.equal(profileRecordOf('nope'), null)
})

test('validation runs inside apply on every device, so it is total', () => {
  assert.equal(isProfileRecord({ displayName: 'Tim', updatedAt: 1 }), true)
  assert.equal(isProfileRecord({ displayName: '', updatedAt: 1 }), false)
  assert.equal(isProfileRecord({ displayName: 'Tim' }), false, 'no timestamp')
  assert.equal(isProfileRecord({ displayName: 'Tim', updatedAt: NaN }), false)
  assert.equal(isProfileRecord({ displayName: 'x'.repeat(65), updatedAt: 1 }), false)
  assert.equal(isProfileRecord(null), false)
  assert.equal(isProfileRecord(undefined), false)
  assert.equal(isProfileRecord('Tim'), false)
})

// THE BUG ITSELF. Two phones, one person, different names: the newer one wins on
// BOTH devices, so collapseMembers gets the same answer whichever row it reads
// last and the household stops seeing the name flip.
test('a newer profile from my other phone replaces this one', () => {
  const d = decideProfileMirror({
    incoming: { displayName: 'Tim', updatedAt: 200 },
    current: { displayName: 'TCL', updatedAt: 100 },
  })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'newer')
})

test('an older profile never wins', () => {
  const d = decideProfileMirror({
    incoming: { displayName: 'TCL', updatedAt: 100 },
    current: { displayName: 'Tim', updatedAt: 200 },
  })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'stale')
})

test('a device with no profile of its own takes what arrives', () => {
  const d = decideProfileMirror({ incoming: { displayName: 'Tim', updatedAt: 1 }, current: null })
  assert.equal(d.accept, true)
  assert.equal(d.reason, 'no_local_profile')
})

// GUARD ONE. The mirror fires on every device that applies the op INCLUDING THE
// AUTHOR, whose localDb already holds exactly this profile at exactly this
// timestamp. Without `<=` the author would republish its own rename to every
// space, and that republish is what feeds the loop.
test('the author does not echo its own rename back', () => {
  const same = { displayName: 'Tim', updatedAt: 200 }
  const d = decideProfileMirror({ incoming: same, current: { ...same } })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'stale')
})

// GUARD TWO. A genuinely newer record that changes nothing visible is dropped.
// This is the one the proposal asked for a test rather than only a hardware
// measurement, because it is what keeps a resync-on-reconnect from appending a
// member row every time two phones meet.
test('a newer record that changes nothing visible is dropped', () => {
  const d = decideProfileMirror({
    incoming: { displayName: 'Tim', updatedAt: 999 },
    current: { displayName: 'Tim', updatedAt: 100 },
  })
  assert.equal(d.accept, false)
  assert.equal(d.reason, 'no_change')
})

test('the same name with a DIFFERENT avatar is a real change', () => {
  const d = decideProfileMirror({
    incoming: { displayName: 'Tim', updatedAt: 999, ...AV },
    current: { displayName: 'Tim', updatedAt: 100 },
  })
  assert.equal(d.accept, true, 'gaining an avatar must sync')
  const swapped = decideProfileMirror({
    incoming: { displayName: 'Tim', updatedAt: 999, ...AV, avatarHash: 'h2' },
    current: { displayName: 'Tim', updatedAt: 100, ...AV },
  })
  assert.equal(swapped.accept, true, 'and so must swapping the picture')
})

test('content comparison is by HASH, since two devices hold different blob ids', () => {
  assert.equal(sameProfileContent(
    { displayName: 'Tim', avatarBlob: { key: 'k1', id: 1 }, avatarHash: 'h1' },
    { displayName: 'Tim', avatarBlob: { key: 'k2', id: 9 }, avatarHash: 'h1' },
  ), true, 'same bytes, different local ids - not a change')
  assert.equal(sameProfileContent(
    { displayName: 'Tim', avatarHash: 'h1' },
    { displayName: 'Tim' },
  ), false, 'losing the avatar IS a change')
})

test('junk arriving from a peer is refused, not applied', () => {
  assert.equal(decideProfileMirror({ incoming: null, current: { displayName: 'Tim', updatedAt: 1 } }).reason, 'bad_record')
  assert.equal(decideProfileMirror({ incoming: { displayName: '' }, current: null }).reason, 'bad_record')
})

// A device that never linked has no personal base, so nothing ever reaches the
// mirror and the local profile stands. Asserted here as a property of the
// decision - "current wins unless something newer AND different arrives" - since
// the absence of a code path cannot be tested directly.
test('an unlinked device keeps its own profile, because nothing newer ever arrives', () => {
  const mine = { displayName: 'Tim', updatedAt: 500 }
  for (const incoming of [{ displayName: 'Other', updatedAt: 1 }, { displayName: 'Tim', updatedAt: 500 }]) {
    assert.equal(decideProfileMirror({ incoming, current: mine }).accept, false)
  }
})

// --- the guard that keeps this feature from switching linking on ---------------
//
// `putProfileRecord` is called from `profile:set` and from `member:getAll`, and
// member:getAll runs on every roster refresh in every build. `getDeviceLink` is
// flag-agnostic by design, so the first version - which just called it - STARTED
// device linking for everyone. Four tests went red (member rows suddenly carried
// identity proofs, bases were written mid-test) and that is the only reason it did
// not ship. This pins the two guards that replaced it.
const deviceLink = require('../src/deviceLink')

test('publishing a profile never constructs device-link, let alone starts it', async () => {
  // A ctx that screams if it is touched at all: the guards must return before any
  // of it is read, so there is nothing to construct an engine out of.
  const ctx = new Proxy({}, { get (_t, prop) { throw new Error('putProfileRecord touched ctx.' + String(prop)) } })
  assert.equal(await deviceLink.putProfileRecord(ctx, { displayName: 'Tim', updatedAt: 1 }), false)
  assert.equal(deviceLink.isDeviceLinkStarted(), false, 'and nothing was started behind our back')
})

test('it stays false for a junk profile too, without reaching the flag check', async () => {
  const ctx = new Proxy({}, { get () { throw new Error('touched ctx') } })
  assert.equal(await deviceLink.putProfileRecord(ctx, null), false)
  assert.equal(deviceLink.isDeviceLinkStarted(), false)
})

// --- the eager avatar fetch ---------------------------------------------------
//
// A mirrored record only arrives while the other device is CONNECTED, so that is
// the moment its picture is certainly available - the same reasoning as the
// pairing-time fetch. But the fetch waits up to 8s for replication, so it must
// run once per distinct image and not once per sync.

test('a new picture is fetched, the same one is not fetched twice', () => {
  const withAv = { displayName: 'Tim', updatedAt: 2, ...AV }
  assert.equal(shouldFetchAvatar(withAv, { displayName: 'Tim', updatedAt: 1 }), true, 'gaining a picture')
  assert.equal(shouldFetchAvatar(withAv, { displayName: 'Tim', updatedAt: 1, ...AV }), false, 'already have it')
  assert.equal(shouldFetchAvatar(withAv, null), true, 'nothing local at all')
})

// Keyed on the content HASH: two devices legitimately hold different blob ids for
// identical bytes, so comparing references would refetch the same image forever.
test('the same bytes under a different blob id are not refetched', () => {
  const mine = { displayName: 'Tim', avatarBlob: { key: 'k1', id: 1 }, avatarHash: 'h1' }
  const theirs = { displayName: 'Tim', updatedAt: 9, avatarBlob: { key: 'k2', id: 9 }, avatarHash: 'h1' }
  assert.equal(shouldFetchAvatar(theirs, mine), false)
  assert.equal(shouldFetchAvatar({ ...theirs, avatarHash: 'h2' }, mine), true, 'a genuinely different picture is fetched')
})

test('nothing to fetch when there is no usable reference', () => {
  assert.equal(shouldFetchAvatar({ displayName: 'Tim' }, null), false)
  assert.equal(shouldFetchAvatar({ displayName: 'Tim', avatarHash: 'h1' }, null), false, 'hash without a reference')
  assert.equal(shouldFetchAvatar({ displayName: 'Tim', avatarBlob: { key: 'k' }, avatarHash: 'h' }, null), false, 'reference without an id')
  assert.equal(shouldFetchAvatar(null, null), false)
})
