// A PHONE THAT JUST GAINED OWNERSHIP HAS TO NOTICE.
//
// Watched on the clean rig 2026-07-31. The Pixel linked to the TCL, joined "Home",
// and offered "Leave Home" - i.e. spaces:list.owner false - through a roster refresh
// on the TCL and a re-open of its own sheet. Force-stop and relaunch, and it read
// "Delete Home". The ownership was real the whole time; the screen was stale.
//
// `spaces[].owner` is what swaps trash for leave and gates Remove / Add back, and it
// is only ever written by loadSpaces(), which nothing re-runs when a space ARMS or
// when a pairing completes.
//
// IT MATTERS MORE SINCE PR #170. Arming used to follow a tap, so the user was looking
// at the screen when ownership arrived. It happens by itself now and nothing moves, so
// the symptom - "my other phone still has no buttons" - is indistinguishable from the
// #162/#170 work not having shipped. It nearly got reported that way.
//
// SOURCE-SHAPE PINS, as PROPERTIES not spellings, per the convention in
// test/noSpaceState.test.js. Over-specific pins in this repo have broken on legitimate
// edits before, so each assertion below names something that would be a BUG to lose.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

// The whole fix rests on comparing two answers to the same question. revoke:status
// returns `isOwner` from canActAsOwner, which is the SAME predicate spaces:list uses
// for `owner`, so a disagreement between them is precisely "the list is stale".
test('the roster refresh compares revoke:status.isOwner against the cached owner flag', () => {
  const src = app()
  const at = src.indexOf("call('space:revocationStatus'")
  assert.ok(at > 0, 'the roster refresh still asks for revocation status')
  const near = src.slice(at, at + 900)

  assert.match(near, /isOwner/, 'and reads the ownership answer out of it')
  assert.match(near, /\.owner/, 'compares it against the cached spaces row')
  assert.match(near, /loadSpaces\(\)/, 'and re-reads the spaces list when they disagree')
})

// Without this the comparison reads whatever the list was on FIRST RENDER, which is
// exactly the stale value we are trying to detect - the fix would then never fire.
// loadMembers is deliberately a no-dependency callback (it is called from effects and
// handlers throughout), so it cannot close over `spaces` state directly.
test('the cached flag is read through a ref, not through closed-over state', () => {
  const src = app()
  assert.match(src, /spacesRef/, 'a ref mirrors the spaces list')

  const lsAt = src.indexOf('const loadSpaces = useCallback')
  assert.ok(lsAt > 0, 'loadSpaces still exists')
  const body = src.slice(lsAt, lsAt + 400)
  assert.match(body, /spacesRef\.current\s*=/, 'and loadSpaces keeps it up to date')

  const at = src.indexOf("call('space:revocationStatus'")
  assert.match(src.slice(at, at + 900), /spacesRef\.current/,
    'so the comparison sees the CURRENT list rather than a first-render snapshot')
})

// React may invoke a state updater more than once (StrictMode does it deliberately),
// so an updater that fires a refetch can fire it twice - and worse, it hides a network
// call somewhere nobody looks for one. The first cut of this fix did exactly that.
//
// PASSES WITH OR WITHOUT THE FIX, and says so rather than posing as coverage: the code
// before this change had no updater there either. It is a REGRESSION GUARD against the
// shortcut I actually reached for first, kept because the next person needing the
// current spaces list inside a no-dependency callback will reach for the same one.
test('the re-read is not smuggled inside a setSpaces updater', () => {
  const src = app()
  const at = src.indexOf("call('space:revocationStatus'")
  const near = src.slice(at, at + 900)
  const updater = near.indexOf('setSpaces((')
  assert.equal(updater, -1,
    'no state updater in the refresh path, so the refetch cannot run twice or hide')
})

// The point of comparing rather than always refetching. spaces:list walks EVERY space
// and calls base.update() on each, and loadMembers runs on every roster tick, so an
// unconditional re-read would put that walk on a hot path.
test('the spaces list is re-read only on a genuine disagreement', () => {
  const src = app()
  const at = src.indexOf("call('space:revocationStatus'")
  const near = src.slice(at, at + 900)
  const call = near.indexOf('loadSpaces()')
  assert.ok(call > 0, 'it does re-read')
  const before = near.slice(0, call)
  assert.match(before, /if\s*\(/, 'but only inside a condition, never unconditionally')
})
