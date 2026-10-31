# 2026-10-31 - More repeat schedules: every N periods and chosen weekdays

**Status:** APPROVED by Tim 2026-10-31, calendar-fixed periods confirmed. Builds on
proposals/2026-07-27-recurring-chores.md (P1 shipped in PR #107).

**Goal**

Two new kinds of repeat, picked by Tim on 2026-10-31:

1. **Every N days, weeks or months.** Bins every other week, a filter every 3 months.
2. **Chosen weekdays.** Mon, Wed and Fri, or weekdays only.

Yearly and "first Saturday of the month" were offered and not picked.

**Tier**

T2. Three optional fields on the `item:` row, a change to the pure rules in
listWire.js and repeatTime.js, and the Repeats picker. No wire framing, no pairing, no
consensus state, no migration. Same argument as the original proposal:
`rowApplyDecision` checks only pubkey / updatedAt / sig / namespace, rows are stored
as written, and every write path is a read-modify-write with no field allowlist, so
an old build that edits the item keeps the new fields.

---

## Design

### Storage

`repeat` keeps its three values. The new schedules are stored as that value plus a
refinement, so an old build still sees a repeat it understands:

| Schedule | `repeat` | `repeatEvery` | `repeatDays` | `repeatFrom` |
| --- | --- | --- | --- | --- |
| Every 2 weeks | `weekly` | `2` | - | start of the week it was set |
| Every 3 months | `monthly` | `3` | - | start of the month it was set |
| Every 4 days | `daily` | `4` | - | start of the day it was set |
| Mon, Wed, Fri | `daily` | - | `[1, 3, 5]` | - |

Plus `repeatFor`: the `repeat` value the refinement was written for. If an old build
later changes `repeat` through its own picker, it leaves the refinement fields in
place. A new build ignores any refinement whose `repeatFor` does not match `repeat`,
so "every 2 weeks" changed to "every day" on an old phone becomes every day, not
every 2 days.

Validation at read time, in `normalizeRepeat`'s neighbour:
- `repeatEvery`: an integer 2 to 99. Anything else means 1.
- `repeatDays`: weekday numbers 0 (Sunday) to 6, deduplicated, at least one and fewer
  than seven. Only read when `repeat` is `daily` and there is no `repeatEvery`.
- `repeatFrom`: a finite epoch ms. Missing means the item's `createdAt`.

### When a chore is open

Unchanged rule: open unless it was done inside the current period. Only the period
changes.

- **Every N.** Periods are blocks of N days, weeks or months counted from
  `repeatFrom`, on the calendar. Done in the block, closed until the next block
  starts. Fixed to the calendar (bins every other Tuesday stay on the same Tuesdays
  even when done late), which also matches when its reminder rings.
- **Chosen weekdays.** A period starts at the start of each chosen day and runs to
  the start of the next chosen day. A Monday chore not done on Monday stays open on
  Tuesday, then a new period starts Wednesday. Done on Monday, it is closed until
  Wednesday.

`nextDueAt` ("Back on Wednesday") follows the same periods.

### Reminders

`occurrencesAfter` steps by N periods instead of one, and for chosen weekdays steps
day by day keeping only the chosen days. Same time of day as the first reminder, same
DST-safe date-part arithmetic.

### Picker

The Repeats select becomes a row that opens a sheet: Never, Every day, Every week,
Every month, then "Every..." (a number stepper plus day / week / month) and "On
days..." (seven weekday toggles). The row label reads like the schedule: "Every 2
weeks", "Mon, Wed, Fri", "Weekdays".

### Backup

spaceBackup.js carries all four new fields (its CARRY/DROP table must say so, per the
TODO rule about keeping it in step with listWire).

## Old builds

An old build sees `repeat` alone, so the chore still repeats there, just more often:
"every 2 weeks" shows as weekly and "Mon, Wed, Fri" as daily. Ticking it off on an
old phone still records `lastDoneAt`, so new phones count it as done. The two
disagree only about whether the chore is open on the in-between days or weeks.
Nothing forks.

## Risks

- **The in-between disagreement above.** Small, visible only on mixed versions, and
  gone once everyone updates. The original proposal's P3 (a capability flag plus a
  warning) would cover this too if it ever matters.
- **An anchor that moves.** `repeatFrom` is written once when the schedule is set and
  left alone after, so editing the item's text or reminder does not shift the blocks.
  Changing the schedule itself resets it, which is what a person expects.

## Out of scope

Yearly, nth weekday of the month, end dates, "after N times".

## Phasing

One PR: the rules with unit tests (DST weeks, month ends, weekday wrap, a stale
refinement after an old-build edit), reminder stepping, the picker and backup.
