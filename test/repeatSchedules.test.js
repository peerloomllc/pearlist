// MORE REPEAT SCHEDULES: every N days / weeks / months, and chosen weekdays.
// proposals/2026-10-31-more-repeat-schedules.md.
//
// Fixed to a zone with DST so the week and day boundaries are tested across a clock
// change rather than wherever this machine happens to be. Each test file runs in its
// own process under `node --test`, so this does not leak into the others.
process.env.TZ = 'America/New_York'

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Corestore = require('corestore')
const { createGroupEngine } = require('@peerloom/core/engine')
const { scheduleOf, repeatRefinement, periodStartOf, nextPeriodStart, occurrencesAfter } = require('../src/repeatTime')
const { applyListOp, isRecurringOpen, effectiveChecked, nextDueAt, reminderTimes } = require('../src/listWire')
const listMethods = require('../src/listMethods')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')
after(cleanupTmpDirs)

const at = (s) => new Date(s).getTime()
const day = (t) => new Date(t).toDateString()

test('scheduleOf reads a refinement only for the repeat it was written for', () => {
  assert.equal(scheduleOf({ repeat: 'yearly' }), null, 'unknown kind is not a schedule')
  assert.deepEqual(scheduleOf({ repeat: 'weekly', createdAt: 5 }), { kind: 'weekly', every: 1, days: null, from: 5 })
  const two = { repeat: 'weekly', repeatEvery: 2, repeatFrom: 100, repeatFor: 'weekly' }
  assert.equal(scheduleOf(two).every, 2)
  // An old build changed `repeat` through its own picker and left the rest behind.
  assert.equal(scheduleOf({ ...two, repeat: 'daily' }).every, 1, 'a stale refinement is ignored, not misapplied')
  for (const bad of [1, 0, 100, 2.5, '3', null]) {
    assert.equal(scheduleOf({ ...two, repeatEvery: bad }).every, 1, `repeatEvery ${bad} means 1`)
  }
  const mwf = { repeat: 'daily', repeatDays: [5, 1, 3, 3, 9], repeatFor: 'daily' }
  assert.deepEqual(scheduleOf(mwf).days, [1, 3, 5], 'sorted, deduplicated, out-of-range dropped')
  assert.equal(scheduleOf({ ...mwf, repeatDays: [0, 1, 2, 3, 4, 5, 6] }).days, null, 'all seven is just daily')
  assert.equal(scheduleOf({ ...mwf, repeatDays: [] }).days, null)
  assert.equal(scheduleOf({ repeat: 'weekly', repeatDays: [1], repeatFor: 'weekly' }).days, null, 'days only apply to daily')
})

test('repeatRefinement writes only what scheduleOf will read back', () => {
  assert.deepEqual(repeatRefinement('weekly', 1, null, 0), {}, 'a plain schedule writes nothing extra')
  assert.deepEqual(repeatRefinement('yearly', 2, null, 0), {})
  const r = repeatRefinement('weekly', 2, null, at('2026-10-29T15:00'))
  assert.equal(r.repeatEvery, 2)
  assert.equal(r.repeatFor, 'weekly')
  assert.equal(day(r.repeatFrom), day(at('2026-10-25T12:00')), 'anchored to the start of that week (Sunday)')
  assert.deepEqual(repeatRefinement('daily', null, [3, 1], 0), { repeatDays: [1, 3], repeatFor: 'daily' })
  assert.deepEqual(repeatRefinement('monthly', null, [1], 0), {}, 'days need daily')
})

test('every 2 weeks: blocks stay on the calendar, even when done late', () => {
  const item = { repeat: 'weekly', ...repeatRefinement('weekly', 2, null, at('2026-10-20T10:00')) }
  // Blocks: Oct 18-31, Nov 1-14, Nov 15-28.
  assert.equal(day(periodStartOf(scheduleOf(item), at('2026-10-31T23:00'))), day(at('2026-10-18T12:00')))
  assert.equal(day(periodStartOf(scheduleOf(item), at('2026-11-01T09:00'))), day(at('2026-11-01T12:00')), 'the DST change day starts a block')
  assert.equal(day(nextDueAt(item, at('2026-11-03T12:00'))), day(at('2026-11-15T12:00')))

  // Done four days late, on Nov 4: closed for the rest of that block, open again on
  // the usual date (Nov 15), not two weeks after the late completion.
  const done = { ...item, lastDoneAt: at('2026-11-04T12:00') }
  assert.equal(isRecurringOpen(done, at('2026-11-10T12:00')), false)
  assert.equal(isRecurringOpen(done, at('2026-11-15T08:00')), true, 'back on the calendar date')
  assert.equal(effectiveChecked(done, at('2026-11-14T22:00')), true)
})

test('every 3 months: blocks counted from the month it was set', () => {
  const item = { repeat: 'monthly', ...repeatRefinement('monthly', 3, null, at('2026-01-15T12:00')) }
  const s = scheduleOf(item)
  assert.equal(day(periodStartOf(s, at('2026-03-31T12:00'))), day(at('2026-01-01T12:00')))
  assert.equal(day(periodStartOf(s, at('2026-04-01T12:00'))), day(at('2026-04-01T12:00')))
  assert.equal(day(nextPeriodStart(s, at('2026-11-30T12:00'))), day(at('2027-01-01T12:00')), 'crosses the year')
  const done = { ...item, lastDoneAt: at('2026-02-01T12:00') }
  assert.equal(isRecurringOpen(done, at('2026-03-31T12:00')), false)
  assert.equal(isRecurringOpen(done, at('2026-04-02T12:00')), true)
})

test('every 4 days counts whole days across the clock change', () => {
  const s = scheduleOf({ repeat: 'daily', ...repeatRefinement('daily', 4, null, at('2026-10-30T20:00')) })
  // Oct 30, Nov 3, Nov 7. Nov 1 is the fall-back day, 25 hours long.
  assert.equal(day(periodStartOf(s, at('2026-11-02T23:30'))), day(at('2026-10-30T12:00')))
  assert.equal(day(periodStartOf(s, at('2026-11-03T00:30'))), day(at('2026-11-03T12:00')))
  assert.equal(new Date(periodStartOf(s, at('2026-11-03T00:30'))).getHours(), 0, 'midnight, not 11pm')
})

test('Mon, Wed, Fri: a missed day stays open until the next chosen day', () => {
  const item = { repeat: 'daily', ...repeatRefinement('daily', null, [1, 3, 5], 0) }
  // Nov 2 2026 is a Monday.
  const s = scheduleOf(item)
  assert.equal(day(periodStartOf(s, at('2026-11-03T12:00'))), day(at('2026-11-02T12:00')), 'Tuesday is still Monday\'s period')
  assert.equal(day(nextPeriodStart(s, at('2026-11-03T12:00'))), day(at('2026-11-04T12:00')))
  assert.equal(day(periodStartOf(s, at('2026-11-08T12:00'))), day(at('2026-11-06T12:00')), 'Sunday belongs to Friday')
  assert.equal(day(nextPeriodStart(s, at('2026-11-07T12:00'))), day(at('2026-11-09T12:00')), 'wraps to Monday')

  assert.equal(isRecurringOpen(item, at('2026-11-03T12:00')), true, 'never done')
  const doneMon = { ...item, lastDoneAt: at('2026-11-02T18:00') }
  assert.equal(isRecurringOpen(doneMon, at('2026-11-03T12:00')), false, 'done Monday, closed Tuesday')
  assert.equal(isRecurringOpen(doneMon, at('2026-11-04T07:00')), true, 'open again Wednesday')
})

test('reminders ring once per block, and only on the chosen days', () => {
  const two = scheduleOf({ repeat: 'weekly', ...repeatRefinement('weekly', 2, null, at('2026-10-20T10:00')) })
  assert.deepEqual(occurrencesAfter(at('2026-10-20T19:00'), two, at('2026-10-21T00:00'), 3).map(day),
    ['2026-11-03T12:00', '2026-11-17T12:00', '2026-12-01T12:00'].map((x) => day(at(x))))
  assert.equal(new Date(occurrencesAfter(at('2026-10-20T19:00'), two, at('2026-10-21T00:00'), 1)[0]).getHours(), 19, 'same time of day after DST')

  const item = { repeat: 'daily', ...repeatRefinement('daily', null, [1, 3, 5], 0), remindAt: at('2026-11-02T08:00') }
  const rings = reminderTimes(item, at('2026-11-02T09:00'), 4)
  assert.deepEqual(rings.map((t) => new Date(t).getDay()), [3, 5, 1, 3])
  // Done on Wednesday morning before its ring: that ring stays quiet, Friday still rings.
  const doneWed = { ...item, lastDoneAt: at('2026-11-04T07:00') }
  assert.deepEqual(reminderTimes(doneWed, at('2026-11-04T07:30'), 2).map((t) => new Date(t).getDay()), [5, 1])
})

test('an old build sees the plain repeat, so the chore still comes back', () => {
  // What an old build does: it reads `repeat` and nothing else.
  const row = { repeat: 'weekly', ...repeatRefinement('weekly', 2, null, at('2026-10-20T10:00')), lastDoneAt: at('2026-11-02T12:00') }
  const oldView = { repeat: row.repeat, lastDoneAt: row.lastDoneAt }
  assert.equal(isRecurringOpen(oldView, at('2026-11-09T12:00')), true, 'old build: weekly, open again the next week')
  assert.equal(isRecurringOpen(row, at('2026-11-09T12:00')), false, 'new build: still inside the two-week block')
})

// --- through the real methods ------------------------------------------------

function driver () {
  const responses = []
  const read = new EventEmitter()
  const swarm = () => { const ee = new EventEmitter(); ee.join = () => ({ flushed: async () => {} }); ee.leave = () => {}; ee.destroy = async () => {}; return ee }
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: new Corestore(tmpDir('pearlist-')), createSwarm: swarm,
    applyOps: applyListOp, methods: listMethods,
  })
  engine.start({ read, write: (buf) => responses.push(JSON.parse(buf.toString())) })
  let nextId = 1
  const call = async (method, args) => {
    const id = nextId++
    read.emit('data', Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
    for (let i = 0; i < 200; i++) {
      const r = responses.find((x) => x.id === id)
      if (r) { if (r.error) throw new Error(r.error); return r.result }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('timed out: ' + method)
  }
  return { engine, call }
}

test('item:setRepeat writes the refinement, and a plain repeat clears it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  await call('space:init', { groupId, name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })
  const get = async () => (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)

  assert.deepEqual(await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly', every: 2 }), { repeat: 'weekly', every: 2 })
  let row = await get()
  assert.equal(row.repeatEvery, 2)
  assert.equal(row.repeatFor, 'weekly')
  assert.ok(row.repeatFrom > 0)

  assert.deepEqual(await call('item:setRepeat', { groupId, listId, itemId, repeat: 'daily', days: [5, 1] }), { repeat: 'daily', days: [1, 5] })
  row = await get()
  assert.equal(row.repeatEvery, undefined, 'the old every-N is gone, not left to go stale')
  assert.deepEqual(row.repeatDays, [1, 5])

  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'daily' })
  row = await get()
  assert.equal(row.repeatDays, undefined)
  assert.equal(row.repeatFor, undefined)
  await engine.close()
})

test('a backup carries the finer schedule and restores it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  await call('space:init', { groupId, name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const a = await call('item:add', { groupId, listId, text: 'bins' })
  const b = await call('item:add', { groupId, listId, text: 'lunches' })
  await call('item:setRepeat', { groupId, listId, itemId: a.itemId, repeat: 'weekly', every: 2 })
  await call('item:setRepeat', { groupId, listId, itemId: b.itemId, repeat: 'daily', days: [1, 2, 3, 4, 5] })
  const before = (await call('item:getAll', { groupId, listId })).find((r) => r.id === a.itemId)

  const exp = await call('backup:export', {})
  const imp = await call('backup:import', { jsonString: exp.json })
  const g2 = imp.spaces[0].groupId
  const [list] = await call('list:getAll', { groupId: g2 })
  const items = await call('item:getAll', { groupId: g2, listId: list.id })
  const bins = items.find((r) => r.text === 'bins')
  const lunches = items.find((r) => r.text === 'lunches')
  assert.equal(bins.repeatEvery, 2)
  assert.equal(bins.repeatFrom, before.repeatFrom, 'same blocks after a restore, not restarted from today')
  assert.deepEqual(lunches.repeatDays, [1, 2, 3, 4, 5])
  await engine.close()
})
