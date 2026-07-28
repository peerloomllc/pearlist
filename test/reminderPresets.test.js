const test = require('node:test')
const assert = require('node:assert/strict')
const {
  itemPresets, dailyPresets, describeWhen, stepDays, stepMinutes, defaultExact, MINUTE_STEP,
} = require('../src/reminderPresets')

// Local wall-clock helper, so these read as times rather than epochs.
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()

test('presets resolve to the times their labels claim', () => {
  const now = at(2026, 7, 27, 10, 15) // Monday morning
  const by = Object.fromEntries(itemPresets(now).map((p) => [p.key, p.at]))
  assert.equal(by.hour, now + 60 * 60 * 1000)
  assert.equal(by.evening, at(2026, 7, 27, 18))
  assert.equal(by.tomorrowAm, at(2026, 7, 28, 9))
  assert.equal(by.tomorrowPm, at(2026, 7, 28, 18))
  assert.equal(by.week, at(2026, 8, 3, 9))
})

test('a preset already in the past is dropped, not offered and ignored', () => {
  // 9pm: "this evening" has been and gone.
  const evening = itemPresets(at(2026, 7, 27, 21, 0)).map((p) => p.key)
  assert.equal(evening.includes('evening'), false, 'an option you cannot pick is noise')
  assert.deepEqual(evening, ['hour', 'tomorrowAm', 'tomorrowPm', 'week'])
  // Just before 6pm it is still on offer.
  assert.equal(itemPresets(at(2026, 7, 27, 17, 59)).some((p) => p.key === 'evening'), true)
  // Every preset is always in the future, whatever the hour.
  for (const h of [0, 5, 8, 12, 17, 18, 22, 23]) {
    const now = at(2026, 7, 27, h, 30)
    assert.equal(itemPresets(now).every((p) => p.at > now), true, `all future at ${h}:30`)
    assert.ok(itemPresets(now).length >= 4, `something is always offered at ${h}:30`)
  }
})

test('presets survive a month boundary', () => {
  const now = at(2026, 7, 31, 20, 0) // last day of July, evening gone
  const by = Object.fromEntries(itemPresets(now).map((p) => [p.key, p.at]))
  assert.equal(by.tomorrowAm, at(2026, 8, 1, 9), 'tomorrow is August')
  assert.equal(by.week, at(2026, 8, 7, 9))
})

test('describeWhen names the day the way a person would', () => {
  const now = at(2026, 7, 27, 10, 0) // Monday
  assert.equal(describeWhen(at(2026, 7, 27, 18), now).day, 'Today')
  assert.equal(describeWhen(at(2026, 7, 28, 9), now).day, 'Tomorrow')
  assert.equal(describeWhen(at(2026, 7, 30, 9), now).day, 'Thursday', 'within the week, name the day')
  assert.match(describeWhen(at(2026, 8, 15, 9), now).day, /Aug/, 'further out, give a date')
  assert.equal(describeWhen(at(2026, 7, 26, 9), now).day, describeWhen(at(2026, 7, 26, 9), now).day)
  assert.ok(describeWhen(at(2026, 7, 27, 18), now).time.length > 0)
  assert.equal(describeWhen(null, now), null)
  assert.equal(describeWhen(NaN, now), null)
})

test('day stepping keeps the time of day, including across a DST change', () => {
  const when = at(2026, 10, 31, 14, 30)
  assert.equal(stepDays(when, 1), at(2026, 11, 1, 14, 30), 'still 2:30pm the next day, DST or not')
  assert.equal(stepDays(when, -1), at(2026, 10, 30, 14, 30))
  assert.equal(stepDays(at(2026, 12, 31, 8, 0), 1), at(2027, 1, 1, 8, 0), 'across a year')
})

test('minute stepping wraps within the day rather than changing the date', () => {
  assert.equal(stepMinutes(at(2026, 7, 27, 14, 30), 1), at(2026, 7, 27, 14, 30 + MINUTE_STEP))
  assert.equal(stepMinutes(at(2026, 7, 27, 14, 30), -1), at(2026, 7, 27, 14, 30 - MINUTE_STEP))
  // 23:55 + 5 wraps to 00:00 the SAME day: adjusting a time field should never
  // silently move the date. That is what the day stepper is for.
  assert.equal(stepMinutes(at(2026, 7, 27, 23, 55), 1), at(2026, 7, 27, 0, 0))
  assert.equal(stepMinutes(at(2026, 7, 27, 0, 0), -1), at(2026, 7, 27, 23, 55))
  // An off-grid time snaps to the grid as it steps.
  assert.equal(stepMinutes(at(2026, 7, 27, 14, 33), 1), at(2026, 7, 27, 14, 40))
})

test('the exact picker opens on the next whole hour, always in the future', () => {
  const now = at(2026, 7, 27, 14, 33)
  assert.equal(defaultExact(now), at(2026, 7, 27, 15, 0))
  assert.ok(defaultExact(now) > now)
  // Late at night it rolls into tomorrow rather than offering a past time.
  const late = at(2026, 7, 27, 23, 40)
  assert.equal(defaultExact(late), at(2026, 7, 28, 0, 0))
  assert.ok(defaultExact(late) > late)
})

test('daily presets are plain times of day, offered whatever the hour', () => {
  const keys = dailyPresets().map((p) => p.key)
  assert.deepEqual(keys, ['morning', 'midday', 'evening', 'night'])
  assert.equal(dailyPresets().every((p) => p.hour >= 0 && p.hour <= 23 && p.minute % MINUTE_STEP === 0), true)
})
