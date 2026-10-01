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
function occurrencesAfter (anchor, kind, now, max, keep) {
  if (!KINDS.includes(kind) || typeof anchor !== 'number' || !Number.isFinite(anchor)) return []
  const span = kind === 'monthly' ? 31 * DAY_MS : kind === 'weekly' ? 7 * DAY_MS : DAY_MS
  let k = anchor > now ? 0 : Math.max(0, Math.floor((now - anchor) / span) - 2)
  const out = []
  for (let guard = 0; out.length < max && guard < max + 400; guard++, k++) {
    const t = occurrenceAt(anchor, kind, k)
    if (t <= now) continue
    if (keep && !keep(t)) continue
    out.push(t)
  }
  return out
}

// The next ring after `now`, or null. For the UI label.
function nextOccurrence (anchor, kind, now) {
  return occurrencesAfter(anchor, kind, now, 1)[0] ?? null
}

module.exports = { occurrenceAt, occurrencesAfter, nextOccurrence }
