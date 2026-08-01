// YOUR SPACES FOLLOW YOU TO YOUR OTHER PHONE.
//
// Tim, 2026-07-31: "I created 'New' space on TCL, but it doesn't automatically show up
// on the iPhone. I have to send an invite to the iPhone." Which is absurd once the app
// has told you the two phones are the same person.
//
// The mechanism was never missing. collectGroups/seedGroups already carried a person's
// spaces across, but from `handleHello`/`handleGranted` - i.e. INSIDE the pairing
// handshake - so it fired exactly once, at link time. A space made afterwards was
// never going to arrive. Moving it onto a replicated record is
// proposals/2026-07-31-your-spaces-follow-you.md.
//
// WHAT IS TESTED WHERE. The replication itself is proven end to end over a testnet in
// peerloom-device-link/test/records-after-pairing.integration.js - a record put after
// pairing arrives, its delete arrives, and both directions work. This file covers the
// half that lives here: the DECISIONS PearList makes when one arrives, and the shape
// of the code that must not regress. Splitting them that way keeps each fast and keeps
// neither pretending to cover the other.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')

test('the space record type is registered, or every write is silently dropped', () => {
  const dl = src('deviceLink.js')
  assert.match(dl, /space:\s*\{\s*validate/, 'the personal base accepts a `space` record')
  // An unregistered type is refused by the writer and dropped by apply, so forgetting
  // this would make the whole feature a silent no-op with no error anywhere.
  assert.match(dl, /function isSpaceRecord/, 'and validates it')
  assert.match(dl, /typeof v\.groupKey === 'string'/,
    'requiring the key you actually need to join, not just an id')
})

test('leaving retracts the record, so it cannot mirror itself back', () => {
  const lm = src('listMethods.js')
  const at = lm.indexOf("'space:leave'")
  assert.ok(at > 0, 'space:leave still exists')
  const body = lm.slice(at, at + 1200)

  // THE FAILURE THIS PREVENTS: a local-only forget leaves the record on the personal
  // base, apply mirrors it back, and the phone rejoins the space it just left. A leave
  // button that undoes itself is worse than no sync at all.
  assert.match(body, /delSpaceRecord/, 'leave deletes the shared record')
  const del = body.indexOf('delSpaceRecord')
  const local = body.indexOf("localDb.del('groups:joined:")
  assert.ok(del < local, 'and does it BEFORE forgetting locally, not after')
})

test('an arriving record is acted on OFF the personal base apply loop', () => {
  const lm = src('listMethods.js')
  const at = lm.indexOf('setSpaceMirror(')
  assert.ok(at > 0, 'the mirror handler exists')
  const body = lm.slice(at, at + 1600)

  // Joining or destroying a space touches a DIFFERENT base than the one whose apply
  // this runs inside. Doing that inline is the "Invalid checkout N for batch" assert -
  // timing dependent, so it passes in a test and fails on a phone. The profile mirror
  // learned this the same way and says so at length; this must not relearn it.
  assert.match(body, /scheduleSpaceWork/, 'the work is deferred, never done inline')
  assert.doesNotMatch(body, /await ctx\.joinGroup/, 'nothing joins from inside apply')
  assert.doesNotMatch(body, /await ctx\.destroyGroup/, 'and nothing destroys from there')
})

test('a space already joined is skipped, in both the put and delete directions', () => {
  const lm = src('listMethods.js')
  const at = lm.indexOf('setSpaceMirror(')
  const body = lm.slice(at, at + 1600)

  // Re-announcing is routine - every announce re-puts every space and a re-pair
  // replays the lot - so joining twice would mount a second base for one space.
  // seedGroups skips the same way for the same reason.
  const joins = body.match(/groups:joined:/g) || []
  assert.ok(joins.length >= 2,
    'both branches check local membership first (join: already in it; leave: already out)')
})

test('the deferred queue does not drop a space when several arrive at once', () => {
  const lm = src('listMethods.js')
  const at = lm.indexOf('function scheduleSpaceWork')
  assert.ok(at > 0, 'the scheduler exists')
  const body = lm.slice(at, at + 1400)

  // schedulePublishMember coalesces on a single flag, which is right for it - every
  // call means "publish the same row". These are DISTINCT spaces, and collapsing them
  // would silently lose one, which is the exact failure this feature exists to fix.
  assert.match(body, /_spaceWork\.push/, 'work is queued')
  assert.match(body, /while \(_spaceWork\.length\)/, 'and drained, rather than coalesced')

  // One bad space must not abort the rest - seedGroups' rule, and for the same reason:
  // four spaces out of five beats none.
  assert.match(body, /catch/, 'a failure on one item is caught')
})

test('the announce covers spaces that predate this feature, in both directions', () => {
  const lm = src('listMethods.js')
  const at = lm.indexOf("'device:announceSpaces'")
  assert.ok(at > 0, 'the announce method exists')
  const body = lm.slice(at, at + 900)
  assert.match(body, /groups:joined:/, 'it walks what this device is actually in')

  // The BACKFILL leg. Pairing seeds the joiner with the primary's spaces, but the
  // joiner's OWN spaces have never been announced - it had no personal base to
  // announce them to until it linked. Without a call after linking, "your spaces
  // follow you" is true one way only, which is the asymmetry we started with.
  const app = src('ui/App.jsx')
  assert.match(app, /device:announceSpaces/, 'the UI announces')
  const link = app.indexOf('announceSpaceWriters()')
  assert.ok(link > 0)
  assert.match(app.slice(link, link + 700), /device:announceSpaces/,
    'including right after linking, which is the backfill')
})

test('the UI reloads when a space arrives on its own', () => {
  const app = src('ui/App.jsx')
  // The worklet mounts the space; nothing else would tell the UI. Without this the
  // space is joined and invisible until the next launch - measured on hardware
  // 2026-07-28, six spaces seeded by pairing and none on screen.
  assert.match(app, /on\('spaces:changed'/, 'the UI listens for it')
  const at = app.indexOf("on('spaces:changed'")
  assert.match(app.slice(at, at + 200), /loadSpaces\(\)/, 'and re-reads the list')
})
