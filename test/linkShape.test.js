// Pins the pairing-link shape check and the linking UI's structure.
//
// The behavioural half (isPairLink / isInviteLink / pairLinkProblem) is a real
// unit test. The structural half reads App.jsx as source, the same way
// appVersion.test.js does, because the UI bundle is built AFTER the tests run and
// so cannot be inspected from here.
//
// Both halves exist because this code failed silently once already: the Link
// entry point shipped as a bare window.prompt() and nothing caught it - it built,
// it ran, and it took driving the flow on a phone to notice the dialog was titled
// "JavaScript" (2026-07-29).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { isPairLink, isInviteLink, pairLinkProblem } = require('../src/linkShape.js')

const root = path.resolve(__dirname, '..')
const app = () => fs.readFileSync(path.join(root, 'src/ui/App.jsx'), 'utf8')

// Comments discuss the very things these tests forbid - the prompt() check would
// otherwise trip on the comment explaining why prompt() was removed. Strip only
// WHOLE-LINE `//` comments, which is where all the prose lives.
//
// Deliberately does NOT strip /* */ blocks. Trying that swallowed 600 lines,
// because `accept='image/*'` is a string that opens a block as far as a regex is
// concerned and the next `*/` is hundreds of lines later. A crude stripper that
// silently eats half the file is worse than none: the assertions still passed,
// they were just no longer looking at anything.
const code = () => app().replace(/^\s*\/\/.*$/gm, '')

const PAIR = 'pear://pearlist-device?topic=abc123&handshake=def456'
const INVITE = 'https://peerloomllc.com/pearlist/join#eyJncm91cElkIjoieCJ9'
const INVITE_SCHEME = 'pear://pearlist/join#eyJncm91cElkIjoieCJ9'

test('a pairing link is recognised, with whitespace and odd casing', () => {
  assert.equal(isPairLink(PAIR), true)
  assert.equal(isPairLink('   ' + PAIR + '  \n'), true)
  assert.equal(isPairLink('PEAR://PEARLIST-DEVICE?topic=abc'), true)
})

// The whole point of the check: the two link types must not be confused, and
// `pearlist-device` must not match as a prefix of `pearlist`, nor the reverse.
test('a space invite is NOT a pairing link, in either form', () => {
  assert.equal(isPairLink(INVITE), false)
  assert.equal(isPairLink(INVITE_SCHEME), false)
  assert.equal(isInviteLink(INVITE), true)
  assert.equal(isInviteLink(INVITE_SCHEME), true)
})

test('a pairing link is not mistaken for an invite', () => {
  assert.equal(isInviteLink(PAIR), false)
})

test('junk and empty input are rejected without throwing', () => {
  for (const bad of ['', '   ', null, undefined, 'hello', 'https://example.com', 42, {}]) {
    assert.equal(isPairLink(bad), false)
    assert.equal(isInviteLink(bad), false)
  }
})

// A user who pastes the wrong link should be told WHICH mistake they made -
// "wrong link entirely" and "right idea, wrong link" have different fixes.
test('the error message distinguishes an invite from junk', () => {
  assert.equal(pairLinkProblem(PAIR), null)
  assert.match(pairLinkProblem(INVITE), /space invite/)
  assert.match(pairLinkProblem(INVITE), /tap Pair/)
  assert.match(pairLinkProblem('hello'), /does not look like a pairing link/)
  assert.doesNotMatch(pairLinkProblem('hello'), /space invite/)
})

test('the linking UI does not use a raw prompt()', () => {
  const src = code()
  // window.prompt renders as a system dialog titled "JavaScript" in an Android
  // WebView. On a screen that asks the user to paste something which hands over
  // their identity, that is indistinguishable from a phishing page.
  assert.doesNotMatch(src, /\bprompt\s*\(/, 'App.jsx must not call prompt()')
  assert.match(src, /function LinkDeviceSheet/, 'the Link screen should be a real component')
})

// alert() gets the SAME "JavaScript" title as prompt(). Fixing the input and
// leaving the error path is exactly the mistake that was made here first time
// round: the sheet looked right until a bad paste put a system dialog back on
// screen. Scoped to LinkDeviceSheet because the rest of the app still uses
// alert() and changing all of it is a separate job.
test('the Link sheet reports errors inline, not through alert()', () => {
  const src = code()
  const start = src.indexOf('function LinkDeviceSheet')
  assert.ok(start > 0, 'LinkDeviceSheet should exist')
  const body = src.slice(start, src.indexOf('\nfunction ', start + 1))
  assert.doesNotMatch(body, /\balert\s*\(/, 'LinkDeviceSheet must not call alert()')
  assert.match(body, /setError\(/, 'it should hold the failure in state')
  assert.match(body, /role='alert'/, 'and render it where the user is looking')
})

test('onboarding offers the link door only when device-link is enabled', () => {
  const src = app()
  // The flag is read once at boot and passed down; a build with device-link off
  // must show the same three doors it always did, not a fourth that goes nowhere.
  assert.match(src, /call\('device:status'[^)]*\)[^\n]*setDeviceLinkOn/, 'boot should read device:status into state')
  assert.match(src, /onLink=\{deviceLinkOn \? \(\) => setSheet\('link'\) : null\}/, 'the onboarding door must be gated on the flag')
  assert.match(src, /\{onLink \? <Button[^>]*onClick=\{onLink\}/, 'Onboarding must not render the button when onLink is absent')
})

test('both entry points go through the same link handler', () => {
  const src = code()
  // Onboarding and Settings must not grow separate implementations: only the app
  // level knows whether to navigate afterwards, and only Settings knows to
  // refresh its roster.
  assert.match(src, /onLinkDevice=\{linkThisDevice\}/, 'Settings should receive the app-level handler')
  assert.match(src, /await onLinkDevice\(url\)/, 'Settings should delegate rather than call the IPC itself')
  const consumeCalls = src.match(/device:consumePairLink/g) || []
  assert.equal(consumeCalls.length, 1, 'consumePairLink should be called from exactly one place')
})

test('linking navigates only when the user is NOWHERE', () => {
  const src = app()
  // From Settings the user is already somewhere they chose to be; yanking them
  // into a space would be the app losing their place.
  //
  // REPINNED 2026-07-31 to the property rather than the formatting. This used to
  // match `if (first && phase === 'onboarding')` literally and broke the moment
  // "in no space" stopped meaning "on the onboarding door" - a legitimate edit, and
  // the fourth over-specific source pin in this repo to fail that way. What matters
  // is that the navigation is CONDITIONAL and that the condition is "the user is not
  // anywhere yet", however that comes to be spelled.
  const start = src.indexOf('Linked. This phone now shares your spaces.')
  assert.ok(start > 0, 'the link handler still exists')
  const handler = src.slice(src.lastIndexOf('async function', start), start)
  const line = handler.split('\n').find((l) => l.includes('setActiveSpaceId(first.groupId)'))
  assert.ok(line, 'linking still lands the user in the first space')
  assert.match(line, /if \(first &&/, 'navigation must be conditional, never unconditional')
  assert.match(line, /phase === 'onboarding'/, 'a user who is already somewhere is left there')
  assert.match(line, /!activeSpaceId/, 'and a returning phone in no space is landed too')
})

// A pairing that never finishes blocks every LATER one, because device-link keeps
// the session in worklet memory and rejects a second consume while it is set. The
// only escape used to be force-quitting the app, which is not a recovery a user
// should have to discover. Tim hit exactly this.
//
// Pinned as PROPERTIES, not as one formatting - four over-specific source pins
// have already broken on legitimate edits in this repo.
test('a half-open pair session offers a way out instead of a dead end', () => {
  const src = app()
  const start = src.indexOf('function LinkDeviceSheet')
  const body = src.slice(start, src.indexOf('\nfunction ', start + 1))

  // The sheet must be able to CLEAR the stuck session, not merely describe it.
  assert.match(body, /device:cancelPairing/, 'it should cancel the half-open session')
  // ...and retry afterwards, or cancelling just leaves the user where they were.
  assert.match(body, /startOver/, 'and retry the link once it is cancelled')
  // The retry must use the value that was ATTEMPTED. A scanned link never reaches
  // the text field, so retrying `url` would silently retry nothing.
  assert.match(body, /setTried\(/, 'it should remember what was tried, not read the field')
})

test('the failure that can be recovered from is distinguished from the ones that cannot', () => {
  const src = app()
  // linkThisDevice owns the wording - it is the only thing that knows which
  // failure occurred - and flags the recoverable one for the sheet.
  assert.match(src, /canStartOver/, 'the in-progress failure is marked as recoverable')
  assert.match(src, /another pair session in progress/i, 'matched on the error device-link actually throws')
})
