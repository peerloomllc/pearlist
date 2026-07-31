// BEING IN NO SPACE IS NOT THE SAME AS BEING NEW.
//
// Tim, 2026-07-31, after deleting every space to test something else: "when I deleted
// all spaces it takes you back to the main page asking you to create or join a space
// ... it's stuck on the page until it joins or creates a space. Seems like a UX/UI
// gap. We probably shouldn't force that full-screen page on users."
//
// He was right, and the reason is that "spaces.length === 0" was being read as "first
// run". It is also what a phone looks like the moment before it joins its first space
// on day 400 - and that phone got its Settings, its About page and its whole navbar
// taken away, with the only ways out being the two things it was refusing to do.
//
// SOURCE-SHAPE PINS, and pinned as PROPERTIES rather than formatting. Four
// over-specific pins in this repo have already broken on legitimate edits (see
// test/linkShape.test.js), so each assertion below names a behaviour that would be a
// bug to lose, never a spelling that happens to be current.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

test('no code path drops a user onto the full-screen door unconditionally', () => {
  const src = app()
  // THE WHOLE BUG IN ONE ASSERTION. Four separate places used to react to "no spaces
  // left" with a bare setPhase('onboarding'): first load, the owner deleting a space,
  // leaving a space, and a space being deleted out from under you. Every one of them
  // now has to ask whether this phone has ever finished first run.
  const bare = src.match(/setPhase\('onboarding'\)/g) || []
  assert.equal(bare.length, 0,
    'a zero-space transition must consult hasFinishedFirstRun, not assume a new user')
  assert.match(src, /hasFinishedFirstRun\(\) \? 'home' : 'onboarding'/,
    'the door is for a phone that has never been through it')
})

test('first run is decided by a durable flag, and defaults to showing the door', () => {
  const src = app()
  const start = src.indexOf('function hasFinishedFirstRun')
  assert.ok(start > 0, 'the first-run question has one answer, in one place')
  const body = src.slice(start, src.indexOf('\n}', start))

  // It reads the tour key, which is written once and never cleared - replaying the
  // tour from Settings must not turn a long-time user back into a new one.
  assert.match(body, /TOUR_KEY/, 'the durable flag is the tour key')
  // AND IT FAILS TOWARDS THE DOOR. If storage throws we cannot tell a new phone from
  // an old one, and showing onboarding to a returning user is a papercut while
  // dropping a genuinely new user into an empty app with no explanation is a dead end.
  assert.match(body, /catch \{ return false \}/, 'an unreadable flag means "treat as new"')
})

test('the no-space screen keeps the app around it', () => {
  const src = app()
  // It is a branch INSIDE the lists view, not an early return, which is what keeps the
  // TabBar underneath it - the entire point of the change. An early return would put
  // the user right back where they were: no Settings, no About, no way out.
  const tab = src.indexOf('<TabBar active=')
  const empty = src.indexOf('You are not in a space yet')
  assert.ok(empty > 0, 'the empty state exists')
  assert.ok(tab > empty, 'the TabBar still renders after the no-space branch')

  // Both doors are on it, or it is the same dead end with a different layout.
  const branch = src.slice(empty, empty + 1200)
  assert.match(branch, /Create a space/)
  assert.match(branch, /Join a space/)
})

test('the no-space screen offers nothing that needs a space', () => {
  const src = app()
  const empty = src.indexOf('You are not in a space yet')
  const branch = src.slice(src.lastIndexOf('!activeSpace ? (', empty), empty + 1200)
  // A composer that cannot add a list, a members bar with no members and an invite
  // button with nothing to invite to are all worse than absent: each one is a control
  // that reports a failure the user cannot act on.
  for (const dead of ['ComposerBar', 'MembersBar', "setSheet('invite')"]) {
    assert.ok(!branch.includes(dead), `${dead} must not appear on the no-space screen`)
  }
})
