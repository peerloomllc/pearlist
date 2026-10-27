const test = require('node:test')
const assert = require('node:assert/strict')
const { groupOf, groupByReminder } = require('../src/reminderGroups')

// Local wall-clock helper, so these read as times rather than epochs.
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const now = at(2026, 10, 24, 10, 0) // Saturday 24 October, 10am

test('each group covers the days its label claims', () => {
  const g = (remindAt) => groupOf({ remindAt }, now)
  assert.equal(g(undefined), 'No reminder')
  assert.equal(g(at(2026, 10, 20, 9)), 'Today', 'overdue counts as today')
  assert.equal(g(at(2026, 10, 24, 23, 59)), 'Today')
  assert.equal(g(at(2026, 10, 25, 0, 0)), 'This week')
  assert.equal(g(at(2026, 10, 31, 23, 59)), 'This week', 'seven days after today')
  assert.equal(g(at(2026, 11, 1, 9)), 'Later', 'next month is never "this month"')
  // Earlier in the month the month group has room after the week.
  const early = at(2026, 10, 3, 10)
  assert.equal(groupOf({ remindAt: at(2026, 10, 10, 23) }, early), 'This week')
  assert.equal(groupOf({ remindAt: at(2026, 10, 11, 9) }, early), 'This month')
  assert.equal(groupOf({ remindAt: at(2026, 10, 31, 23) }, early), 'This month')
  assert.equal(groupOf({ remindAt: at(2026, 11, 1, 0) }, early), 'Later')
})

test('a repeating item is filed by its occurrence today, or its next one once done', () => {
  // Daily at 8am, first set months ago. This morning's 8am has passed but it is still today's.
  const daily = { remindAt: at(2026, 6, 1, 8), repeat: 'daily' }
  assert.equal(groupOf(daily, now), 'Today')
  // Monthly on the 1st: next is 1 November.
  assert.equal(groupOf({ remindAt: at(2026, 1, 1, 9), repeat: 'monthly' }, now), 'Later')
  // Ticked off for this round, back next week.
  assert.equal(groupOf({ ...daily, repeat: 'weekly', checked: true, nextDueAt: at(2026, 10, 30, 8) }, now), 'This week')
})

test('groups come out in order, empty ones dropped, soonest first inside each', () => {
  const items = [
    { id: 'none1' },
    { id: 'later', remindAt: at(2027, 1, 5) },
    { id: 'today-pm', remindAt: at(2026, 10, 24, 18) },
    { id: 'none2' },
    { id: 'today-am', remindAt: at(2026, 10, 24, 9) },
  ]
  const out = groupByReminder(items, now)
  assert.deepEqual(out.map((g) => g.group), ['Today', 'Later', 'No reminder'])
  assert.deepEqual(out[0].items.map((i) => i.id), ['today-am', 'today-pm'])
  assert.deepEqual(out[2].items.map((i) => i.id), ['none1', 'none2'], 'undated items keep their order')
})
