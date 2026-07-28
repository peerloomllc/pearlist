// Space export / import, the pure half. The interesting cases are all about what
// a file must NOT be able to do: carry a household identity, name an assignee who
// does not exist in the new space, or ask an import to write unbounded rows.

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildBackup, parseBackup, backupFilename, KIND, VERSION, MAX_ITEMS } = require('../src/spaceBackup')

const row = (over = {}) => ({ text: 'Milk', qty: 1, checked: false, ...over })
const snapshot = (over = {}) => ({
  spaceName: 'Fresh',
  exportedAt: 1753700000000,
  lists: [{ name: 'Groceries', kind: 'grocery', items: [row()] }],
  ...over,
})

test('round trip: what goes out comes back', () => {
  const doc = buildBackup(snapshot())
  const back = parseBackup(JSON.stringify(doc))
  assert.equal(back.name, 'Fresh')
  assert.equal(back.lists.length, 1)
  assert.equal(back.lists[0].name, 'Groceries')
  assert.equal(back.lists[0].kind, 'grocery')
  assert.deepEqual(back.lists[0].items[0], { text: 'Milk' })
})

test('carries item state a template deliberately drops', () => {
  const doc = buildBackup(snapshot({
    lists: [{ name: 'L', kind: null, items: [row({ checked: true, qty: 3, category: 'Dairy', note: 'the blue one', url: 'https://x.test', ord: 'a1' })] }],
  }))
  const it = parseBackup(JSON.stringify(doc)).lists[0].items[0]
  assert.equal(it.checked, true)
  assert.equal(it.qty, 3)
  assert.equal(it.category, 'Dairy')
  assert.equal(it.note, 'the blue one')
  assert.equal(it.url, 'https://x.test')
  assert.equal(it.ord, 'a1')
})

test('never carries the household: no identity, keys, assignee or reminder', () => {
  const doc = buildBackup(snapshot({
    lists: [{
      name: 'L',
      kind: null,
      items: [row({ assignee: 'deadbeef'.repeat(8), createdBy: 'cafe'.repeat(16), remindAt: 1753700000000, _w: 'ff'.repeat(32), sig: 'nope' })],
    }],
  }))
  const text = JSON.stringify(doc)
  for (const leak of ['deadbeef', 'cafecafe', 'remindAt', '_w', 'sig']) {
    assert.doesNotMatch(text, new RegExp(leak), 'leaked ' + leak)
  }
  const it = doc.lists[0].items[0]
  assert.equal(it.assignee, undefined)
  assert.equal(it.remindAt, undefined)
})

test('rejects a file that is not ours, with a message for a person', () => {
  assert.throws(() => parseBackup('not json at all'), /not readable as JSON/)
  assert.throws(() => parseBackup('[]'), /not a PearList export/)
  assert.throws(() => parseBackup(JSON.stringify({ kind: 'pearguard-backup', version: 1 })), /not a PearList export/)
  assert.throws(() => parseBackup(JSON.stringify({ kind: KIND, version: VERSION, lists: [] })), /no lists in it/)
})

test('refuses a NEWER export rather than half-importing it', () => {
  const doc = { kind: KIND, version: VERSION + 1, lists: [{ name: 'L', items: [{ text: 'x' }] }] }
  assert.throws(() => parseBackup(JSON.stringify(doc)), /newer version/)
})

test('an import cannot ask for unbounded work', () => {
  const items = Array.from({ length: MAX_ITEMS + 500 }, (_, i) => ({ text: 'item ' + i }))
  const doc = { kind: KIND, version: VERSION, space: { name: 'Big' }, lists: [{ name: 'L', items }] }
  const back = parseBackup(JSON.stringify(doc))
  assert.equal(back.counts.items, MAX_ITEMS)
})

test('survives a hand-edited file: junk rows are skipped, not fatal', () => {
  // The format is unsigned precisely so it CAN be hand-edited, so a stray null or
  // a row someone deleted the text from must not take the whole rescue down.
  const doc = {
    kind: KIND,
    version: VERSION,
    space: { name: '  ' },
    lists: [null, 'nope', { name: '', items: [null, { text: '' }, { text: 'Eggs' }, 7] }],
  }
  const back = parseBackup(JSON.stringify(doc))
  assert.equal(back.name, 'Imported space', 'a blank space name falls back')
  assert.equal(back.lists.length, 1)
  assert.equal(back.lists[0].name, 'List', 'a blank list name falls back')
  assert.deepEqual(back.lists[0].items, [{ text: 'Eggs' }])
})

test('filename is dated and readable at a glance', () => {
  assert.equal(backupFilename('Fresh Groceries!', Date.UTC(2026, 6, 28)), 'pearlist-fresh-groceries-2026-07-28.json')
  assert.equal(backupFilename('', Date.UTC(2026, 6, 28)), 'pearlist-space-2026-07-28.json')
})
