# Saved list templates - stop retyping the weekly shop

## Goal

Let someone save a list's contents and start a fresh list from it later, so a weekly
grocery run or a recurring chore set does not have to be retyped item by item.

## Tier

**T2.** New IPC methods and UI, but **no wire change at all**: templates live in the
device's local Hyperbee alongside the item autosuggest recents, and applying one writes
ordinary `list:` and `item:` rows that any peer, old or new, already understands.

## The shape, and why this one

Three shapes were considered. Tim chose **device-local templates**.

1. **Reusable list (rejected).** A flag on the list row, and the existing "All done"
   sheet gains "Start it again", unchecking every item in place. Cheapest synced option,
   but it is the same list reused, so last week's and this week's cannot coexist, and
   there is nowhere to keep a list you run occasionally (a camping trip) without it
   sitting in the space year-round.
2. **Synced templates (rejected for now).** The general answer, but it needs a hidden
   list kind, and an older peer would render a template as an ordinary list until
   everyone updates - a cosmetic fork in a shared space, and the class of thing
   DECISIONS 2026-07-13 and 2026-07-20 both warn about.
3. **Device-local templates (chosen).** No wire surface at all, so nothing can diverge
   between peers and nothing needs a capability gate. The cost is honest and worth
   stating: a template you save is yours alone, and another member cannot use it.

The constraint that shaped all three: `applyListOp` drops keys outside `list:`, `item:`
and `member:`, so a new namespace would make an old peer skip an op a new peer wrote -
divergent views, and Autobase indexers sign the view, so a released space would fork.
Anything synced has to be an additive FIELD on an existing row. Keeping templates off the
wire sidesteps the question entirely.

## Data

One local key, `listTemplates`, holding newest-first:

```
{ id, name, kind, entries: [{ text, qty, category?, catBy?, ord? }], savedAt, updatedAt }
```

Caps: 30 templates, 200 entries each. It stores the list's **shape, not its state**:
never `checked`, never `assignee`, never who created it. Aisle (`category`/`catBy`) and
note-line order (`ord`) do carry, because they are properties of the item rather than of
one particular run.

## Methods

- `template:save { groupId, listId, name? }` - snapshot a list. Saving under a name
  already in use **replaces** it, so refreshing a template after adding an item is one
  tap and does not leave two near-identical entries. Refuses an empty list.
- `template:list` - summaries only (`id, name, kind, count, updatedAt`). The picker never
  needs every entry, and shipping 30 x 200 over IPC on every open would be silly.
- `template:delete { id }`
- `template:apply { groupId, id, name? }` - create a new list plus its items. Deliberately
  does **not** feed the autosuggest recents: that corpus is meant to learn what you type,
  and one application would dump 20 items into it and skew the ranking.

## UI

- **Save:** a "Save as template" row in the list options sheet, tagged "this phone".
  On success the Saved lists sheet opens with it at the top, which is the confirmation.
- **Use:** "Start from a saved list" appears above the add-list bar on the lists
  overview, only when templates exist and the composer is empty, so it never competes
  with typing a name.
- **Copy:** the sheet says "Saved on this phone only. Starting one creates a new list
  that everyone in the space can see." In a shared app, which half is private is exactly
  what people guess wrong about, so it is stated rather than implied.

## Verify

`npm run verify`, plus five tests through the real engine IPC loop: save-then-apply keeps
text, quantity, kind and unchecked state; re-saving replaces; deleted items do not carry;
an empty list is refused; and the replicated view holds nothing but the ordinary list and
item rows, which is the device-local claim made testable.

## Rollback

Delete the `template:*` methods and the two UI entry points. The `listTemplates` key is
local, unreferenced by anything else, and harmless if left behind.

## What this leaves open

Sharing templates across the household is the obvious follow-up, and it is a real feature
request waiting to happen. It should be a synced list `kind` with a capability gate, not
a new namespace, and it wants its own proposal.
