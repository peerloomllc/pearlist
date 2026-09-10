// The rule behind the "why is this space empty" banner. The interesting part is
// not that it warns, it is everything it must STAY QUIET about: a working space
// with nobody else online is the normal case in a household, and warning there
// would put a permanent complaint on an app that is fine.

const test = require('node:test')
const assert = require('node:assert/strict')

const { syncTrouble } = require('../src/syncStatus')

const status = (over = {}) => ({ writable: true, conns: 0, members: 0, lists: 0, ...over })

test('silent before the first status read', () => {
  assert.equal(syncTrouble(null), null)
  assert.equal(syncTrouble(undefined), null)
})

test('silent on a writable space, connected or not', () => {
  // The offline case is the one that matters: adding groceries while the other
  // phone is asleep is normal use, not a fault.
  assert.equal(syncTrouble(status({ writable: true, conns: 0 })), null)
  assert.equal(syncTrouble(status({ writable: true, conns: 3 })), null)
})

test('silent on a brand new empty space we founded', () => {
  // A founder is writable immediately, so an empty space of their own says nothing.
  assert.equal(syncTrouble(status({ writable: true, members: 0, lists: 0 })), null)
})

test('not writable and nothing has arrived: go get the other phone', () => {
  const t = syncTrouble(status({ writable: false, members: 0, lists: 0 }))
  assert.ok(t, 'expected a warning')
  assert.equal(t.title, 'Not connected yet')
  assert.match(t.body, /open pearlist on another member/i)
})

test('not writable but the space is arriving: wait for the approval', () => {
  assert.equal(syncTrouble(status({ writable: false, members: 2, lists: 0 })).title, 'Waiting to be let in')
  assert.equal(syncTrouble(status({ writable: false, members: 0, lists: 3 })).title, 'Waiting to be let in')
})

test('a swarm connection alone does NOT count as the space arriving', () => {
  // The bug this rule replaced: `conns` is swarm-wide, so a peer from a DIFFERENT
  // space made a stalled space claim an approval was in flight. Measured on the
  // TCL 2026-07-28 with a fabricated invite to a space nobody hosts.
  const t = syncTrouble(status({ writable: false, conns: 4, members: 0, lists: 0 }))
  assert.equal(t.title, 'Not connected yet')
})

test('the two cases are distinguishable, not the same warning twice', () => {
  const alone = syncTrouble(status({ writable: false, members: 0, lists: 0 }))
  const paired = syncTrouble(status({ writable: false, members: 2, lists: 1 }))
  assert.notEqual(alone.title, paired.title)
  assert.notEqual(alone.body, paired.body)
})

test('copy is plain language: no jargon leaks to the user', () => {
  // The whole point is that a household member can act on it. "writer",
  // "Autobase", "peer" and "swarm" are ours, not theirs.
  for (const s of [status({ writable: false, members: 0 }), status({ writable: false, members: 2 })]) {
    const t = syncTrouble(s)
    const text = t.title + ' ' + t.body
    assert.doesNotMatch(text, /writer|autobase|swarm|peer|pubkey|replicat/i, 'jargon in: ' + text)
  }
})

// --- the fourth state: the base never opened (2026-09-10) -------------------
// proposals/2026-09-10-repairing-a-space-1.0.9-broke.md. The three states above
// all describe a space that IS open and empty, and all three are fixed by waiting
// or by waking another phone. This one is fixed by neither.

test('an unavailable space gets its own copy, not the waiting copy', () => {
  const t = syncTrouble({ available: false, writable: false, members: 0, lists: 0 })
  assert.ok(t, 'it must say something: this is the one case waiting cannot fix')
  const waiting = syncTrouble(status({ writable: false, members: 0, lists: 0 }))
  assert.notEqual(t.title, waiting.title)
  assert.notEqual(t.body, waiting.body)
})

test('the free retry is offered FIRST, and the destructive rebuild only after it', () => {
  // A 15s mount timeout is not proof of damage. Offering a rebuild up front would
  // throw away a good local writer on a phone that was merely slow.
  assert.equal(syncTrouble({ available: false }).action.kind, 'retry')
  assert.equal(syncTrouble({ available: false }, true).action.kind, 'rebuild')
})

test('the rebuild copy says what it costs before the user taps it', () => {
  const t = syncTrouble({ available: false }, true)
  assert.match(t.body, /another phone/i, 'it needs one, and says so')
  assert.match(t.body, /will not come back/i, 'and names what is lost')
})

test('the rebuild copy tells them to OPEN PEARLIST on the other phone, first', () => {
  // Asked for by Tim 2026-09-10 on reading the first draft, which had the
  // instruction buried mid-paragraph. The rebuild copies the lists back from the
  // other phone, so a phone that is merely powered on and not running PearList
  // gives a failed rebuild - and the person has spent their one obvious remedy.
  const t = syncTrouble({ available: false }, true)
  assert.match(t.body, /open PearList/i, 'it names the app, not just the phone')
  assert.match(t.body, /leave it on screen|keep it open/i, 'and says to leave it there')
  // First sentence, not buried: the instruction has to land before the caveats.
  const first = t.body.split('.')[0] + '.'
  assert.match(first, /another phone/i, 'the very first sentence is the instruction')
  assert.doesNotMatch(first, /will not come back/i, 'and not the warning')
})

test('the retry copy does NOT frighten anyone: nothing is lost by trying', () => {
  const t = syncTrouble({ available: false })
  assert.match(t.body, /Nothing has been deleted/i)
  assert.doesNotMatch(t.body, /will not come back/i, 'that warning belongs to the rebuild, not the retry')
})

test('a status without `available` behaves exactly as it did before', () => {
  // Every existing caller and every older worklet reply omits the field.
  assert.equal(syncTrouble({ writable: true }), null)
  assert.equal(syncTrouble(status({ writable: false, members: 2, lists: 1 })).title, 'Waiting to be let in')
})

test('the new copy is plain language too', () => {
  for (const t of [syncTrouble({ available: false }), syncTrouble({ available: false }, true)]) {
    const text = t.title + ' ' + t.body + ' ' + t.action.label
    assert.doesNotMatch(text, /writer|autobase|swarm|peer|pubkey|replicat|namespace|core\b|mount/i, 'jargon in: ' + text)
  }
})
