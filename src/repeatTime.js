// When a repeating item's reminder rings. Pure and time-injected.
//
// The row stores ONE instant, `remindAt`, and that stays true for a repeating
// item: it is the first ring, and every later one is worked out from it at read
// time (the follow-up named in proposals/2026-07-27-recurring-chores.md). Nothing
// rewrites the row on a timer, so there is no per-device reset churning the log.
//
// Later rings keep the first one's LOCAL time of day, plus its weekday (weekly)
// or its day of the month (monthly, clamped to the month's last day, so the 31st
// rings on Feb 28). Built from date parts rather than by adding milliseconds, so
// a DST change cannot move 9pm to 8pm.
//
// No dependencies: the UI imports this to label the next ring, the worklet
// imports it through listWire to schedule them.

const DAY_MS = 24 * 60 * 60 * 1000
const KINDS = ['daily', 'weekly', 'monthly']

// MORE SCHEDULES (proposals/2026-10-31-more-repeat-schedules.md). `repeat` keeps
// its three values so an old build still repeats the item. The refinement rides
// beside it: repeatEvery (2-99 periods), repeatDays (weekdays, daily only) and
// repeatFrom (where every-N blocks are counted from). repeatFor is the `repeat` it
// was written for: an old build that changes `repeat` leaves the refinement behind,
// and a refinement for a different kind is ignored rather than misapplied.
//
// Returns { kind, every, days, from } or null. `days` is null unless it applies.
function scheduleOf (item) {
  if (!item || !KINDS.includes(item.repeat)) return null
  const kind = item.repeat
  const own = item.repeatFor === kind
  const n = own ? item.repeatEvery : null
  const every = Number.isInteger(n) && n >= 2 && n <= 99 ? n : 1
  let days = null
  if (own && kind === 'daily' && every === 1 && Array.isArray(item.repeatDays)) {
    const set = [...new Set(item.repeatDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y)
    if (set.length >= 1 && set.length < 7) days = set
  }
  const from = own && Number.isFinite(item.repeatFrom) ? item.repeatFrom
    : Number.isFinite(item.createdAt) ? item.createdAt : 0
  return { kind, every, days, from }
}

// The row fields for a refinement, validated the same way scheduleOf reads them.
// {} when the schedule is a plain daily / weekly / monthly. `from` is any instant
// in the first block; it is stored as the start of that block.
function repeatRefinement (kind, every, days, from) {
  if (!KINDS.includes(kind)) return {}
  if (Number.isInteger(every) && every >= 2 && every <= 99) {
    const at = Number.isFinite(from) ? from : Date.now()
    return { repeatEvery: every, repeatFrom: startOfIndex(kind, indexOf(kind, at)), repeatFor: kind }
  }
  if (kind === 'daily' && Array.isArray(days)) {
    const set = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y)
    if (set.length >= 1 && set.length < 7) return { repeatDays: set, repeatFor: kind }
  }
  return {}
}

// A plain kind string is the one-period schedule it always was.
function asSchedule (kindOrSchedule) {
  if (kindOrSchedule && typeof kindOrSchedule === 'object') return kindOrSchedule
  return KINDS.includes(kindOrSchedule) ? { kind: kindOrSchedule, every: 1, days: null, from: 0 } : null
}

// Sunday, matching the calendar convention where this is used.
const WEEK_STARTS_ON = 0

// Whole-period counters from LOCAL date parts, so DST never shifts a boundary.
// Date.UTC of the local y/m/d gives a day number with no hour in it.
function dayIndex (t) { const d = new Date(t); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS) }
// Day 0 (1970-01-01) was a Thursday, weekday 4, so dayIndex + 4 lines weeks up with getDay().
function weekIndex (t) { return Math.floor((dayIndex(t) + 4 - WEEK_STARTS_ON) / 7) }
function monthIndex (t) { const d = new Date(t); return d.getFullYear() * 12 + d.getMonth() }
function startOfDayIndex (i) { const u = new Date(i * DAY_MS); return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime() }
function startOfIndex (kind, i) {
  if (kind === 'monthly') return new Date(Math.floor(i / 12), i % 12, 1).getTime()
  if (kind === 'weekly') return startOfDayIndex(i * 7 - 4 + WEEK_STARTS_ON)
  return startOfDayIndex(i)
}
function indexOf (kind, t) { return kind === 'monthly' ? monthIndex(t) : kind === 'weekly' ? weekIndex(t) : dayIndex(t) }

// Start of the period `now` falls in, in local time. Every-N periods are blocks of
// N counted from `from`, fixed to the calendar (Tim, 2026-10-31): done late, the
// next one is still due on the usual date. Chosen weekdays: a period runs from the
// start of one chosen day to the start of the next.
function periodStartOf (sched, now) {
  sched = asSchedule(sched)
  if (!sched) return null
  if (sched.days) {
    const today = dayIndex(now)
    for (let back = 0; back < 7; back++) {
      if (sched.days.includes(new Date(startOfDayIndex(today - back)).getDay())) return startOfDayIndex(today - back)
    }
    return startOfDayIndex(today)
  }
  const i = indexOf(sched.kind, now)
  if (sched.every === 1) return startOfIndex(sched.kind, i)
  const f = indexOf(sched.kind, sched.from)
  return startOfIndex(sched.kind, f + Math.floor((i - f) / sched.every) * sched.every)
}

// When the period after the one `now` is in starts.
function nextPeriodStart (sched, now) {
  sched = asSchedule(sched)
  if (!sched) return null
  if (sched.days) {
    const today = dayIndex(now)
    for (let ahead = 1; ahead <= 7; ahead++) {
      if (sched.days.includes(new Date(startOfDayIndex(today + ahead)).getDay())) return startOfDayIndex(today + ahead)
    }
    return null
  }
  const start = periodStartOf(sched, now)
  return startOfIndex(sched.kind, indexOf(sched.kind, start) + sched.every)
}

// The k-th ring after `anchor` (k = 0 is the anchor itself).
function occurrenceAt (anchor, kind, k) {
  const d = new Date(anchor)
  const h = d.getHours(); const mi = d.getMinutes(); const s = d.getSeconds(); const ms = d.getMilliseconds()
  if (kind === 'monthly') {
    const y = d.getFullYear(); const m = d.getMonth() + k
    const last = new Date(y, m + 1, 0).getDate()
    return new Date(y, m, Math.min(d.getDate(), last), h, mi, s, ms).getTime()
  }
  const step = kind === 'weekly' ? 7 : 1
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + step * k, h, mi, s, ms).getTime()
}

// Rings strictly after `now`, soonest first, that `keep` accepts, at most `max`.
// Jumps close to `now` first so an anchor from last year is not stepped through
// one day at a time. The jump undershoots (a 31-day month, two steps of slack)
// and never overshoots, so no ring is skipped.
// `kind` may be a schedule from scheduleOf: every-N steps N periods at a time, and
// chosen weekdays steps daily and keeps only those days.
function occurrencesAfter (anchor, kind, now, max, keep) {
  const sched = asSchedule(kind)
  if (!sched || typeof anchor !== 'number' || !Number.isFinite(anchor)) return []
  const every = sched.every
  const span = (sched.kind === 'monthly' ? 31 * DAY_MS : sched.kind === 'weekly' ? 7 * DAY_MS : DAY_MS) * every
  let k = anchor > now ? 0 : Math.max(0, Math.floor((now - anchor) / span) - 2)
  const out = []
  for (let guard = 0; out.length < max && guard < max + 400; guard++, k++) {
    const t = occurrenceAt(anchor, sched.kind, k * every)
    if (t <= now) continue
    if (sched.days && !sched.days.includes(new Date(t).getDay())) continue
    if (keep && !keep(t)) continue
    out.push(t)
  }
  return out
}

// The next ring after `now`, or null. For the UI label.
function nextOccurrence (anchor, kind, now) {
  return occurrencesAfter(anchor, kind, now, 1)[0] ?? null
}

module.exports = { KINDS, WEEK_STARTS_ON, scheduleOf, repeatRefinement, periodStartOf, nextPeriodStart, occurrenceAt, occurrencesAfter, nextOccurrence }
