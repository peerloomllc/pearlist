// When-to-remind presets. Pure and time-injected, so every boundary is unit
// tested rather than eyeballed on a phone at 11pm.
//
// WHY PRESETS AND NOT A WHEEL (Tim's call, 2026-07-27): a spinning wheel exists
// because a calendar app must express any instant. A shared list mostly does not.
// Nearly every reminder someone sets is "in an hour", "this evening" or "tomorrow
// morning", and a row of taps beats any wheel for those - fewer taps, no drag
// gesture to get right, identical on both platforms, and buttons with labels are
// trivially screen-readable where a custom wheel is not. The exact-time fallback
// covers the rest.

const HOUR_MS = 60 * 60 * 1000

// Morning / evening are the app's opinion, not the user's. Kept here as named
// constants so the copy and the maths can never drift apart.
const MORNING_HOUR = 9
const EVENING_HOUR = 18

function atLocal (now, dayOffset, hour, minute = 0) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour, minute, 0, 0).getTime()
}

// The choices offered for a single item's reminder. Anything already past is
// dropped rather than shown greyed out: an option you cannot pick is noise, and
// "This evening" at 9pm is a bug the user has to notice.
function itemPresets (now) {
  const out = [
    { key: 'hour', label: 'In an hour', at: now + HOUR_MS },
    { key: 'evening', label: 'This evening', at: atLocal(now, 0, EVENING_HOUR) },
    { key: 'tomorrowAm', label: 'Tomorrow morning', at: atLocal(now, 1, MORNING_HOUR) },
    { key: 'tomorrowPm', label: 'Tomorrow evening', at: atLocal(now, 1, EVENING_HOUR) },
    { key: 'week', label: 'Next week', at: atLocal(now, 7, MORNING_HOUR) },
  ]
  return out.filter((p) => p.at > now)
}

// Time-of-day choices for the daily digest. No filtering: this one repeats every
// day, so a time earlier than now simply means "starting tomorrow".
function dailyPresets () {
  return [
    { key: 'morning', label: 'Morning', hour: 8, minute: 0 },
    { key: 'midday', label: 'Midday', hour: 12, minute: 0 },
    { key: 'evening', label: 'Evening', hour: EVENING_HOUR, minute: 0 },
    { key: 'night', label: 'Night', hour: 21, minute: 0 },
  ]
}

// Split so the caller can style the day and the time differently, and so tests
// can assert the part that is not locale-dependent.
function describeWhen (ms, now) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const d = new Date(ms)
  const today = atLocal(now, 0, 0)
  const tomorrow = atLocal(now, 1, 0)
  const dayAfter = atLocal(now, 2, 0)
  let day
  if (ms < today) day = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  else if (ms < tomorrow) day = 'Today'
  else if (ms < dayAfter) day = 'Tomorrow'
  else if (ms < atLocal(now, 7, 0)) day = d.toLocaleDateString([], { weekday: 'long' })
  else day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return { day, time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
}

// --- exact-time fallback -----------------------------------------------------
// Steppers rather than a wheel: no gesture to tune, and each control is a plain
// labelled button.
const MINUTE_STEP = 5

// Nudge a chosen instant by whole days, keeping the time of day. Built from date
// parts so a DST day is still "the same clock time tomorrow".
function stepDays (ms, days) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), 0, 0).getTime()
}

// Step the time of day WITHOUT letting it roll the date: stepping past midnight
// from 23:55 wraps to 00:00 the same day, which is what someone adjusting a time
// field expects. Changing the day is what the day stepper is for.
function stepMinutes (ms, deltaSteps) {
  const d = new Date(ms)
  const mins = d.getHours() * 60 + d.getMinutes()
  const snapped = Math.round(mins / MINUTE_STEP) * MINUTE_STEP
  const next = ((snapped + deltaSteps * MINUTE_STEP) % 1440 + 1440) % 1440
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(next / 60), next % 60, 0, 0).getTime()
}

// A sane starting point for the exact picker when nothing is set yet: the next
// whole hour, which is both in the future and a round number.
function defaultExact (now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime()
}

module.exports = {
  itemPresets, dailyPresets, describeWhen, stepDays, stepMinutes, defaultExact,
  MINUTE_STEP, MORNING_HOUR, EVENING_HOUR,
}
