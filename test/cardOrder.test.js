// Card order on the Lists page: new lists first, then the order this phone saved.

const test = require('node:test')
const assert = require('node:assert/strict')
const { orderCards, moveCard } = require('../src/cardOrder.js')

const ls = (...ids) => ids.map((id) => ({ id }))
const ids = (rows) => rows.map((l) => l.id)

test('with nothing saved the default order stands', () => {
  assert.deepEqual(ids(orderCards(ls('a', 'b', 'c'), [])), ['a', 'b', 'c'])
  assert.deepEqual(ids(orderCards(ls('a', 'b', 'c'), undefined)), ['a', 'b', 'c'])
})

test('saved lists follow the saved order and new ones come first', () => {
  assert.deepEqual(ids(orderCards(ls('a', 'b', 'c', 'd'), ['c', 'a', 'b'])), ['d', 'c', 'a', 'b'])
})

test('a deleted list in the saved order is skipped', () => {
  assert.deepEqual(ids(orderCards(ls('a', 'b'), ['x', 'b', 'a'])), ['b', 'a'])
})

test('moving forward lands after the target, moving back lands before it', () => {
  assert.deepEqual(moveCard(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveCard(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
})

test('dropping on itself or an unknown card changes nothing', () => {
  assert.deepEqual(moveCard(['a', 'b'], 'a', 'a'), ['a', 'b'])
  assert.deepEqual(moveCard(['a', 'b'], 'a', 'z'), ['a', 'b'])
  assert.deepEqual(moveCard(['a', 'b'], 'z', 'a'), ['a', 'b'])
})
