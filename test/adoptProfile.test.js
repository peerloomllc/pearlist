// The linked-device profile copy: when is it allowed to overwrite?
//
// STOPGAP behaviour, deliberately. A freshly paired phone should already be you -
// same name, same picture - because that is what "this is my other phone" means.
// The real fix moves the profile to personal scope
// (proposals/2026-07-29-profile-belongs-to-the-person.md), which rejects this copy
// as a *fix* because it does not keep the two in step afterwards. Tim decided
// linking ships first, so this exists to stop every freshly paired phone from
// showing the household its own default name.
//
// The rule with teeth: NEVER overwrite a name the user chose. That is the one way
// this could destroy something, so it is what gets tested.

const test = require('node:test')
const assert = require('node:assert/strict')

const { _isUntouchedProfile: isUntouched } = require('../src/listMethods.js')

test('no profile at all counts as untouched', () => {
  assert.equal(isUntouched(null), true)
  assert.equal(isUntouched(undefined), true)
  assert.equal(isUntouched({}), true)
})

test('the untouched default ("Member", no avatar) may be overwritten', () => {
  assert.equal(isUntouched({ displayName: 'Member' }), true)
  assert.equal(isUntouched({ displayName: '  Member  ' }), true, 'whitespace does not make it chosen')
  assert.equal(isUntouched({ displayName: '' }), true)
  assert.equal(isUntouched({ displayName: '   ' }), true)
})

test('a name the user chose is NEVER overwritten', () => {
  assert.equal(isUntouched({ displayName: 'Tim' }), false)
  assert.equal(isUntouched({ displayName: 'TCL' }), false)
  // The near-miss cases: anything that is not exactly the default is a choice.
  assert.equal(isUntouched({ displayName: 'member' }), false, 'lowercase is a deliberate name')
  assert.equal(isUntouched({ displayName: 'Members' }), false)
  assert.equal(isUntouched({ displayName: 'Member 2' }), false)
})

test('an avatar alone makes a profile touched, even on the default name', () => {
  // Someone who set a picture but never typed a name has still made a choice, and
  // adopting over it would silently discard their photo.
  assert.equal(isUntouched({ displayName: 'Member', avatarBlob: { key: 'k', id: 1 } }), false)
  assert.equal(isUntouched({ avatarBlob: { key: 'k', id: 1 } }), false)
  assert.equal(isUntouched({ displayName: 'Member', avatar: 'data:image/png;base64,AAA' }), false,
    'legacy inline avatar counts too')
})
