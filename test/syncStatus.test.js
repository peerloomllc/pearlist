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
