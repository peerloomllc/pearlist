// Pins the linked-device roster: the IPC contract it depends on, the asymmetry
// between rename and remove, and - most importantly - that the removal copy does
// not claim more than removal does.
//
// Source-level, in the style of appVersion.test.js: the UI bundle is built after
// the tests run, and driving device-link end to end needs two real devices.
//
// These exist because `device:setNickname` and `device:remove` sat implemented
// and UNREACHABLE from slice 2 until 2026-07-29. Nothing exercised them, so the
// rename method passed its arguments in the wrong order for weeks without a
// single failure.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '')
const app = () => stripComments(read('src/ui/App.jsx'))
const methods = () => stripComments(read('src/listMethods.js'))

test('device:setNickname passes exactly one argument, matching the engine', () => {
  const src = methods()
  // personal.js declares `setDeviceNickname (nickname)`. It used to be called as
  // `setDeviceNickname(writerKey, nickname)`, which set the nickname to a 64-char
  // hex writer key and dropped the real one.
  assert.match(src, /'device:setNickname':\s*async\s*\(\{\s*nickname\s*\}/,
    'the IPC should take { nickname } only')
  assert.match(src, /dl\.setDeviceNickname\(String\(nickname \|\| ''\)\)/,
    'and pass a single argument')
  assert.doesNotMatch(src, /setDeviceNickname\([^)]*,/, 'no second argument')
})

test('the engine really does only let a device name itself', () => {
  // Guards the assumption the UI is built on. If device-link ever grows the
  // ability to name another device, the roster should offer it - and this test
  // failing is the prompt to revisit that.
  const personal = read('../peerloom-device-link/src/personal.js')
  assert.match(personal, /async function setDeviceNickname \(nickname\)/,
    'setDeviceNickname takes only a nickname')
  assert.match(personal, /const writerKey = b4a\.toString\(personalBase\.local\.key, 'hex'\)/,
    'and derives the target from the LOCAL key, so it can only be this device')
})

test('the roster offers rename for this phone and remove for others', () => {
  const src = app()
  assert.match(src, /function DeviceRosterSheet/, 'the roster should be a real component')
  // Rename has no writerKey - it cannot target another device.
  assert.match(src, /call\('device:setNickname', \{ nickname \}\)/)
  // Remove always targets another device's writerKey.
  assert.match(src, /call\('device:remove', \{ writerKey: d\.writerKey \}\)/)
})

// THE IMPORTANT ONE, and the truth it guards MOVED on 2026-07-29.
//
// Removal now revokes the device's writer key on the PERSONAL base
// (peerloom-device-link PR #6), so it really can no longer change your own
// account. It still does NOT touch the shared spaces - the removed phone keeps the
// per-space writer keys granted at pairing and can edit those lists until the
// space-side half of the revocation proposal ships.
//
// So the copy has to hit the middle: more than "hides a row", less than a lockout.
// Rounding it UP tells someone their lost phone is shut out when it is not, which
// is the worst thing to be wrong about here. Rounding it DOWN understates a real
// protection and pushes people to recreate spaces they did not need to.
test('the removal confirm claims exactly what removal now does, no more', () => {
  const src = app()
  const at = src.indexOf('async function removeDevice')
  assert.ok(at > 0, 'removeDevice should exist')
  const body = src.slice(at, at + 1600)

  assert.match(body, /askConfirm\(/, 'removal must be confirmed')
  // The protection it DOES now give.
  assert.match(body, /can no longer change your own account/i, 'must state the account-level revocation')
  // The limit it still has - and this must stay explicit.
  assert.match(body, /does NOT lock that phone out of your shared lists/i, 'must scope the limit to shared lists')
  assert.match(body, /recovery phrase/i, 'naming why: it still holds the phrase')

  // Claims that would over-promise: a blanket lockout, or revoking the spaces.
  for (const claim of [/locks? (that|the) phone out(?! of your shared)/i, /revokes? (its|the) access/i, /cannot edit/i, /shut out/i]) {
    assert.doesNotMatch(body, claim, `removal copy must not over-promise: ${claim}`)
  }
})

test('listMethods describes device:remove as it now behaves', () => {
  // The comment claimed "blocks its writer" (false), was corrected to "there is no
  // removeWriter in device-link" (true until PR #6), and is now true again in a
  // narrower way. Comments are where the next person forms their mental model, so
  // this pins the current shape rather than any past one.
  const raw = read('src/listMethods.js')
  assert.doesNotMatch(raw, /blocks its writer/, 'that claim was false')
  assert.doesNotMatch(raw, /There is no removeWriter in device-link/, 'no longer true as of device-link PR #6')
  assert.match(raw, /revoke the device's writer key on the PERSONAL base/i, 'say what it does')
  assert.match(raw, /does NOT touch the SHARED SPACES/i, 'and what it still does not')
})

test('a device label falls back consistently, and empty nicknames do not win', () => {
  const src = app()
  assert.match(src, /function deviceLabel/, 'one label helper, used by roster and summary')
  // A nickname of '   ' must not render as a blank row.
  assert.match(src, /d\.nickname && String\(d\.nickname\)\.trim\(\)/)
  // The summary line and the roster must agree on who "this phone" is. The
  // engine returns `self`; the old summary line only checked `isThisDevice`.
  const selfChecks = src.match(/d\.self \|\| d\.isThisDevice/g) || []
  assert.ok(selfChecks.length >= 2, 'both places should accept either flag')
})
