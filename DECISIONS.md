# PearList Decisions

Append-only, newest on top. See Constitution §4.

## 2026-06-30 - Items use shared content-keyed rows, not writer-scoped rows
Tier: T3
Context: the original proposal sketched items as item:{listId}:{pubkey}:{seqPad}
(writer-scoped, like PearCircle trips). That would let only the author edit or
check an item. A shared shopping/chore list needs ANY household member to check
or edit ANY item.
Choice: items are keyed item:{listId}:{itemId} (itemId = newEntityId). Any
admitted writer may write any item; the value's `pubkey` records the LAST editor
and the signature proves it; concurrent edits resolve last-writer-wins by
updatedAt with a signature tie-break. Same shape for list:{listId} rows. Delete
is a { deleted: true } tombstone with no-resurrection. Implemented in
src/listWire.js (rowApplyDecision) + src/listMethods.js.
Alternatives: writer-scoped item keys (rejected, blocks shared check-off);
CRDT per-field merge (overkill for a list).
Consequences: no per-writer integrity on rows, which is fine inside a trusted
admitted-writer household. Supersedes the item-key shape in proposal
2026-06-30-pearlist-core-extraction.md.

## 2026-06-30 - PearList is the @peerloom/core extraction vehicle
Tier: T3
Context: suite needs a reusable P2P core; substrate already proven by three
shipped apps (PearCal, PearGuard, PearCircle), so the next build's job is reuse,
not de-risking. PearList is the cheapest low-stakes app to extract against.
Choice: build PearList on a new `@peerloom/core` package extracted from
PearCircle (the modular donor). Leave the three shipped apps on copy-fork for
now; migrate them later in a separate proposal.
Alternatives: copy-fork PearList too (rejected, defers the extraction with no
gain); build PearCare first (rejected, do not refactor shared infra under a
live sensitive app).
Consequences: see proposal 2026-06-30-pearlist-core-extraction.md.

## 2026-06-30 - Standardize on PearCircle's IPC envelope and topic model
Tier: T3
Context: PearCircle and PearCal diverge on two substrate choices the core must
unify.
Choice: (1) IPC envelope = PearCircle's object-args handler-map with
`{ id, result }` responses; PearCal's reverse-RPC `nativeRequest` becomes an
optional opt-in. (2) Swarm topic = `blake2b(groupKey)` with a separate block
encryption key (PearCircle), NOT PearCal's key=topic, so blind seeders stay
possible later.
Alternatives: PearCal's positional-args switch + key=topic (rejected, less
extractable and forecloses blind seeders).
Consequences: `@peerloom/core` freezes this in its v1 API.
