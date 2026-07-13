# Writer revocation (Phase 2: stop an evicted device WRITING)

## Goal

Make an evicted device stop being an Autobase writer, so a lost, replaced or
compromised phone can no longer write to a space it was removed from.

## Tier

T3. Changes Autobase writer membership, which is CONSENSUS state (indexers sign
it), and changes apply behaviour. A peer on old code that ignores a removal
computes a different writer set and FORKS. Proposal + rollback + RCA readiness.

## Scope, stated honestly

**This stops WRITES. It does not stop READS, and no version of this can.**

Verified in core: there is no peer blocklist. `swarm.on('connection')` ->
`store.replicate(conn)` unconditionally, so anyone holding the space's topic +
encryption key replicates the whole Autobase forever. `removeWriter` touches
neither the topic nor the key. An evicted device therefore keeps reading the
space, INCLUDING everything written after its eviction.

Cutting off reads means re-keying, which Autobase bootstrap does not allow, i.e.
it means a NEW space. That already works today with zero new code: every member
can leave (PR #68) and one of them recreates + re-invites. If the goal ever
becomes "they must not see our lists", build nothing here - do that instead.

So the ONLY property this buys: an evicted device cannot vandalize, spam or forge
into the space. That is the agreed goal (2026-07-13).

## The two hard problems

### 1. `removeWriter` needs a key we do not have

`base.removeWriter(key)` exists (Autobase 7.28.1, `lib/apply-calls.js`); the only
constraint is `removeable()` - you cannot remove the last indexer. But it takes
the **Autobase writer core key**, while our roster is keyed by **identity
pubkey** (`member:{pubkey}`). Nothing maps between them. The `addWriter` op
carries `pubkey` = the joiner's `base.local.key`, which is NOT their identity key.

The mapping must NOT be self-declared. If a member could publish "my writer key
is W", a malicious member would claim the VICTIM's W, and the owner's eviction
would remove the victim instead. Pairing-time proofs do not fix this either: the
hello is just bytes, and a joiner can present someone else's writer key.

The only unforgeable source is **who actually appended the block**. Autobase's
apply hands each node `from: node.writer.core` (see `lib/apply-state.js`, the
applyBatch construction), and the engine already passes `node` through to
`applyOps`. You cannot append to another writer's core, so binding
`identity -> node.from.key` when we apply that identity's OWN signed `member:`
row is unforgeable.

### 2. Recording that mapping is itself a fork

Storing the binding means changing what apply writes to the view - either a new
key or an extra field on the member row. Old peers would store different bytes
(or nothing), and **Autobase indexers sign the view**. Divergent apply = fork.
This is the same trap Phase 1 was designed around, and here we cannot dodge it:
the mapping has to be persisted to be usable at eviction time.

So the mapping AND the removal are both gated behind the same flag day.

## Design

**Step A - advertise support (safe, ships first, no divergence).**
Members add an additive FIELD to their own roster row:

```
member:{pubkey} -> signed { displayName, ..., caps?: ['revoke1'] }   // NEW field
```

Additive fields on an existing row are stored verbatim by `view.put`, so old
peers store byte-identical values and simply do not interpret them. No fork. This
is exactly the Phase 1 pattern (DECISIONS 2026-07-13).

**Step B - the owner arms it (deterministic switch).**
Once every member row in the space advertises `revoke1`, the owner sets an
additive field on the already-owner-gated `space` row:

```
space -> signed { owner, ..., revokeV1?: true }                      // NEW field
```

Also additive, also stored verbatim, also owner-only by the existing apply rule.

**Step C - apply behaviour switches on that replicated flag.**
Because the flag is part of the replicated, signed view, EVERY peer flips at the
same point in the log - the switch is deterministic, which is what apply requires:

- While `space.revokeV1` is unset: apply behaves exactly as today. Nothing changes
  for anyone. (So Steps A + B are safe to ship and sit dormant indefinitely.)
- Once set: applying a `member:{pubkey}` row ALSO records the binding
  `_w = hex(node.from.key)` on the stored value, and the engine honours a new
  `{ type: 'revokeWriter', pubkey: <writer core key>, by, groupId, sig }` op by
  calling `base.removeWriter()` - gated, like `addWriter` already is, by the
  engine's `authorizeWriter` hook (PearPetal's `admission.js` is the precedent:
  owner-signed op, deterministic apply-side check).

**Step D - the owner evicts.** `member:remove` (shipped) additionally looks up
`_w` for that pubkey and appends the owner-signed `revokeWriter` op.

## Compat

- **Pre-flag:** byte-identical views. Old and new peers interoperate exactly as
  today. Steps A and B are inert.
- **Post-flag:** every peer that syncs runs new code, BY CONSTRUCTION - the owner
  can only arm the flag once every member row advertises `revoke1`.
- **The stale device is the exception, and that is the point.** The device we want
  to evict is precisely the one that will never advertise `revoke1` (it is dead or
  on an old build). If the gate required EVERY member including the target, it
  would never open - the chicken-and-egg that makes this feature pointless. So the
  gate must require every member EXCEPT the eviction target(s).
  Consequence, and the main risk to test: if that device ever comes back on old
  code, it will not apply the removal, will believe it is still an indexer, and
  will keep signing checkpoints. New peers have removed it from the indexer set and
  ignore its signatures, so the honest set should converge and the zombie should
  simply be isolated. **This is the assumption the whole design rests on and it is
  UNPROVEN. It is the first thing to test.**

## Spike results (2026-07-13) - the assumptions are now MEASURED, not assumed

Ran a throwaway 3-writer Autobase spike (no swarm, no engine, so the result is
about Autobase semantics rather than our plumbing): A=owner, B, C; admit both;
all write; A revokes C; C keeps writing on OLD code (an apply that ignores the
revoke op, i.e. exactly today's shipped code).

1. **`removeWriter` works, and revocation MEANS something.** A and B drop from 3
   indexers to 2. C's post-revocation write (`c2_ZOMBIE`) lands ONLY in C's own
   view. A and B never accept it. The honest set keeps writing and stays converged.
   => The zombie is isolated and harmless. The core assumption HOLDS.
2. **C keeps READING everything.** It still replicates every honest write made
   after its eviction (`a2`, `b2`). Confirms the scope limit above: this stops
   writes, never reads.
3. **An old-code BYSTANDER silently forks the space, and this is the real hazard.**
   Re-ran with B (NOT the eviction target) on old code: B ignores the revocation,
   keeps C in its writer set, ACCEPTS the zombie write, and permanently diverges
   from A (`A: a1,a2,b1,b2,c1` vs `B: a1,a2,b1,b2,c1,c2_ZOMBIE`).
   **Nothing threw.** Autobase does not detect this for us - it is a SILENT
   split-brain. In the app that means B shows an item A does not, forever.
   => The capability gate is REQUIRED, is load-bearing, and must cover every
   non-target member. It cannot be an optimisation we skip.
4. **Non-indexer writers work, and cost us nothing in liveness.** Admitting B and C
   with `{ indexer: false }` still lets them write; only the owner indexes.
   Revocation then does not touch the indexer set at all. It does still change
   `system.writers` (so an old bystander still forks - the gate is needed either
   way), but it shrinks the blast radius.
   Liveness checked explicitly, because "only the owner indexes" sounds
   disqualifying for a household app where the owner is away for days: with the
   OWNER OFFLINE, B and C still see each other's writes in BOTH modes. And the
   signed/indexed frontier stalls at the SAME point (indexedLength 7 of length 11
   vs 15) in both modes - so non-indexer admission is NOT a regression against
   today. (Separately curious that the frontier stalls even today with all-indexer
   writers; not caused by this change, but worth a look before leaning harder on
   indexed state for retention / fast-forward.)

## Verify

- Unit (pure): `caps` / `revokeV1` parsing; a `revokeWriter` op not signed by the
  owner is dropped; the binding is taken from `node.from.key` and NOT from any
  self-declared field (feed apply a member row that lies about its writer key and
  assert the lie is ignored).
- Two-peer (TCL + Pixel): arm the flag, evict, confirm the evicted device's writes
  are no longer applied by the other peer, and that the other peer keeps working.
- **Three-peer zombie test (the load-bearing one):** A (owner) + B + C. Evict C.
  Bring C back and have it write. Assert: A and B converge, ignore C's blocks, and
  neither forks nor stalls. Then bring C back on OLD code and assert the same.
  If this test fails, the feature does not ship.
- `npm run verify` green.

## Rollback

Steps A/B are inert fields; reverting the code just stops interpreting them.

Step C/D are NOT cleanly reversible: once a `revokeWriter` op is in the log and
applied, the writer set has changed, and a reverted peer would re-diverge. So:
- Do NOT arm `revokeV1` on a real space until the zombie test passes.
- Rollback before arming = revert the commit, nothing to undo.
- Rollback after arming = re-add the writer (an `addWriter` op for the same key),
  which restores write access but does not "un-fork" a peer that already diverged.
- Nuclear: recreate the space (the same escape hatch the whole app already has).

## Open questions

1. Does `removeable()` bite us? Every writer is admitted as an INDEXER
   (`addWriter` defaults `isIndexer: true`), and Autobase refuses to remove the
   last indexer. Fine for a household (2+ members), but a 2-member space where the
   owner evicts the only other member leaves 1 indexer - allowed - while a
   1-member space cannot evict at all (nobody to evict). Confirm no edge case.
2. Should we admit writers as NON-indexers going forward? That would decouple
   "can write" from "signs the view" and make revocation far less scary. It is a
   bigger change to admission and affects liveness (who can advance the log).
   Possibly the better long-term shape; out of scope here but worth thinking about
   BEFORE we build the gate machinery.
3. ~~Is the zombie actually harmless?~~ ANSWERED by the spike: yes, a removed
   old-code peer is isolated and cannot disrupt the honest set. But an old-code
   BYSTANDER silently forks the space, so the gate is mandatory (see Spike #3).
4. Suite-wide: PearCal + PearGuard have the same gap. If the shape holds, this
   belongs in `@peerloom/core`, not in PearList's listWire. Build it here first as
   the extraction vehicle (per CLAUDE.md), then promote.
