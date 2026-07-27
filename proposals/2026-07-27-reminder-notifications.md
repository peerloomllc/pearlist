# 2026-07-27 - Reminder notifications (daily digest + per-item)

**Status:** DRAFT 2026-07-27, awaiting Tim. Covers BOTH phases in one document
(Tim's call), so the date model is decided once rather than twice. P1 is the
"quiet once-a-day digest" the 2026-06-30 notifications policy already earmarked
as a later opt-in.

**Goal**

Two opt-in, **time-triggered** reminders:

1. **P1 - daily digest.** Once a day, at a time the user picks, a nudge about
   lists that still have open items.
2. **P2 - per-item reminder.** A reminder set on one item, firing at a chosen
   time on exactly one household member's phone.

**Tier**

- **P1: T1.** Device-local setting, no schema, no wire change, no new IPC on the
  replicated path. Pure shell + a read-only summary query.
- **P2: T2.** One additive optional field on the `item:` row (`remindAt`), plus a
  pure fire-target rule in `src/listWire.js`. Same compat argument as `kind` and
  `notifyOnComplete`: `rowApplyDecision` validates only pubkey / updatedAt / sig /
  namespace, `applyListOp` stores rows verbatim and every local write path is a
  read-modify-write (`{ ...existing, patch }`) through `signRow`, which has no
  field allowlist. So an **old build editing the item preserves `remindAt`**
  rather than dropping it. Old peers accept and ignore, new peers tolerate its
  absence, last-writer-wins as with every other field. No migration, forward and
  backward compatible, no fork risk.

Not T3: no wire framing, no pairing, no consensus state.

---

## Problem

1. **Every notification PearList raises today is event-triggered.** `maybeNotify`
   runs inside `applyListOp`, so a notification exists only because a peer's op
   arrived and we were alive to apply it. DECISIONS 2026-07-07 closed
   "notifications while the app is killed" as WON'T-FIX for exactly that reason,
   and on iOS there is no serverless fix.
2. **A chore board's most useful signal is that nothing happened.** No op means
   no notification, ever. Today the app can tell you a chore got done and cannot
   tell you one did not.
3. **The digest is already on the roadmap.** DECISIONS 2026-06-30: "A quiet
   once-a-day digest is a possible later opt-in, not in v1." This is that item.

### Why the 2026-07-07 WON'T-FIX does not block this

That decision is about notifications whose *trigger* is a peer's change
arriving. This proposal's trigger is a **clock**. A local scheduled notification
is handed to the OS in advance (UNUserNotificationCenter on iOS, AlarmManager on
Android, both via the `expo-notifications` we already ship) and the OS delivers
it whether or not our process exists. No Hyperswarm connection, no wake-up, no
APNs, no server.

That makes reminders the **only** notification class that behaves identically on
Android and iOS today. The event-driven ones are Android-strong and iOS-weak,
and nothing in this proposal changes that.

Delivery is strictly device-local. Nothing crosses the wire at fire time; P2
syncs only the *intent* (a timestamp on an item), the same way an assignee
syncs.

---

## Design

### P1 - daily digest

**Setting (device-local, NOT synced).** `pearlist:dailyReminder` in AsyncStorage
alongside `pearlist:notifications` and `pearlist:bgsync`:
`{ enabled: boolean, hour: number, minute: number }`. Default `enabled: false`.

Not synced on purpose: it is a per-device preference like the existing
notification and bg-sync toggles. Syncing it would mean one member's 07:00 nudge
waking the whole household.

**Default OFF.** This is the one place not to follow the 2026-07-07 "ON by
default" reversal. Event notifications are ON by default because each one is a
consequence of something a human just did. An unsolicited daily buzz nobody
asked for is the classic uninstall trigger, and the App Store review note in
DECISIONS 2026-07-07 already flags cold-start prompts as a sensitivity.

**Master toggle still wins.** Gated by `_notifEnabled` exactly like `fireNotify`,
plus a new Android channel `reminder` ("Daily reminders") in
`ensureNotifPermission`, so a user can mute reminders without muting
assignments.

**Scheduling.** One `Notifications.scheduleNotificationAsync` with a daily
repeating trigger, under a stable identifier (`pearlist:daily`), cancelled and
re-scheduled whenever the setting or the content changes. One slot, forever.

**What it counts.** A new read-only worklet method `list:openSummary` returns
`{ total, lists: [{ listId, name, kind, open }] }` across every joined space,
counting non-deleted, unchecked `item:` rows.

**It MUST exclude `kind: 'note'` lists.** Note lists store one item row **per
line** of the note (proposals/2026-07-20-note-lists.md), and those rows are never
checked. Counting them would report a two-paragraph shopping note as ~20 open
tasks and make the digest useless. Chore and todo lists lead the ordering,
grocery next, generic last.

**Content freshness (the honest limitation).** A scheduled notification's body
is frozen when it is scheduled, so a count can go stale. Mitigation, in order:

- Recompute and re-schedule on every foreground, and on Android additionally
  from the bg-sync foreground service whenever an op batch changes an open
  count. On Android the digest is therefore essentially live.
- On iOS, if the app has not run since the last change, the counts are as of the
  last run. The failure mode is "says 3 open when 1 is left", or at worst "says
  there is work when someone else finished it all".
- Copy is written to survive that: "Groceries and 2 more lists have open items"
  rather than a hard count sentence, and the tap deep-links into the list where
  the truth is visible immediately.

If the last computed total is zero, the digest is **cancelled**, not scheduled
with a "nothing to do" body. A daily "you have nothing to do" is pure noise.

**Tap handling.** Reuses the existing `notify:open` path: the digest carries
`{ groupId, listId }` for the top list (or `listId: null` for the Lists page),
and `addNotificationResponseReceivedListener` already routes it.

**UI.** Profile / Settings, under the existing notification toggle: a "Daily
reminder" switch and a time picker. One new shell IPC pair,
`shell:reminder:get` / `shell:reminder:set`, matching
`shell:notifications:get` / `shell:notifications:set`.

### P2 - per-item reminders

**Schema (additive, on the `item:` row).**

- `remindAt`: epoch milliseconds (UTC), or absent/null for none. Deliberately
  **not** named `dueAt`: it is a reminder, not a deadline, and nothing later
  should read it as one (see Out of scope).

No new sorting semantics, no overdue styling, no list-level rollup. One field.

`rowApplyDecision`'s `FUTURE_TS_TOLERANCE_MS` guard applies to `updatedAt` only,
so a `remindAt` a year out is accepted normally. Confirmed against the current
code, not assumed.

**Who fires it (the anti-spam rule).** A new pure function in `src/listWire.js`,
mirroring `effectiveNotifyMode`, so it is unit-testable without an Autobase:

```js
function reminderTargetOf (item, list) // -> pubkey | null
```

Resolution order, first hit wins:

1. `item.assignee` - the person who owns this specific job.
2. `list.assignee` - the person the whole list belongs to.
3. `list.createdBy` - whoever set the list up, as the backstop.

Exactly one pubkey by construction, so exactly one device fires. A parent
setting a reminder on a kid's chore reaches the kid's phone and nobody else's.
Without this rule every member's phone buzzes for every reminder, which is the
single fastest way to get the app muted.

**Scheduling lifecycle (a reconciler, NOT `maybeNotify`).** `maybeNotify` is the
wrong place: it deliberately ignores anything outside a 60s freshness window so
catch-up sync does not replay history as alerts, and a reminder set last week is
exactly the row it would skip.

Instead, a reconciler runs on (i) worklet ready, (ii) app foreground, (iii) any
applied op touching an `item:` row with a `remindAt`. It:

- reads every non-deleted, unchecked item with `remindAt` in the future where
  `reminderTargetOf(...) === selfKey`,
- diffs that against `Notifications.getAllScheduledNotificationsAsync()`, keyed
  by a stable identifier equal to the item key (`item:{listId}:{itemId}`), so
  cancel is exact and never guesses,
- schedules and cancels the delta.

Idempotent by construction, so running it too often is free.

**iOS 64-notification cap.** iOS keeps at most 64 pending local notifications per
app and silently drops the rest. The reconciler therefore schedules only the
**32 soonest** reminders and refills as they fire, leaving generous headroom plus
one slot for the daily digest. Per CLAUDE.md, a cap that silently drops work is
worse than one that says so: when the reconciler truncates, it logs the count it
skipped.

**Capability advertisement (advisory, not a gate).** Reuse the existing `caps`
array on the `member:` row (`REVOKE_CAP` established the pattern) with a
`remind1` cap. If the resolved target's member row lacks it, the setter's UI says
"Sam's phone is on an older version and will not get this reminder."

This is **not** a consensus gate like revocation. An old peer ignoring
`remindAt` cannot fork the space, it just never rings, and a silent never-rings
is the failure a user cannot debug. Advisory only, so it must never block the
write.

**UI.** Item overflow menu -> "Remind..." with a date + time picker; a small bell
chip on items carrying a reminder, showing the local time; clearing sets
`remindAt: null`. New worklet method `item:setReminder { groupId, listId,
itemId, remindAt }`, a signed read-modify-write exactly like `item:assign`.

**Timezones.** Stored as an absolute epoch, rendered local. A reminder set by
someone in another timezone fires at the same instant everywhere, which is the
right behavior for a household and avoids a floating-local-time model nobody
asked for.

---

## Out of scope (the scope-creep line)

Deliberately excluded, each its own proposal if ever wanted:

- **Recurrence / repeating chores** ("bins every Tuesday"). This is a different
  product: it needs a schedule model, next-occurrence computation and catch-up rules
  for missed occurrences, and it collides hard with the iOS 64-notification cap.
  This is the line. `remindAt` is a single instant and must stay one.
- **Snooze.** Needs a mutable per-device reminder state that is not the synced
  field, and it multiplies the stale-reminder problem below.
- **A due-date model.** No overdue styling, no sorting by date, no list rollup.
  Hence the `remindAt` name.
- **Any server-driven push.** Unchanged: rejected, per DECISIONS 2026-07-07.

---

## Risks + mitigations

- **Stale reminders for already-done items.** A scheduled notification can only
  be cancelled by the device that scheduled it. If your phone is asleep for two
  days and someone else checks the item off, your reminder still fires for a done
  chore. Mitigate: soft copy, and the tap deep-links to the item so the true
  state is one tap away. Accepted, not chased - chasing it needs the background
  delivery that 2026-07-07 already closed.
- **Digest counts drift on iOS.** Covered above. Bounded, self-healing on the
  next foreground, and the copy is written not to over-claim.
- **Notification fatigue.** Digest default OFF; exactly one device fires each
  item reminder; both ride the existing master toggle; separate Android channel
  so reminders can be muted alone.
- **The reconciler thrashing.** Diff-based and keyed by item key, so a no-op run
  issues no OS calls. Debounce the op-triggered run.
- **Note lists inflating the digest.** Excluded explicitly, with a unit test that
  fails if a note list ever counts.
- **Old peers never ringing.** Advisory `remind1` cap + UI warning. Cannot fork.

---

## Test plan

Unit (pure, alongside the existing `listWire` tests):

- `remindAt` round-trips through `rowApplyDecision`: accepted, LWW, tie-broken,
  tolerated when absent and preserved across a simulated old-build edit that
  spreads the existing row.
- `reminderTargetOf` resolution order: item assignee > list assignee > creator;
  `null` when the list is gone; unaffected by `checked` (the caller filters).
- `list:openSummary` excludes note-kind lists, deleted rows, checked rows and
  tombstones; counts across multiple spaces.

Integration (two peers):

- Peer A sets `remindAt` on an item assigned to peer B. Assert B resolves itself
  as target and A does not, and that a third peer C also does not.
- Peer A clears the reminder; assert B's reconciler cancels.

Manual, per CLAUDE.md rule 7 (say which device, they are different claims):

- **iPhone Simulator:** schedule, fire, tap, deep-link and the reconciler's
  cancel path. Scheduled local notifications do not need the real device.
- **iPhone SE (USB):** the actual claim under test is "fires with the app
  killed". Verify with the app swiped away, which the Simulator does not model
  honestly. Also verify the 32-cap truncation logs.
- **TCL:** Android channel muting, digest refresh from the bg-sync service and
  a reboot (AlarmManager survival).

`npm run verify` green before any PR, per the Constitution.

---

## Phasing

1. **P1 - daily digest.** Device-local setting, `list:openSummary`, one
   scheduled notification, Profile UI. T1, no wire change, shippable alone. It
   also proves the scheduled-notification path on iOS before anything larger
   rides on it.
2. **P2a - `remindAt` + `reminderTargetOf` + reconciler.** T2. The schema, the
   pure rule, the unit tests and the scheduling, behind the item UI.
3. **P2b - the `remind1` cap warning.** Small, additive, and only worth doing
   once P2a is on real devices and the "why did it not ring" question is real.

Ship 1 and 2 as separate PRs. They share no code beyond the Android channel.

---

## Open questions

- **Digest scope: everything, or only mine?** Leaning: everything open across all
  spaces, because a household board is shared and "mine" is often empty by
  design. An "only items assigned to me" switch is a cheap follow-up if the
  full-household version feels noisy.
- **Digest copy: counts or count-free?** Leaning: name the top list and count the
  rest ("Groceries and 2 more lists have open items"), which degrades gracefully
  when stale. A hard "7 items left" reads as a bug the moment it is wrong.
- **Should a fired item reminder also clear `remindAt`?** Leaning: no. Clearing
  it is a synced write from one device on a timer, which will race across
  devices and rewrite rows nobody touched. Leave the value and let the UI show
  past reminders as spent.
- **One reminder per item, or several?** Leaning: one. Several needs an array and
  an id per entry, and it is the first step toward the recurrence model this
  proposal exists to keep out.
