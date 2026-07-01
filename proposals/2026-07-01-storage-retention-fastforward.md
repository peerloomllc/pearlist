# 2026-07-01 - Storage retention + fast-forward (@peerloom/core)

**Status:** APPROVED - P1 + P2 SHIPPED 2026-07-01. Roadmap item #4 from the
storage discussion. P1 (manual `engine.retain()`): peerloom-core PR #7 + pearlist
PR #19. P2 (auto scheduler, 30-min interval): peerloom-core PR #8 + pearlist PR
#20. P3 (deleted-space disk reclaim) remains blocked on upstream `purge()`. The
original scoping text below is kept as the design record.

**Goal**

Stop the append-only Autobase/Hypercore log from growing without bound so
long-lived PeerLoom apps (PearList, and the PearCal bloat that prompted this)
reclaim disk over time instead of accumulating every edit forever. Land the
mechanism in `@peerloom/core` so every app benefits.

**Tier**

T3. Touches the shared engine's core lifecycle (block retention, fast-forward,
peer catch-up guarantees). Correctness bug here = data loss or peers that can
never sync. Full gate + this proposal + a two-peer + a three-peer test.

---

## Problem

Hypercore is append-only. Every list/item edit, toggle, rename, delete, and
member republish is a new block on the author's input core, retained forever.
The linearized Hyperbee **view** is compact (current state only), but the
**input cores** it is derived from keep all history. Over months this is the
PearCal-style growth.

Two distinct concerns, often conflated:
1. **Live-log growth** (the real problem): an active space's input cores grow
   with churn. This is what needs retention.
2. **Deleted-space reclaim**: freeing a whole space's cores on delete. Already
   partially handled (PR #16 tears down the base + leaves the topic), but the
   on-disk blocks are NOT freed - see findings.

---

## Findings (verified against the pinned stack: corestore 7.11, hypercore
11.33, autobase 7.28)

1. **`hypercore.clear(start, end)` WORKS.** It removes block *data* for a range
   from local storage while keeping the Merkle tree, so the core stays valid and
   verifiable; cleared blocks just report `has() === false` and re-download on
   demand. Verified: cleared blocks 0-149 of a 200-block core; kept blocks still
   readable, `length` unchanged. **This is the retention primitive.**
2. **`hypercore.purge()` (delete a whole core) is BROKEN here** - throws on a
   missing `_closeAllSessions`, even for a raw standalone core. So freeing a
   deleted space's cores wholesale is not possible in this version. (This is why
   PR #16 reclaims RAM/CPU/network but not disk.)
3. **Autobase fast-forward is ON by default** (`fastForwardEnabled =
   handlers.fastForward !== false`). A lagging or new peer can jump to a recent
   view snapshot instead of replaying full history (`forceFastForward`,
   `fastForwardTo`, `_applyFastForwardMigration`, `_gcWriters` all present). So
   the *catch-up* half is already handled by the engine - we are not building it,
   we are building the *retention* half that safely lets us clear old blocks.
4. **Shared RocksDB backing (corestore 7).** All cores live in one `db/` RocksDB.
   `clear()` deletes the blocks' KV entries; physical file size shrinks only on
   RocksDB compaction (async, deferred), not immediately. So success is measured
   by "blocks no longer stored / logical size", not instantaneous `du`.

---

## Options considered

**A. Do nothing / wait for upstream.** Holepunch is actively iterating autobase
retention. Lowest effort, but the bloat keeps growing and `purge()` being broken
suggests we can't rely on the whole-core path landing soon. Rejected as the sole
plan; we still track upstream for the deleted-space case.

**B. View-only + clear all inputs aggressively.** Keep only the Hyperbee view and
clear input cores down to near-nothing. Rejected: breaks new-writer admission and
peers that need history to linearize; fast-forward needs a snapshot floor. Unsafe.

**C. Windowed retention on input cores (RECOMMENDED).** Periodically `clear()`
input-core blocks *older than a safety watermark*, where the watermark is the
minimum of: (a) the index/view has consumed them, (b) they are below the
fast-forward snapshot point, and (c) a grace margin so a briefly-offline peer can
still catch up before falling back to fast-forward. Keeps a rolling recent
window; old superseded churn is pruned. Uses only the proven `clear()`.

**D. Snapshot + compact (heavier).** Periodically checkpoint the view, migrate
writers, and drop pre-checkpoint history via autobase's migration machinery.
More complete but rides deep autobase internals (`_migrate`, `_applyFastForward
Migration`) that are private and version-fragile. Defer; revisit if C proves
insufficient.

**Recommendation: C**, layered so D can build on it later.

---

## Recommended design (Option C)

Add an opt-in retention pass to `@peerloom/core`, exposed to apps:

- `engine.retain(groupId, { keepRecent, graceMs })` and an optional periodic
  `retentionInterval` in `createGroupEngine` options (default OFF; apps opt in).
- For each input core of the group's base (local writer + admitted writers):
  - Determine `safeUpto` = min(indexed length consumed by the view, fast-forward
    snapshot floor) minus a `keepRecent` block margin.
  - `await core.clear(0, safeUpto)` to prune everything below the watermark.
- Never clear: the local writer's un-indexed tail, the view core, the system
  core, or anything above `safeUpto`.
- Blocks re-download on demand if a peer actually needs them, so clearing is
  safe for correctness (only a bandwidth cost in the rare catch-up case).

Where the watermarks come from (to be pinned during build, reading autobase's
public surface): the base exposes indexed length / system info and
`fastForwardMinimum`; we compute `safeUpto` conservatively and only ever move it
forward.

---

## Risks + mitigations

- **Clearing something a peer still needs** -> they re-download it (bandwidth,
  not data loss), or fast-forward if it is below the snapshot. Mitigate with a
  generous `graceMs`/`keepRecent` default and start conservative.
- **Clearing un-indexed / needed blocks -> corruption or stuck view.** Mitigate:
  only clear strictly below the computed `safeUpto`; never touch the view/system
  cores; extensive tests.
- **Version fragility** (autobase internals move). Mitigate: rely only on
  `clear()` (stable) + the smallest possible public autobase surface for
  watermarks; pin versions; add a test that fails loudly if the surface changes.
- **RocksDB doesn't shrink immediately.** Communicate that reclaim is gradual
  (compaction), and measure via block presence, not `du`.

---

## Test plan

- Unit: retain() clears only below the watermark; view still reads all current
  state; a cleared block reports `has()===false` but `get()` still resolves by
  re-request in a two-peer setup.
- Two-peer (testnet): A prunes old blocks; B (fully synced) unaffected; a fresh
  C joining still syncs (via re-download or fast-forward).
- Three-peer: a peer offline across a prune still converges when it returns.
- Growth: simulate N thousand edits, run retention, assert stored block count
  drops to ~the retention window.

---

## Phasing

1. **P1 - retention primitive**: `engine.retain(groupId, opts)` (manual, opt-in)
   + tests. PearList calls it on a schedule (e.g. on app foreground, throttled).
   Delivers the actual disk win for live-log growth.
2. **P2 - auto retention**: `retentionInterval` option; tune defaults from P1
   on-device data.
3. **P3 - deleted-space disk reclaim**: revisit when upstream `purge()` is fixed
   or via Option D migration; until then PR #16's teardown stands.

---

## Open questions

- Exact public autobase field(s) for the fast-forward floor + indexed length in
  7.28 (pin during P1 by reading the instance, not docs).
- Default `keepRecent` / `graceMs` - start generous (e.g. keep last few hundred
  blocks + 7-day grace), measure, tighten.
- Should retention run in the worklet on a timer, or be triggered by the shell
  on lifecycle events (foreground/background) to avoid churn? Lean: shell-driven,
  throttled.
