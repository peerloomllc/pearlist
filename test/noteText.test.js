const test = require('node:test')
const assert = require('node:assert/strict')
const { ordBetween, sortNoteRows, splitLines, joinLines, noteTextOf, planNoteSave, MID, MAX_LINES, MAX_LINE_CHARS } = require('../src/noteText')

// --- fractional index -------------------------------------------------------

test('ordBetween lands strictly between its neighbours', () => {
  const a = ordBetween('', null)
  const b = ordBetween(a, null)
  assert.ok(a < b)
  const mid = ordBetween(a, b)
  assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`)
})

test('ordBetween survives repeated insertion at the same spot', () => {
  // The pathological case for any fixed-width scheme: always insert between the
  // same two lines. The strings get longer, but must never collide or reorder.
  let lo = ordBetween('', null)
  const hi = ordBetween(lo, null)
  const seen = new Set([lo, hi])
  for (let i = 0; i < 200; i++) {
    const next = ordBetween(lo, hi)
    assert.ok(lo < next && next < hi, `iteration ${i}: ${lo} < ${next} < ${hi}`)
    assert.ok(!seen.has(next), `iteration ${i} produced a duplicate ord ${next}`)
    seen.add(next)
    lo = next
  }
})

test('ordBetween prepends before the first line', () => {
  const first = ordBetween('', null)
  const before = ordBetween('', first)
  assert.ok(before < first)
})

test('ordBetween never ends in the zero digit', () => {
  // The invariant midpoint() both relies on and preserves: an ord ending in '0'
  // leaves no room below it.
  let prev = ''
  for (let i = 0; i < 100; i++) {
    const a = ordBetween(prev, null)
    assert.notEqual(a.slice(-1), '0', `append produced ${a}`)
    const b = ordBetween(prev, a)
    assert.notEqual(b.slice(-1), '0', `insert produced ${b}`)
    prev = a
  }
})

test('ordBetween falls back safely on out-of-order or corrupt neighbours', () => {
  // Must not throw, and must still be greater than the lower bound.
  assert.equal(ordBetween('Z', 'A'), 'Z' + MID)
  assert.equal(ordBetween('Z', 'Z'), 'Z' + MID)
  assert.ok(ordBetween(null, undefined).length > 0)
})

// --- ordering ---------------------------------------------------------------

test('sortNoteRows orders by ord, then createdAt, then id', () => {
  const rows = [
    { id: 'c', ord: 'V', createdAt: 3 },
    { id: 'a', ord: 'F', createdAt: 1 },
    { id: 'b', ord: 'K', createdAt: 2 },
  ]
  assert.deepEqual(sortNoteRows(rows).map((r) => r.id), ['a', 'b', 'c'])
})

test('rows without an ord sort after rows with one', () => {
  // An old peer, or the generic list UI, can add an item with no ord. It has to
  // land somewhere defined rather than interleaving unpredictably.
  const rows = [
    { id: 'legacy', createdAt: 1 },
    { id: 'placed', ord: 'V', createdAt: 2 },
  ]
  assert.deepEqual(sortNoteRows(rows).map((r) => r.id), ['placed', 'legacy'])
})

test('equal ords break the tie deterministically, so peers converge', () => {
  // Two peers inserting at the same spot compute the SAME midpoint.
  const a = [{ id: 'x', ord: 'V', createdAt: 5 }, { id: 'y', ord: 'V', createdAt: 5 }]
  const b = [{ id: 'y', ord: 'V', createdAt: 5 }, { id: 'x', ord: 'V', createdAt: 5 }]
  assert.deepEqual(sortNoteRows(a).map((r) => r.id), sortNoteRows(b).map((r) => r.id))
})

// --- text <-> lines ---------------------------------------------------------

test('splitLines and joinLines round-trip, including blank lines', () => {
  for (const text of ['', 'one', 'a\nb', 'a\n\nb', 'trailing\n', '\nleading', 'a\n\n\nb']) {
    assert.equal(joinLines(splitLines(text)), text, JSON.stringify(text))
  }
})

test('an empty note is zero lines, not one blank line', () => {
  assert.deepEqual(splitLines(''), [])
})

test('noteTextOf renders rows in ord order', () => {
  const rows = [
    { id: 'b', text: 'world', ord: 'V' },
    { id: 'a', text: 'hello', ord: 'F' },
  ]
  assert.equal(noteTextOf(rows), 'hello\nworld')
})

// --- planNoteSave -----------------------------------------------------------

// Build a row set from [text, ord] pairs.
function rows (pairs) {
  return pairs.map(([id, text, ord]) => ({ id, text, ord, createdAt: 1, deleted: false }))
}
const baselineOf = (rs) => rs.map((r) => ({ id: r.id, text: r.text }))

test('an unchanged note plans nothing', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'two'], rs)
  assert.deepEqual(plan, { updates: [], deletes: [], inserts: [] })
})

test('editing a line updates its row rather than replacing it', () => {
  // The row must survive the edit, keeping its identity and its ord.
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'two!'], rs)
  assert.deepEqual(plan.updates, [{ id: 'b', text: 'two!' }])
  assert.deepEqual(plan.deletes, [])
  assert.deepEqual(plan.inserts, [])
})

test('appending a line inserts after the last ord', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'two', 'three'], rs)
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].text, 'three')
  assert.ok(plan.inserts[0].ord > 'V')
})

test('inserting in the middle lands between its neighbours', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'three', 'V']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'two', 'three'], rs)
  assert.equal(plan.inserts.length, 1)
  assert.ok(plan.inserts[0].ord > 'F' && plan.inserts[0].ord < 'V')
})

test('consecutive inserts keep their typed order', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'four', 'V']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'two', 'three', 'four'], rs)
  assert.deepEqual(plan.inserts.map((i) => i.text), ['two', 'three'])
  assert.ok(plan.inserts[0].ord < plan.inserts[1].ord)
  assert.ok(plan.inserts[0].ord > 'F' && plan.inserts[1].ord < 'V')
})

test('deleting a line tombstones exactly that row', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V'], ['c', 'three', 'k']])
  const plan = planNoteSave(baselineOf(rs), ['one', 'three'], rs)
  assert.deepEqual(plan.deletes, ['b'])
  assert.deepEqual(plan.updates, [])
  assert.deepEqual(plan.inserts, [])
})

test('clearing the note deletes every row', () => {
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const plan = planNoteSave(baselineOf(rs), [], rs)
  assert.deepEqual(plan.deletes.sort(), ['a', 'b'])
})

test('a first line in an empty note gets an ord', () => {
  const plan = planNoteSave([], ['hello'], [])
  assert.equal(plan.inserts.length, 1)
  assert.ok(plan.inserts[0].ord.length > 0)
})

// --- the three-way merge: the whole reason this is a diff --------------------

test("my save does not tombstone a line a peer added while I typed", () => {
  // I loaded two lines. A peer appended a third. I then edited my line 2.
  // My plan must not mention the peer's line at all.
  const loaded = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const now = rows([['a', 'one', 'F'], ['b', 'two', 'V'], ['peer', 'theirs', 'k']])
  const plan = planNoteSave(baselineOf(loaded), ['one', 'two!'], now)
  assert.deepEqual(plan.updates, [{ id: 'b', text: 'two!' }])
  assert.deepEqual(plan.deletes, [])
  assert.deepEqual(plan.inserts, [])
})

test('two peers editing different lines both survive', () => {
  // Sequential application of two saves derived from the SAME baseline, which is
  // what actually happens when both editors were open at once.
  const start = rows([['a', 'one', 'F'], ['b', 'two', 'V'], ['c', 'three', 'k']])
  const base = baselineOf(start)

  const mine = planNoteSave(base, ['ONE', 'two', 'three'], start)
  assert.deepEqual(mine.updates, [{ id: 'a', text: 'ONE' }])
  const afterMine = start.map((r) => (r.id === 'a' ? { ...r, text: 'ONE' } : r))

  const theirs = planNoteSave(base, ['one', 'two', 'THREE'], afterMine)
  assert.deepEqual(theirs.updates, [{ id: 'c', text: 'THREE' }])
  assert.deepEqual(theirs.deletes, [])
  assert.deepEqual(theirs.inserts, [])

  // Neither edit reverted the other.
  const final = afterMine.map((r) => (r.id === 'c' ? { ...r, text: 'THREE' } : r))
  assert.equal(noteTextOf(final), 'ONE\ntwo\nTHREE')
})

test('an update whose row a peer already deleted is dropped', () => {
  // No-resurrection would reject the write anyway; not emitting it keeps the
  // op log clean.
  const loaded = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const now = rows([['a', 'one', 'F']])
  const plan = planNoteSave(baselineOf(loaded), ['one', 'two!'], now)
  assert.deepEqual(plan.updates, [])
  assert.deepEqual(plan.deletes, [])
})

test('an edit a peer already made is not rewritten', () => {
  const loaded = rows([['a', 'one', 'F']])
  const now = rows([['a', 'same', 'F']])
  const plan = planNoteSave(baselineOf(loaded), ['same'], now)
  assert.deepEqual(plan.updates, [])
})

test('a delete of a row a peer already deleted is dropped', () => {
  const loaded = rows([['a', 'one', 'F'], ['b', 'two', 'V']])
  const now = rows([['a', 'one', 'F']])
  const plan = planNoteSave(baselineOf(loaded), ['one'], now)
  assert.deepEqual(plan.deletes, [])
})

test('inserting next to a line a peer deleted still gets a sane ord', () => {
  // The anchor is gone, so it falls back to the nearest surviving neighbour.
  const loaded = rows([['a', 'one', 'F'], ['b', 'two', 'V'], ['c', 'three', 'k']])
  const now = rows([['a', 'one', 'F'], ['c', 'three', 'k']])
  const plan = planNoteSave(baselineOf(loaded), ['one', 'two', 'new', 'three'], now)
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].text, 'new')
  assert.ok(plan.inserts[0].ord > 'F' && plan.inserts[0].ord < 'k')
})

test('a line with no ord does not anchor an insert', () => {
  // A legacy row (added by an old peer) sorts last, so using it as a lower bound
  // would push new lines past everything.
  const loaded = rows([['a', 'one', 'F']]).concat([{ id: 'legacy', text: 'old', createdAt: 2 }])
  const plan = planNoteSave(baselineOf(loaded), ['one', 'old', 'new'], loaded)
  assert.equal(plan.inserts.length, 1)
  assert.ok(plan.inserts[0].ord > 'F')
})

test('a baseline handed over out of document order is re-derived, not trusted', () => {
  // item:getAll returns rows in Hyperbee key order. A caller passing that
  // straight through would otherwise make the diff delete and re-insert the
  // whole note - silently, and losing every line's identity and ord.
  const rs = rows([['a', 'one', 'F'], ['b', 'two', 'V'], ['c', 'three', 'k']])
  const scrambled = [{ id: 'c', text: 'three' }, { id: 'a', text: 'one' }, { id: 'b', text: 'two' }]
  const plan = planNoteSave(scrambled, ['one', 'two', 'THREE'], rs)
  assert.deepEqual(plan.updates, [{ id: 'c', text: 'THREE' }])
  assert.deepEqual(plan.deletes, [])
  assert.deepEqual(plan.inserts, [])
})

// --- bounds -----------------------------------------------------------------

test('a huge paste is clamped rather than becoming thousands of rows', () => {
  const plan = planNoteSave([], new Array(MAX_LINES + 500).fill('x'), [])
  assert.equal(plan.inserts.length, MAX_LINES)
})

test('an over-long line is truncated', () => {
  const plan = planNoteSave([], ['y'.repeat(MAX_LINE_CHARS + 100)], [])
  assert.equal(plan.inserts[0].text.length, MAX_LINE_CHARS)
})

test('a note larger than the LCS cap still plans a correct result', () => {
  // Past the cap there is no LCS, so every line is a change block paired
  // positionally. The resulting note must still read back correctly.
  const big = new Array(600).fill(0).map((_, i) => ['id' + i, 'line ' + i, undefined])
  const rs = big.map(([id, text], i) => ({ id, text, ord: undefined, createdAt: i }))
  const next = rs.map((r) => r.text)
  next[300] = 'changed'
  const plan = planNoteSave(baselineOf(rs), next, rs)
  assert.ok(plan.updates.some((u) => u.text === 'changed'))
  assert.equal(plan.deletes.length, 0)
  assert.equal(plan.inserts.length, 0)
})
