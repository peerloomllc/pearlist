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

// THE IMPORTANT ONE, and the truth it guards has MOVED TWICE.
//
// Removal revokes the device's writer key on the PERSONAL base (device-link PR #6)
// AND, in every armed space, cuts it off there too (revokeDeviceFromSpaces). It
// does not stop the phone READING what it already holds, and re-pairing brings the
// phone back on a fresh key with no reinstall (pearlist #140, hardware-proven).
//
// The copy now lives in src/removalText.js and is tested against its OUTPUT in
// test/removalText.test.js. This test used to assert the shape of App.jsx's string
// interpolation (`${spaceLine} ${forever}`, `ready === 0`) - which pinned the
// formatting rather than the claim, broke the moment the copy was extracted, and
// had frozen `delete PearList on it` in place after that stopped being true. So
// what stays here is only what is genuinely about the SCREEN: that removeDevice
// asks the worklet first and renders the derived message.
test('the removal confirm is derived, not hand-written at the call site', () => {
  const src = app()
  const at = src.indexOf('async function removeDevice')
  assert.ok(at > 0, 'removeDevice should exist')
  const body = src.slice(at, at + 900)

  assert.match(body, /askConfirm\(/, 'removal must be confirmed')
  assert.match(body, /device:removalPreview/, 'and must ask what will actually happen first')
  assert.match(body, /message: deviceRemovalMessage\(preview\)/,
    'the message comes from the tested module, built from that preview')
  assert.match(src, /import \{ deviceRemovalMessage \} from '\.\.\/removalText\.js'/,
    'imported rather than reimplemented')

  // No hand-written removal copy may creep back in beside it.
  assert.doesNotMatch(body, /does NOT lock that phone out/,
    'the branch wording belongs in removalText.js, not here')
  assert.doesNotMatch(body, /cannot be undone/i,
    'and so does the permanence sentence')
})

test('listMethods describes device:remove as it now behaves', () => {
  // The comment claimed "blocks its writer" (false), was corrected to "there is no
  // removeWriter in device-link" (true until PR #6), then to "does NOT touch the
  // SHARED SPACES" - which THIS TEST then pinned in place for months after
  // revokeDeviceFromSpaces started doing exactly that. The removal confirm was
  // written off the stale text and inherited the error, so a user was told a phone
  // kept access and then told it had been cut off, in one flow (TCL, 2026-07-30).
  //
  // So this now pins what it DOES, and actively forbids the stale claim. Comments
  // are where the next person forms their mental model; a test that freezes an
  // out-of-date one is worse than no test.
  const raw = read('src/listMethods.js')
  assert.doesNotMatch(raw, /blocks its writer/, 'that claim was false')
  assert.doesNotMatch(raw, /There is no removeWriter in device-link/, 'no longer true as of device-link PR #6')
  assert.doesNotMatch(raw, /it does NOT touch the SHARED SPACES/i, 'it does touch them - revokeDeviceFromSpaces')
  assert.match(raw, /revoke the device's writer key on the PERSONAL base/i, 'say what it does')
  assert.match(raw, /revoke it in each SHARED SPACE that is armed/i, 'and that it reaches shared spaces')
  assert.match(raw, /does NOT stop the device READING/i, 'and what it still does not')
})

test('the preview and the removal share one predicate, so they cannot drift', () => {
  // The regression this exists for: the confirm promised the phone was NOT locked
  // out of shared lists, seconds before the app said it had been. The fix was to
  // ask the worklet - which only helps if the preview runs the SAME test the
  // removal runs.
  const raw = read('src/listMethods.js')
  assert.match(raw, /async function spaceRevokeBlocker /, 'the predicate is its own function')
  const calls = raw.match(/await spaceRevokeBlocker\(/g) || []
  assert.equal(calls.length, 2, 'called by BOTH the preview and the removal, so they cannot drift')
})

test('the device removal path does not use alert() - "JavaScript"-titled dialogs', () => {
  // An Android WebView titles alert() "JavaScript". LinkDeviceSheet was moved off it
  // on 2026-07-29; removeDevice was missed and shipped that dialog as the LAST thing
  // a person sees after cutting off a lost phone (TCL, 2026-07-30).
  const src = app()
  const start = src.indexOf('async function removeDevice')
  assert.ok(start > 0, 'found removeDevice')
  const body = src.slice(start, src.indexOf('\n  const fileRef', start))
  assert.ok(body.length > 200, 'sliced a real function body')
  assert.doesNotMatch(body, /[^.\w]alert\(/, 'every outcome goes through notify()')
  assert.match(body, /await notify\(/, 'and it is awaited, so the messages queue rather than stack')
  // notify must be an acknowledgement, not a question with a pointless Cancel.
  assert.match(src, /function notify \(title, message\)[\s\S]{0,400}noCancel: true/, 'notify uses the noCancel acknowledgement')
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
