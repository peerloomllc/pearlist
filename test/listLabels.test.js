// Labels on lists (proposals/2026-10-29-keep-style-notes.md): a shared field on the
// list row, cleaned on read, kept through a backup, used to filter the Lists page.
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeLabels, spaceLabels, hasLabels, LABELS_MAX, LABEL_MAX_LEN } = require('../src/listStyle')
const { buildBackup, parseBackup } = require('../src/spaceBackup')

test('normalizeLabels trims, squashes spaces, drops repeats and caps the count and length', () => {
  assert.deepEqual(normalizeLabels(['  Work ', 'work', 'Home  stuff', '', 5, null]), ['Work', 'Home stuff'])
  assert.equal(normalizeLabels(['x'.repeat(50)])[0].length, LABEL_MAX_LEN)
  assert.equal(normalizeLabels(Array.from({ length: 15 }, (_, i) => 'L' + i)).length, LABELS_MAX)
  assert.deepEqual(normalizeLabels('Work'), [])
  assert.deepEqual(normalizeLabels(undefined), [])
})

test('spaceLabels lists each label once, A to Z, and skips deleted lists', () => {
  const lists = [
    { labels: ['work', 'Recipes'] },
    { labels: ['Work', 'baking'] },
    { labels: ['Gone'], deleted: true },
    { labels: 'junk' },
  ]
  assert.deepEqual(spaceLabels(lists), ['baking', 'Recipes', 'work'])
})

test('hasLabels needs every picked label, ignoring case', () => {
  const l = { labels: ['Work', 'Urgent'] }
  assert.equal(hasLabels(l, []), true)
  assert.equal(hasLabels(l, ['work']), true)
  assert.equal(hasLabels(l, ['work', 'URGENT']), true)
  assert.equal(hasLabels(l, ['work', 'home']), false)
  assert.equal(hasLabels({}, ['work']), false)
})

test('a saved copy carries the labels', () => {
  const spaces = [{ name: 'Home', lists: [
    { name: 'A', kind: 'note', labels: ['Recipes', 'Baking'], items: [] },
    { name: 'B', kind: 'list', items: [] },
  ] }]
  const { spaces: back } = parseBackup(JSON.stringify(buildBackup({ spaces, templates: [], learnedAisles: {}, exportedAt: 1 })))
  assert.deepEqual(back[0].lists[0].labels, ['Recipes', 'Baking'])
  assert.equal('labels' in back[0].lists[1], false)
})
