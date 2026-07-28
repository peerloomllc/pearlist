// Backup export / import, the pure half. The interesting cases are all about what
// a file must NOT be able to do: carry a household identity, name an assignee who
// does not exist in the new space, or ask an import to write unbounded rows.

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildBackup, parseBackup, backupFilename, KIND, KIND_LEGACY_SINGLE, VERSION, MAX_ITEMS, MAX_SPACES } = require('../src/spaceBackup')

const row = (over = {}) => ({ text: 'Milk', qty: 1, checked: false, ...over })
const space = (name, lists) => ({ name, lists })
const snapshot = (over = {}) => ({
  exportedAt: 1753700000000,
  spaces: [space('Fresh', [{ name: 'Groceries', kind: 'grocery', items: [row()] }])],
  ...over,
})

test('round trip: what goes out comes back', () => {
  const doc = buildBackup(snapshot())
  const back = parseBackup(JSON.stringify(doc))
  assert.equal(back.spaces.length, 1)
  assert.equal(back.spaces[0].name, 'Fresh')
  assert.equal(back.spaces[0].lists[0].name, 'Groceries')
  assert.equal(back.spaces[0].lists[0].kind, 'grocery')
  assert.deepEqual(back.spaces[0].lists[0].items[0], { text: 'Milk' })
})

test('EVERY space, not just one: that is the whole point of a backup', () => {
  const doc = buildBackup(snapshot({
    spaces: [
      space('Fresh', [{ name: 'Groceries', kind: 'grocery', items: [row()] }]),
      space('family', [{ name: 'Chores', kind: 'chore', items: [row({ text: 'Bins' })] }]),
      space('Cabin', [{ name: 'Packing', kind: null, items: [row({ text: 'Torch' })] }]),
    ],
  }))
  const back = parseBackup(JSON.stringify(doc))
  assert.deepEqual(back.spaces.map((s) => s.name), ['Fresh', 'family', 'Cabin'])
  assert.deepEqual(back.counts, { spaces: 3, lists: 3, items: 3 })
})

test('carries item state a template deliberately drops', () => {
  const doc = buildBackup(snapshot({
    spaces: [space('S', [{ name: 'L', kind: null, items: [row({ checked: true, qty: 3, category: 'Dairy', note: 'the blue one', url: 'https://x.test', ord: 'a1' })] }])],
  }))
  const it = parseBackup(JSON.stringify(doc)).spaces[0].lists[0].items[0]
  assert.equal(it.checked, true)
  assert.equal(it.qty, 3)
  assert.equal(it.category, 'Dairy')
  assert.equal(it.note, 'the blue one')
  assert.equal(it.url, 'https://x.test')
  assert.equal(it.ord, 'a1')
})

test('a recurring chore keeps its cycle: lastDoneAt survives', () => {
  // For a repeating item `checked` is IGNORED - effectiveChecked derives the
  // done-state from lastDoneAt - so dropping this made every chore come back due
  // however recently it was done. Found 2026-07-28.
  const done = 1753700000000
  const doc = buildBackup(snapshot({
    spaces: [space('S', [{ name: 'Chores', kind: 'chore', items: [row({ text: 'Bins', repeat: 'weekly', checked: true, lastDoneAt: done })] }])],
  }))
  const it = parseBackup(JSON.stringify(doc)).spaces[0].lists[0].items[0]
  assert.equal(it.repeat, 'weekly')
  assert.equal(it.lastDoneAt, done)
})

test('lastDoneAt is a record, not a scheduled instant, so it is safe to carry', () => {
  // The distinction that decides what a backup may keep: remindAt would FIRE at an
  // absolute time (so a stale one is noise); lastDoneAt only says when something
  // WAS done, so a stale one simply reads as "that period has passed".
  const doc = buildBackup(snapshot({
    spaces: [space('S', [{ name: 'L', kind: null, items: [row({ repeat: 'daily', lastDoneAt: 1, remindAt: 1753700000000 })] }])],
  }))
  const it = doc.spaces[0].lists[0].items[0]
  assert.equal(it.lastDoneAt, 1)
  assert.equal(it.remindAt, undefined, 'reminders stay out')
})

test('never carries the household: no identity, keys, assignee or reminder', () => {
  const doc = buildBackup(snapshot({
    spaces: [space('S', [{
      name: 'L',
      kind: null,
      items: [row({ assignee: 'deadbeef'.repeat(8), createdBy: 'cafe'.repeat(16), remindAt: 1753700000000, _w: 'ff'.repeat(32), sig: 'nope' })],
    }])],
  }))
  const text = JSON.stringify(doc)
  for (const leak of ['deadbeef', 'cafecafe', 'remindAt', '_w', 'sig']) {
    assert.doesNotMatch(text, new RegExp(leak), 'leaked ' + leak)
  }
  const it = doc.spaces[0].lists[0].items[0]
  assert.equal(it.assignee, undefined)
  assert.equal(it.remindAt, undefined)
})

test('rejects a file that is not ours, with a message for a person', () => {
  assert.throws(() => parseBackup('not json at all'), /not readable as JSON/)
  assert.throws(() => parseBackup('[]'), /not a PearList backup/)
  assert.throws(() => parseBackup(JSON.stringify({ kind: 'pearguard-backup', version: 1 })), /not a PearList backup/)
  assert.throws(() => parseBackup(JSON.stringify({ kind: KIND, version: VERSION, spaces: [] })), /nothing in it/)
})

test('refuses a NEWER backup rather than half-importing it', () => {
  const doc = { kind: KIND, version: VERSION + 1, spaces: [{ name: 'S', lists: [{ name: 'L', items: [{ text: 'x' }] }] }] }
  assert.throws(() => parseBackup(JSON.stringify(doc)), /newer version/)
})

test('still reads the one-space shape this replaced', () => {
  // It never shipped, but the format is meant to be forgiving and reading it is
  // a few lines.
  const legacy = { kind: KIND_LEGACY_SINGLE, version: VERSION, space: { name: 'Old' }, lists: [{ name: 'L', items: [{ text: 'Eggs' }] }] }
  const back = parseBackup(JSON.stringify(legacy))
  assert.equal(back.counts.spaces, 1)
  assert.equal(back.spaces[0].name, 'Old')
  assert.deepEqual(back.spaces[0].lists[0].items, [{ text: 'Eggs' }])
})

test('an import cannot ask for unbounded work', () => {
  const items = Array.from({ length: MAX_ITEMS + 500 }, (_, i) => ({ text: 'item ' + i }))
  const doc = { kind: KIND, version: VERSION, spaces: [{ name: 'Big', lists: [{ name: 'L', items }] }] }
  assert.equal(parseBackup(JSON.stringify(doc)).counts.items, MAX_ITEMS)
})

test('the item budget is whole-file, not per space', () => {
  // Otherwise 50 spaces x 5000 items each is 250k rows behind one cap that reads
  // like it says 5000.
  const half = Array.from({ length: MAX_ITEMS }, (_, i) => ({ text: 'a' + i }))
  const doc = {
    kind: KIND,
    version: VERSION,
    spaces: [{ name: 'A', lists: [{ name: 'L', items: half }] }, { name: 'B', lists: [{ name: 'L', items: half }] }],
  }
  assert.equal(parseBackup(JSON.stringify(doc)).counts.items, MAX_ITEMS)
})

test('caps the number of spaces too', () => {
  const spaces = Array.from({ length: MAX_SPACES + 10 }, (_, i) => ({ name: 'S' + i, lists: [{ name: 'L', items: [{ text: 'x' }] }] }))
  const doc = { kind: KIND, version: VERSION, spaces }
  assert.equal(parseBackup(JSON.stringify(doc)).counts.spaces, MAX_SPACES)
})

test('survives a hand-edited file: junk is skipped, not fatal', () => {
  // The format is unsigned precisely so it CAN be hand-edited, so a stray null or
  // a row someone deleted the text from must not take the whole rescue down.
  const doc = {
    kind: KIND,
    version: VERSION,
    spaces: [
      null,
      'nope',
      { name: '  ', lists: [null, 'x', { name: '', items: [null, { text: '' }, { text: 'Eggs' }, 7] }] },
      { name: 'Empty', lists: [] },
    ],
  }
  const back = parseBackup(JSON.stringify(doc))
  assert.equal(back.spaces.length, 1, 'the empty space is not worth recreating')
  assert.equal(back.spaces[0].name, 'Imported space', 'a blank space name falls back')
  assert.equal(back.spaces[0].lists[0].name, 'List', 'a blank list name falls back')
  assert.deepEqual(back.spaces[0].lists[0].items, [{ text: 'Eggs' }])
})

test('filename is dated and says what it is', () => {
  assert.equal(backupFilename(Date.UTC(2026, 6, 28)), 'pearlist-backup-2026-07-28.json')
})
