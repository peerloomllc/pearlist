// Group a list's items by when their reminder is due (asked for 2026-10-26, "more
// like Apple does it"). Pure and time-injected so every boundary is unit tested.
//
// Groups, in display order:
//   Today       - due before tomorrow, overdue included
//   This week   - the 7 days after today
//   This month  - after that, still in this calendar month
//   Later       - everything further out
//   No reminder
//
// "This week" is a rolling 7 days so it does not empty out on a Saturday. "This
// month" stays a calendar month so its label is literally true; when the week
// crosses into next month, the month group is simply empty.
//
// A repeating item is filed by its occurrence today if it has one, so a daily
// chore that came due this morning still reads as Today. A repeating item already
// ticked off for this round is filed by its next due time.

const { nextOccurrence } = require('./repeatTime')

const GROUPS = ['Today', 'This week', 'This month', 'Later', 'No reminder']

function startOfDay (t, plusDays = 0) {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime()
}

// The time an item is due for grouping purposes, or null for no reminder.
function dueAt (item, now) {
  const at = item && item.remindAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (!item.repeat) return at
  if (item.checked && typeof item.nextDueAt === 'number') return item.nextDueAt
  return nextOccurrence(at, item.repeat, startOfDay(now) - 1) ?? at
}

function groupOf (item, now) {
  const t = dueAt(item, now)
  if (t === null) return 'No reminder'
  if (t < startOfDay(now, 1)) return 'Today'
  if (t < startOfDay(now, 8)) return 'This week'
  const d = new Date(now)
  if (t < new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()) return 'This month'
  return 'Later'
}

// [{ group, items }] for the groups that have items, in display order. Items keep
// their incoming order within a group, except that the dated groups run soonest
// first.
function groupByReminder (items, now) {
  const buckets = new Map(GROUPS.map((g) => [g, []]))
  for (const it of items) buckets.get(groupOf(it, now)).push(it)
  return GROUPS
    .map((group) => {
      const rows = buckets.get(group)
      if (group !== 'No reminder') rows.sort((a, b) => dueAt(a, now) - dueAt(b, now))
      return { group, items: rows }
    })
    .filter((g) => g.items.length > 0)
}

module.exports = { GROUPS, dueAt, groupOf, groupByReminder }
