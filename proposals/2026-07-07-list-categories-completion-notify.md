# 2026-07-07 - List categories + completion notifications

**Status:** APPROVED 2026-07-07 (Tim). Backlog item #5 (member-mapped assignees +
notify-the-assignee), completion half. Decisions locked: completion notifications
target the list overseer (`list.assignee`) only; granularity is a per-list
user choice (`off | each | done`). **P1 (categories, presentation-only) and P2
(completion notifications) both built on `feature/list-categories`.** Note:
notifications were also flipped to ON by default in the same branch (reverses
the 2026-06-30 opt-in policy; see DECISIONS 2026-07-07).

**Goal**

Give a list a **kind** (grocery, chore, to-do, generic) so the Lists page can
group and style lists by purpose, and use that kind to close the chore loop:
today a parent assigns a chore and the child is notified (`notify:assigned`
already fires); this adds the return leg, so when a child completes a chore the
list overseer is notified (`notify:completed`).

**Tier**

T2. Additive, app-local. It touches PearList's own `list:` record schema and the
`maybeNotify` policy in `src/listWire.js` plus the UI, but NOT `@peerloom/core`,
the wire framing, or pairing. The new `list.kind` / `list.notifyOnComplete`
fields are optional signed fields on an existing record: `rowApplyDecision` only
validates pubkey/updatedAt/sig/namespace, so old peers accept and ignore them and
new peers tolerate their absence. Last-writer-wins as with every other field. No
migration, forward and backward compatible.

---

## Problem

1. Every list looks and behaves the same. A household has groceries, chores, and
   to-dos in one space with no way to tell them apart or organize them, and the
   Lists page is a flat undifferentiated list of lists.
2. The notification loop is one-directional. `maybeNotify` fires `notify:assigned`
   to the assignee when someone assigns them an item or a whole list, but nothing
   fires when work is done. On a chore board the useful signal is exactly the
   missing one: the overseer wants to know a chore got completed.

The assignee plumbing this builds on already exists: `item:assign` / `list:assign`
store a member **pubkey** (not free text), and `maybeNotify` already computes
notifications on the recipient's own device during apply by comparing
`value.assignee === selfKey`. This proposal adds a second trigger in the same
place, it does not rework assignment.

---

## Design

### Schema (additive, on the `list:` record)

- `kind`: enum string, one of `grocery | chore | todo | list`. Default `list`
  (generic) when absent, so existing lists render unchanged. Chosen from a UI
  selector, NEVER inferred from the list name (keying behavior off a free-text
  name would be brittle: a "Kids jobs" list must still get chore behavior).
- `notifyOnComplete`: enum string, one of `off | each | done`. Per-list
  granularity toggle (Tim's call: user chooses per list).
  - `each`: notify the overseer on every item completion.
  - `done`: notify the overseer once, when the LAST open item flips to checked
    ("Chores all done").
  - `off` / absent: no completion notification.
  Defaults to `done` when a list is set to `kind: chore`, `off` otherwise. The
  overseer is `list.assignee` (Tim's call: overseer-only, no createdBy fallback).

No new IPC methods for the schema: `list:create` gains optional `kind`, and a
small `list:setKind` / reuse of the existing rename/assign path carries
`kind` + `notifyOnComplete`. Reads (`list:getAll`) already return the whole row,
so the fields flow to the UI for free.

### Notification mechanics (`maybeNotify` in `src/listWire.js`)

Fits the existing model exactly: each device, applying a synced op, asks "is this
relevant to ME?" and emits locally. So the overseer's own device raises the
completion notification when it applies the child's `item:toggle`.

Add one branch, gated the same way as the existing assignment branch (fresh
within `NOTIFY_FRESH_MS`, not our own change, not a delete):

- The op is an `item:` row that went `checked: false -> true`
  (`value.checked && !(existing && existing.checked)`).
- Read the parent list once: `const list = (await view.get('list:' + listId))?.value`.
- If `list.kind === 'chore'`, `list.assignee === selfKey` (I am the overseer),
  and `value.pubkey !== selfKey` (someone else did it):
  - `notifyOnComplete === 'each'` -> emit `notify:completed`
    `{ text, by: value.pubkey, groupId, listId }`.
  - `notifyOnComplete === 'done'` -> also read the item range for this list and
    emit only if every non-deleted item is now checked (all done), with an
    `allDone: true` flag so the shell can phrase it as a list-level celebration.

This requires `maybeNotify` to become `async` and be `await`ed (or fire-and-
forget with a `.catch`) in `applyListOp`; it currently runs un-awaited. The extra
reads are cheap `view.get` / range scans on the already-linearized Hyperbee view.

Field mapping (no new identity concepts, consistent with the egalitarian model):
- `item.assignee` = the doer (child).
- `list.assignee` = the overseer (parent) and the completion-notify target.

### UI

- Kind selector on list create + list settings; kind icon + color on the Lists
  page; group or filter the Lists page by kind.
- Completion-notify granularity control (`off / each / done`) on a chore list's
  settings, defaulting to `done`.
- New `notify:completed` handled by the shell exactly like `notify:assigned`:
  deep-link the tap to the list, respect the existing opt-in toggle, no new
  permission surface.

---

## Risks + mitigations

- **Notification spam.** Per-item completion on a busy list is noisy. Mitigate:
  default chore lists to `done` (one "all done" ping), make `each` an explicit
  opt-in, and reuse the existing per-device notification opt-in.
- **Background delivery gates the payoff.** Completion notifications inherit the
  current limit: they fire only while the recipient's app runs (Android has the
  bg-sync foreground service; iOS does not). A child->parent ping is most useful
  when the parent's app is closed, so this feature is partially blocked on the
  background-while-killed work (backlog #4). Ship it anyway (it works in-app and
  on Android bg-sync), and note the limitation in the UI copy.
- **No role enforcement.** "Parent/overseer" is pure convention via
  `list.assignee`, not an enforced permission. Consistent with the shared-list
  philosophy (any member edits anything); enforcing roles would be a much larger
  T3 change and is explicitly out of scope.
- **`maybeNotify` becoming async.** Small refactor; ensure a rejected read never
  breaks apply (wrap in try/catch, same as the current `emit` calls).

---

## Test plan

- Unit (pure, no live Autobase, as `listWire` tests already run):
  - `kind` / `notifyOnComplete` round-trip through `rowApplyDecision` (accepted,
    LWW, ignored-when-unknown on an old-schema peer simulated by a row without
    the fields).
  - `maybeNotify` emits `notify:completed` iff kind=chore, I am `list.assignee`,
    item went false->true, and someone else did it; suppressed for own change,
    non-chore, wrong overseer, unchecking, and stale (outside the freshness
    window).
  - `done` mode emits only when the last open item is checked; not before.
- Two-peer integration: parent sets a chore list with an assignee = self and
  `notifyOnComplete=done`; child (other peer) checks items; assert the parent
  peer emits exactly one `notify:completed allDone` when the last one flips.
- Manual on-device: chore list across two phones, confirm the assign->complete
  loop end to end and the deep-link.

---

## Phasing

1. **P1 - categories (presentation only).** `kind` field + Lists-page grouping,
   icons, and per-kind composer defaults. Zero notification change, pure UX win,
   lowest risk. Shippable on its own.
2. **P2 - completion notifications.** `notifyOnComplete` + the `maybeNotify`
   branch + shell handling of `notify:completed`. Closes the chore loop.
3. **Later (out of scope, tracked in backlog):** recurring / due chores, points
   or allowance tally, a parent "approve" step. Bigger lifts, several depend on
   background delivery (#4).

---

## Open questions

- Do we want a per-item completion notification at all in v1, or ship `done`-only
  first and add `each` if asked? (Leaning: include both since the toggle is cheap
  and Tim asked for user choice.)
- Should `kind` also drive item fields (e.g. a chore item surfaces a due date
  field) or stay presentation-only in P1? (Leaning: presentation-only in P1;
  due dates belong with the recurring-chores work.)
- Fixed kind enum vs user-defined categories with a color. (Leaning: fixed enum
  for v1 so behavior can key off it safely; user-defined labels can layer on
  later as a pure-presentation tag.)
