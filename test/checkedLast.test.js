// "Checked items last" (GH #249). The rule is a stable partition: open items keep
// their order, ticked items keep theirs, and the ticked ones come after.

const test = require('node:test')
const assert = require('node:assert/strict')

const { checkedLast } = require('../src/checkedLast.js')

const ids = (rows) => rows.map((it) => it.id)

test('ticked items move after the open ones, each side keeping its order', () => {
  const rows = [
    { id: 'a', checked: true }, { id: 'b' }, { id: 'c', checked: true },
    { id: 'd', checked: false }, { id: 'e' }
  ]
  assert.deepEqual(ids(checkedLast(rows)), ['b', 'd', 'e', 'a', 'c'])
})

test('a list with nothing ticked, or everything ticked, is unchanged', () => {
  assert.deepEqual(ids(checkedLast([{ id: 'a' }, { id: 'b' }])), ['a', 'b'])
  assert.deepEqual(ids(checkedLast([{ id: 'a', checked: true }, { id: 'b', checked: true }])), ['a', 'b'])
})

test('it does not change the array it is given', () => {
  const rows = [{ id: 'a', checked: true }, { id: 'b' }]
  checkedLast(rows)
  assert.deepEqual(ids(rows), ['a', 'b'])
})

test('no rows gives no rows', () => {
  assert.deepEqual(checkedLast(undefined), [])
  assert.deepEqual(checkedLast([]), [])
})
