# Note lists (free-text notes that are not a checklist)

## Goal

Let a household keep a shared free-text note - the wifi password, a recipe, what
the plumber said - alongside its checklists, syncing over the same space, with
two people able to edit the same note without one of them silently losing their
text.

## Tier

T2. One new value in an EXISTING enum (`LIST_KINDS`) plus one new additive field
(`ord`) on the EXISTING `item:` rows. No new Hyperbee namespace, no new topic,
no IPC method whose absence breaks an old peer, no pairing or crypto change.

Not T3: nothing here changes what an old peer will accept, and no old peer is
forced to interpret anything new. See Compat.

## Context

A user asked for "somewhere to put notes that aren't a check list" and sent a
Google Keep screenshot. The gap is real and narrow.

Items already carry a `note` field (`item:edit` in `src/listMethods.js:591`,
capped at 2000 chars, rendered muted under the item text at
`src/ui/App.jsx:506`). So per-ITEM notes exist. What does not exist is a note
that is not attached to an item, which today forces you to invent a fake
checklist item to hang the text on.

Three facts in the existing code shape the design.

1. **Lists already have a `kind`.** `LIST_KINDS = ['grocery','chore','todo','list']`
   in `src/listWire.js`, driving icon, colour and the Lists-page section via
   `CATEGORIES` in `src/ui/App.jsx:39`. A note is a fifth kind, not a new
   top-level concept.

2. **A new Hyperbee namespace would fork released peers.** `applyListOp` drops
   any key outside `NAMESPACES`, so a `para:` namespace would make an old peer
   SKIP the op while a new peer `put()`s it. Divergent views, and Autobase
   indexers sign the view, so a released space forks. This is written up in the
   `listWire.js` header and it is the binding constraint here: note paragraphs
   MUST live under the existing `item:` prefix.

3. **Item order is device-local today.** `itemOrder` is a per-device preference
   (the 2026-07-11 hybrid decision); the shared fallback is `createdAt`
   (`src/ui/App.jsx:803`). That is fine for a shopping list and wrong for a
   note, where inserting a paragraph in the middle must look the same on every
   device.

### Why paragraph rows and not one text blob

The obvious cheap build is a single `body` string on the `list:` row. Rejected.
Every row in this app is last-writer-wins (`rowApplyDecision`), so a whole-note
blob means two people editing the same note at once and the later save silently
erases the earlier one's paragraphs. A checklist does not have this problem
because its unit of conflict is one short item; a note as one blob makes the
unit of conflict the entire document, and a shared note is exactly the thing two
people are likely to be typing into simultaneously.

Splitting the note into one row per paragraph keeps LWW but shrinks the conflict
unit back to a paragraph. Edit paragraph 3 while I edit paragraph 7 and both
survive. Only a genuine same-paragraph collision loses text, which is the same
exposure a checklist item already has and which users already tolerate.

## Scope

### Data model

A note is a `list:` row with `kind: 'note'`. Its paragraphs are ordinary `item:`
rows under that list, with one new optional field:

```
list:{listId}         -> signed { ..., kind: 'note' }          // new enum value
item:{listId}:{id}    -> signed { ..., ord?: string }           // NEW, optional
```

`ord` is a fractional index (a short sortable string): to insert between two
paragraphs, generate a string that sorts between their `ord`s, so an insert
touches ONE row rather than renumbering the note. Rows sort by `ord` when
present, falling back to `createdAt`, which is the existing tiebreak.

For note lists the paragraph row reuses `text` and leaves `qty`, `checked`,
`assignee`, `category` and `catBy` at their defaults. Nothing new is needed for
them.

### Editing: three-way diff, not overwrite

The editor is a single textarea (title + body, Keep-like). On save we do not
rewrite the note; we diff.

1. On open, load the paragraph rows and keep them as the **baseline**.
2. The user edits freely. Remote changes do NOT re-hydrate the textarea while it
   is dirty, so nobody's cursor jumps mid-sentence.
3. On save (debounced idle, plus on blur and on close), split the textarea into
   paragraphs, LCS-diff it against the baseline, and apply the resulting
   insert / update / delete operations against a FRESHLY read row set.

Because the operations are derived from `baseline -> my text` and applied to
current rows, a paragraph a peer added while I was typing is not in my baseline,
so my save never tombstones it. That is the whole point of diffing rather than
overwriting.

The diff is pure and lives beside `listWire.js` so it unit-tests without an
Autobase, same as the merge rules do.

### IPC

No new methods are strictly required - `item:add`, `item:edit` and `item:delete`
already do the work. Two adjustments:

- `item:add` gains an optional `ord`, and **skips `recordRecent`** for note
  lists. Without this, note prose pollutes the grocery autosuggest corpus
  (`itemRecents`, `src/listMethods.js:104`). This is a real bug we would
  otherwise ship.
- Add `note:save` as a single batched call taking the diffed operations, so one
  save is one round trip instead of N.

### UI

- Fifth entry in `CATEGORIES` (`src/ui/App.jsx:39`): key `note`, section
  `Notes`, a note icon. Needs a new colour token: `success` green, `warn`
  orange, `accent` cyan and `text.muted` are all taken and per the closed
  `c.accent` audit in `TODO.md` none of them may be reused. Add
  `--color-note` (warm yellow) to `THEME_VARS` in `src/ui/theme.js` for both
  themes.
- New note editor screen replacing the item list when `kind === 'note'`: title
  field, body textarea, saved-state indicator. No checkboxes, no qty, no add-item
  composer, no aisle grouping.
- `CategorySheet` gains the Note option.
- Hide the completion-notification setting for note lists (a note never
  completes).

### What does NOT change

- Aisle AI: already gated on `kind === 'grocery'`, untouched.
- The "list complete?" prompt (`src/ui/App.jsx:1643`): fires only when every
  item is checked, and note paragraphs are never checked, so it never fires.
- `maybeNotify` completion path in `listWire.js`: same reason, dormant.
- Assignment: a note keeps `list.assignee` and its notification, unchanged.

### Explicitly out of scope

Google Keep's pins, colours, reminders, labels, drawings, images and rich-text
formatting. PearList is a shared list app; chasing those makes it a different
app. Plain text only.

## Compat

**New peer -> old peer.** An old peer receives a `list:` row with an unrecognised
`kind: 'note'`. `applyListOp` stores rows verbatim and does not strip or
validate `kind`, so the row is accepted byte-identically and there is no view
divergence. The old UI's `categoryOf` falls back to the last entry, so the note
renders as a generic List and its paragraphs as ordinary checkable items. Ugly,
not broken, and no fork. `normalizeKind` only runs on the local write path
(`list:create`, `list:setKind`), never on apply, so it cannot rewrite an
incoming note into something else.

The `ord` field is additive and unknown to old peers, which sort by `createdAt`
as they do now. Paragraph order can therefore look wrong on an old peer after a
mid-note insert. Cosmetic, self-corrects on upgrade.

**Old peer -> new peer.** An old peer can check or reorder a note paragraph. The
new UI ignores `checked` on note lists and `itemOrder` is device-local anyway,
so neither reaches another device as damage.

**No migration.** Nothing existing is rewritten. Every field is optional and
absent on every row written to date.

## Risks

- **Same-paragraph concurrent edit still loses text.** Accepted, and it is the
  point of the design that this is the ONLY remaining loss case. Mitigate in
  copy, not machinery.
- **Debounced autosave writes a lot of ops.** A long editing session appends one
  op per changed paragraph per debounce window. Bounded by an idle debounce
  (~800ms) plus flush on blur/close, and paragraph rows are small. Worth watching
  against the storage retention work already in `TODO.md`.
- **The diff is where the bugs will be.** Hence pure, separate and unit-tested
  before it is wired to anything.

## Rollout

Proposal, then implementation, both behind normal review. No feature flag: the
kind is opt-in per list, an old peer degrades to a readable generic list, and
there is no consensus state to arm (unlike writer revocation).

## Verify

- `npm run verify` green (`npm test && npm run build:bare && npm run build:bare:ios && npm run build:ui`).
- New unit tests for the paragraph diff and for `ord` generation and ordering,
  in `test/`, alongside `listWire.test.js`.
- Two-device: create a note on the TCL, edit paragraph 1 on one device and
  paragraph 3 on the other while both are open, confirm both survive on both
  devices.
- Old-peer check: confirm a device on the released build shows a note list as a
  generic list without erroring or diverging.
