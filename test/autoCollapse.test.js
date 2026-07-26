// "Tidy finished aisles" (GH #90). The interesting part is not "collapse when
// done", it is everything around it: not fighting a hand-expanded group, not
// reopening a group the user closed themselves and treating the first pass on a
// list differently from a live check-off.

const test = require('node:test')
const assert = require('node:assert/strict')

const { finishedGroups, nextCollapseState } = require('../src/autoCollapse')

const item = (category, checked) => ({ category, checked })
const state = (collapsed = [], auto = []) => ({ collapsed, auto })

test('a group counts as finished only when it has items and none are open', () => {
  const done = finishedGroups([
    item('Produce', true), item('Produce', true),
    item('Dairy', true), item('Dairy', false),
  ])
  assert.deepEqual([...done].sort(), ['Produce'])
})

test('an uncategorized item falls into the Other bucket', () => {
  const done = finishedGroups([item(null, true), item('', true)])
  assert.deepEqual([...done], ['Other'])
})

test('checking the last open item collapses that group and marks it auto', () => {
  const before = finishedGroups([item('Produce', true), item('Dairy', false)])
  const next = nextCollapseState({
    items: [item('Produce', true), item('Dairy', true)],
    prevDone: before,
    ...state(['Produce'], ['Produce']),
  })
  assert.equal(next.changed, true)
  assert.deepEqual(next.collapsed.sort(), ['Dairy', 'Produce'])
  assert.deepEqual(next.auto.sort(), ['Dairy', 'Produce'])
})

test('unchecking an item reopens a group the rule closed', () => {
  const items = [item('Dairy', false)]
  const next = nextCollapseState({ items, prevDone: new Set(['Dairy']), ...state(['Dairy'], ['Dairy']) })
  assert.equal(next.changed, true)
  assert.deepEqual(next.collapsed, [])
  assert.deepEqual(next.auto, [])
})

test('unchecking does NOT reopen a group the user collapsed by hand', () => {
  const items = [item('Dairy', false)]
  const next = nextCollapseState({ items, prevDone: new Set(['Dairy']), ...state(['Dairy'], []) })
  assert.equal(next.changed, false)
  assert.deepEqual(next.collapsed, ['Dairy'])
})

test('a finished group the user re-expanded is not collapsed again', () => {
  // The user tapped the header, so the caller dropped it from `auto` AND from
  // `collapsed`. It is still finished, so only the transition rule keeps it open.
  const items = [item('Produce', true)]
  const next = nextCollapseState({ items, prevDone: new Set(['Produce']), ...state([], []) })
  assert.equal(next.changed, false)
  assert.deepEqual(next.collapsed, [])
})

test('re-finishing a group after an uncheck collapses it again', () => {
  const items = [item('Produce', true)]
  const next = nextCollapseState({ items, prevDone: new Set(), ...state([], []) })
  assert.equal(next.changed, true)
  assert.deepEqual(next.collapsed, ['Produce'])
  assert.deepEqual(next.auto, ['Produce'])
})

test('the first pass on a list closes groups that are already finished', () => {
  const items = [item('Produce', true), item('Dairy', false)]
  const next = nextCollapseState({ items, prevDone: null, ...state([], []) })
  assert.equal(next.changed, true)
  assert.deepEqual(next.collapsed, ['Produce'])
  assert.deepEqual(next.auto, ['Produce'])
})

test('a steady pass with nothing new writes nothing', () => {
  const items = [item('Produce', true), item('Dairy', false)]
  const done = finishedGroups(items)
  const next = nextCollapseState({ items, prevDone: done, ...state(['Produce'], ['Produce']) })
  assert.equal(next.changed, false, 'no write means no render loop')
  assert.deepEqual(next.collapsed, ['Produce'])
})

test('a group already collapsed by hand when it finishes is not claimed as auto', () => {
  // Collapse Dairy by hand while it still has open items, then check them off:
  // the group is already closed, so the rule has nothing to do and must not take
  // ownership - otherwise a later uncheck would reopen a group the user shut.
  const items = [item('Dairy', true)]
  const next = nextCollapseState({ items, prevDone: new Set(), ...state(['Dairy'], []) })
  assert.equal(next.changed, false)
  assert.deepEqual(next.auto, [])
})

test('an emptied group is not treated as finished', () => {
  // Deleting every row in a group (or clearing checked items) makes it vanish from
  // the view. It must not count as done, or it would be collapsed on reappearing.
  const next = nextCollapseState({ items: [], prevDone: null, ...state([], []) })
  assert.equal(next.changed, false)
  assert.deepEqual([...next.done], [])
})

test('other groups are left untouched when one finishes', () => {
  const items = [item('Produce', true), item('Dairy', false), item('Frozen', false)]
  const next = nextCollapseState({ items, prevDone: new Set(), ...state(['Frozen'], []) })
  assert.deepEqual(next.collapsed.sort(), ['Frozen', 'Produce'])
  assert.deepEqual(next.auto, ['Produce'])
})

test('sections on non-grocery lists work the same as aisles', () => {
  const items = [item('Upstairs', true), item('Garage', false)]
  const next = nextCollapseState({ items, prevDone: new Set(), ...state([], []) })
  assert.deepEqual(next.collapsed, ['Upstairs'])
})
