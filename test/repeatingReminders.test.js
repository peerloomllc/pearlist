// A reminder on a repeating item rings every period, not once. Reported
// 2026-10-01: a daily 9pm reminder on a to-do rang (at most) once, then the edit
// sheet said "that time has already passed" because remindAt was one fixed instant.
//
// A DST zone on purpose, so "9pm stays 9pm across the clock change" is tested and
// not assumed. node --test runs each file in its own process, so this is isolated.
process.env.TZ = 'America/New_York'

const test = require('node:test')
const assert = require('node:assert')
const { occurrenceAt, occurrencesAfter, nextOccurrence } = require('../src/repeatTime')
const { reminderTimes, isReminderPending, REMINDER_LOOKAHEAD } = require('../src/listWire')

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const hm = (t) => { const d = new Date(t); return [d.getHours(), d.getMinutes()] }
const PUB = 'a'.repeat(64)

test('a daily ring keeps its wall-clock time across a DST change', () => {
  // US clocks go back on 2026-11-01.
  const anchor = at(2026, 10, 30, 21, 0)
  for (let k = 0; k < 5; k++) assert.deepEqual(hm(occurrenceAt(anchor, 'daily', k)), [21, 0], 'ring ' + k)
  assert.equal(occurrenceAt(anchor, 'daily', 3), at(2026, 11, 2, 21, 0))
})

test('weekly keeps the weekday, monthly clamps to the end of a short month', () => {
  assert.equal(occurrenceAt(at(2026, 9, 30, 18), 'weekly', 2), at(2026, 10, 14, 18))
  const jan31 = at(2026, 1, 31, 9)
  assert.equal(occurrenceAt(jan31, 'monthly', 1), at(2026, 2, 28, 9), 'no Feb 31st, so the last day')
  assert.equal(occurrenceAt(jan31, 'monthly', 2), at(2026, 3, 31, 9), 'and back to the 31st after')
  assert.equal(occurrenceAt(at(2026, 11, 15, 9), 'monthly', 3), at(2027, 2, 15, 9), 'across a year end')
})

test('the next ring is the first one strictly after now, even from an old anchor', () => {
  const anchor = at(2026, 9, 30, 21, 0)
  assert.equal(nextOccurrence(anchor, 'daily', at(2026, 10, 1, 8)), at(2026, 10, 1, 21))
  assert.equal(nextOccurrence(anchor, 'daily', at(2026, 10, 1, 21)), at(2026, 10, 2, 21), 'exactly due is not still next')
  assert.equal(nextOccurrence(anchor, 'daily', anchor - 1), anchor, 'a future anchor is its own first ring')
  // Years later, still the right day, and no ring skipped by the jump ahead.
  assert.equal(nextOccurrence(anchor, 'daily', at(2031, 6, 15, 22)), at(2031, 6, 16, 21))
  assert.equal(nextOccurrence(at(2020, 1, 31, 9), 'monthly', at(2031, 6, 15)), at(2031, 6, 30, 9))
  const run = occurrencesAfter(anchor, 'daily', at(2028, 3, 1, 8), 3)
  assert.deepEqual(run, [at(2028, 3, 1, 21), at(2028, 3, 2, 21), at(2028, 3, 3, 21)])
})

test('nothing for a non-repeat kind or a junk anchor', () => {
  assert.equal(nextOccurrence(at(2026, 9, 30), 'yearly', at(2026, 10, 1)), null)
  assert.equal(nextOccurrence(NaN, 'daily', at(2026, 10, 1)), null)
})

test('THE BUG: a daily reminder set for last night still rings tonight and after', () => {
  const lastNight = at(2026, 9, 30, 21, 0)
  const morning = at(2026, 10, 1, 9, 0)
  const item = { repeat: 'daily', remindAt: lastNight, remindBy: PUB }
  const times = reminderTimes(item, morning)
  assert.equal(times.length, REMINDER_LOOKAHEAD.daily, 'a week booked ahead, so a closed app does not stop it')
  assert.equal(times[0], at(2026, 10, 1, 21, 0), 'tonight')
  assert.equal(times[6], at(2026, 10, 7, 21, 0))
  assert.equal(isReminderPending(item, {}, PUB, morning), true)
  // A one-off at the same time really is over.
  assert.deepEqual(reminderTimes({ remindAt: lastNight }, morning), [])
})

test('done today skips tonight only', () => {
  const item = { repeat: 'daily', remindAt: at(2026, 9, 30, 21), lastDoneAt: at(2026, 10, 1, 8), checked: true }
  const times = reminderTimes(item, at(2026, 10, 1, 9))
  assert.equal(times[0], at(2026, 10, 2, 21), 'tonight is skipped, tomorrow rings')
  assert.equal(times.length, REMINDER_LOOKAHEAD.daily)
})

test('deleted or reminder-less repeating items ring nothing', () => {
  const now = at(2026, 10, 1)
  assert.deepEqual(reminderTimes({ repeat: 'daily', remindAt: at(2026, 9, 30, 21), deleted: true }, now), [])
  assert.deepEqual(reminderTimes({ repeat: 'daily' }, now), [])
})
