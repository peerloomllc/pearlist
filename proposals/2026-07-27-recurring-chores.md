# 2026-07-27 - Recurring chores: derive, do not reset

**Status:** DRAFT 2026-07-27, awaiting Tim. Follows PR #105 (both phases of
proposals/2026-07-27-reminder-notifications.md, now merged).

**Supersedes** the "recurrence is out of scope, it is a different product" line in
that proposal. That call assumed something has to RESET the item on a timer, which
in a serverless mesh with no leader means every device races to write the same
reset. The design below removes the reset entirely, which removes the reason the
line was drawn.

**Goal**

A chore that comes back. "Take the bins out" is checked off on Tuesday and is open
again next Tuesday, without anyone re-adding it.

**Tier**

T2. Two additive optional fields on the `item:` row plus a pure open-ness rule and
a read-path change. No wire framing, no pairing, no consensus state, no migration.
Same compat argument as `kind`, `notifyOnComplete` and `remindAt`:
`rowApplyDecision` validates only pubkey / updatedAt / sig / namespace,
`applyListOp` stores rows verbatim and every local write path is a
read-modify-write through `signRow` with no field allowlist, so an old build
editing the item PRESERVES the new fields.

One genuine compat hazard, addressed in Risks: an old peer renders a recurring
item as an ordinary one, so its view of "done" diverges from a new peer's. Nothing
forks, but the two disagree on screen.

---

## Problem

1. **Chores repeat, items do not.** A chore board's whole content is work that
   comes back weekly. Today the only way to express that is to re-add the item by
   hand every time, which nobody sustains.
2. **A repeating notification is not the feature.** The obvious cheap version -
   let `remindAt` repeat - is actively wrong here. `isReminderPending` refuses to
   ring for a checked item (finishing early is how you cancel a reminder), so a
   repeating reminder on a completed chore either does nothing at all or has to
   uncheck it. The second is the real feature. The first is a bug with a schedule.
3. **The obvious implementation does not survive the architecture.** "At midnight,
   set `checked: false`" needs someone to run it. There is no server and no
   leader, so every device that happens to be awake writes the same reset. LWW
   converges, so nothing corrupts, but the log churns once per device per period
   forever, and a phone that was off for a month replays a month of resets.

---

## Design

### The idea: open-ness is DERIVED, never written

Store what the schedule is and when the chore was last completed. Whether it is
open right now is computed at read time from those two, plus the clock.

Nothing resets. No timer, no scheduled job, no leader, no extra writes and no
race between devices, because no device ever writes a reset. Checking a chore off
is the ONLY write, and it is the same write that already happens.

### Schema (additive, on the `item:` row)

- `repeat`: one of `daily | weekly | monthly`, or absent for a normal one-shot
  item. A fixed enum, not a cron string: the enum is what a household actually
  wants, and it keeps the period boundary computable in one pure function.
- `lastDoneAt`: epoch ms of the most recent completion. Written by the existing
  toggle path when a recurring item is checked.

`checked` stays exactly as it is on the row, and is IGNORED for recurring items on
the read path (see below). It is not removed, so an old peer still sees something
sane, and a recurring item converted back to one-shot still works.

### The rule (pure, in `src/listWire.js`)

```js
function periodStart (repeat, now)          // -> ms at the start of the current day/week/month
function isRecurringOpen (item, now)        // -> boolean
function effectiveChecked (item, now)       // -> boolean
```

`isRecurringOpen` is the whole feature: a recurring item is OPEN unless
`lastDoneAt >= periodStart(repeat, now)`. Done this period means done; otherwise it
is back.

`effectiveChecked(item, now)` is what every read surface uses instead of
`item.checked`: for a recurring item it is `!isRecurringOpen(...)`, for everything
else it is plain `item.checked`. One seam, so no surface can forget.

Pure and time-injected, like `isReminderPending`, so the period boundaries are
unit-testable without waiting a week.

Local time, not UTC: "this week" means the user's week. `periodStart` therefore
takes the device's timezone, which is the one place recurrence is intentionally
NOT an absolute instant (unlike `remindAt`, which is). Two members in different
timezones can briefly disagree about whether a chore is open. Accepted: a
household is one timezone in practice, and the alternative (a synced timezone on
the space) is a bigger idea than the feature deserves.

### Write path

`item:toggle` gains one branch: checking a recurring item sets
`lastDoneAt = Date.now()` alongside `checked: true`. Unchecking clears
`lastDoneAt` back to the previous period, i.e. it undoes the completion, which is
what "I ticked that by mistake" means.

New method `item:setRepeat { groupId, listId, itemId, repeat }`, a signed RMW like
`item:setReminder`. Setting `repeat` on an already-checked item leaves
`lastDoneAt` absent, so it reads as open immediately - the right default, since
you are declaring it a chore going forward.

### Read surfaces that must switch to `effectiveChecked`

This is the part that is easy to half-do. Every one of these currently tests
`item.checked`:

- `item:getAll` (the list UI, and therefore checkbox state and strike-through).
- `list:openSummary` - the daily digest count. A recurring chore not yet due this
  period is NOT open work and must not inflate the nudge.
- `isReminderPending` - a recurring chore done this period must not ring.
- The `maybeNotify` completion branch's all-done scan (`listWire.js`), which
  currently looks for `!it.checked`.
- The auto-collapse / "all done" sheet logic in the UI.

### Interaction with completion notifications (the question worth deciding)

`maybeNotify` fires `notify:completed` when an item goes `checked: false -> true`.
For a weekly chore that now happens every week, forever.

Proposed: leave it. That is the correct behaviour for a chore board - the parent
DOES want to know the bins went out this week - and the per-list
`notifyOnComplete` mode (`off | each | done`) already exists as the volume knob.
`done` (the default for chore lists) fires once when the last open item flips, so
a weekly cycle produces one ping a week, not one per item.

The one real change: the all-done scan must use `effectiveChecked`, or a list of
weekly chores reads as "all done" for the rest of the week and never re-fires.

---

## Risks + mitigations

- **Old peers disagree on screen.** An old build has no `repeat` handling, so it
  renders the raw `checked` and shows a chore as done for a week that a new build
  shows as open. Nothing forks - both store the identical row - but two phones in
  one household disagree visibly, which reads as a sync bug. Mitigate with the
  advisory `caps` pattern already used for `REVOKE_CAP` (a `repeat1` cap on the
  member row) and a UI note when a member's phone will not honour it. Advisory
  only, never a gate: an old peer cannot corrupt anything here.
- **Missing the seam.** Any read surface still testing `item.checked` silently
  gets the wrong answer for recurring items. Mitigate: `effectiveChecked` is the
  single entry point, a test asserts each of the five surfaces above and the
  worklet never exposes raw `checked` for a recurring item.
- **Concurrent completion.** Two members check the same chore at once. Both write
  `lastDoneAt`, LWW picks one, and both are within the same period, so
  `isRecurringOpen` agrees either way. Genuinely benign, unlike a reset race.
- **Clock skew.** A device with a badly wrong clock computes the wrong period.
  Bounded and self-correcting, and no worse than what `remindAt` already assumes.
- **Scope pressure.** "Every other Tuesday", "weekdays only", "3 times a week"
  will all get asked for. The enum is the line. Anything needing a rule engine is
  a different proposal.

---

## Test plan

Unit (pure, alongside the existing `listWire` tests):

- `periodStart` for daily / weekly / monthly across a month boundary, a year
  boundary and a DST change.
- `isRecurringOpen`: open with no `lastDoneAt`; closed when done inside the
  period; open again one ms after the boundary; unaffected by `checked`.
- `effectiveChecked`: identical to `item.checked` for non-recurring items, so
  nothing existing changes behaviour.
- Round-trip `repeat` + `lastDoneAt` through `rowApplyDecision`, including
  survival of a simulated old-build edit.

Engine (through the real IPC loop):

- `item:toggle` on a recurring item stamps `lastDoneAt`; unchecking clears it.
- `list:openSummary` excludes a chore already done this period and includes it
  after the boundary (inject the clock).
- `reminder:pending` excludes a recurring chore done this period.
- The all-done completion notification re-fires in a new period, and does NOT
  fire twice in the same one.

Manual: two phones, one weekly chore, check it on one and confirm both show it
closed, then confirm it reads open again after the boundary.

---

## Phasing

1. **P1 - the rule and the write path.** `repeat` + `lastDoneAt`,
   `periodStart` / `isRecurringOpen` / `effectiveChecked`, `item:setRepeat`, and
   `item:toggle` stamping. Every read surface switched to the seam. Shippable
   with a minimal UI (a repeat picker in the item sheet).
2. **P2 - presentation.** A "due again Tuesday" line on a closed recurring item,
   a repeat glyph on the row and grouping done-this-period chores below open
   ones.
3. **P3 - the `repeat1` advisory cap** and the member warning, once the feature is
   on real devices and "why does my partner's phone show it done" is a real
   question rather than a hypothetical.

---

## Open questions

- **Does an overdue chore stay overdue, or roll forward?** As specified it rolls:
  miss last week and it is simply open this week, with no memory of the miss.
  Leaning: roll. A guilt ledger is a different product.
- **Should `remindAt` on a recurring item repeat with it?** It would be the
  natural pairing (weekly chore, weekly nudge) and the reconciler already
  reschedules from the row. Leaning: yes in a follow-up, computed as
  `periodStart(next) + the time-of-day of the original remindAt`, so it stays one
  stored instant rather than a second schedule model.
- **Monthly on the 31st.** February has no 31st. Leaning: clamp to the last day of
  the month, which is what every calendar app does.
