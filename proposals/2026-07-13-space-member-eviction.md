# Space member eviction (stale member cleanup)

## Goal

Let a space owner remove a stale or unwanted member from a space, and let any
member leave a space they are in, without forking old peers.

## Tier

T2. Additive fields on two EXISTING rows (`space` and `member:{pubkey}`). No new
Hyperbee namespace, no new topic, no pairing or crypto change.

Deliberately NOT T3, and the reason is the whole point of the design: see Compat.
Phase 2 (real Autobase writer removal) IS T3 and is out of scope here.

## Context

There is currently no way to get a member out of a space. A wiped or replaced
device lingers in the roster forever: it shows in MembersBar, the "N members"
row and the assignee picker, and it stays an admitted Autobase writer. This
bites in practice, e.g. clearing the TCL's app data during onboarding testing on
2026-07-13 left its old pubkey in the Family space with no way to remove it.

Two facts shape the design.

1. `member:{pubkey}` rows are owner-scoped: `rowApplyDecision` rejects a member
   row not signed by that pubkey. So a member can only ever write their OWN row,
   and nobody else can retract it. That is exactly the device we no longer have.
2. The `space` singleton already carries a signed `owner`, and its apply branch
   already accepts updates ONLY from that owner (the `space:delete` path). We
   have an owner-gated, signed, replicated row already, and it is the natural
   place to hang an eviction list.

## Scope

### What changes

**Owner evicts a member.** The owner writes an updated `space` row carrying a new
additive field:

```
space -> signed { owner, name, createdAt, updatedAt, pubkey, sig,
                  evicted?: { [pubkey]: { at } } }     // NEW, optional
```

Read-modify-write by the owner, gated by the EXISTING `space` apply rule (only
`v.pubkey === existing.owner` is accepted), so eviction needs no new trust
machinery and no new gate. It is a map, not a tombstone, so it is revocable:
removing a pubkey from `evicted` un-evicts, and a re-invited device works again.

**A member leaves.** The member sets a new additive field on their OWN roster row:

```
member:{pubkey} -> signed { displayName, avatar?, ..., left?: true }   // NEW
```

Permitted by the existing owner-scoped rule with no change. Also revocable: a
rejoin republishes the row without `left`.

**Reads.** `member:getAll` filters out any pubkey listed in `space.evicted`, any
row with `left: true`, and (a latent bug, fixed here) any row with
`deleted: true`, which it does not filter today. Every membership surface reads
that one method, so MembersBar, the member count and the assignee picker are all
fixed at once.

**New IPC methods.** `member:remove` / `member:restore` (owner only, enforced in
the method AND deterministically in apply by the existing owner rule) and
`space:leave` (self; sets `left`, then reuses the existing `space:forget` to drop
the space locally and stop replicating it).

**UI.** The members sheet gains a per-member Remove action, shown only to the
owner, behind the existing themed `askConfirm`. Every member sees "Leave this
space" for themselves.

### What does NOT change

- No Autobase writer removal. An evicted device stops appearing in the roster but
  remains an admitted writer. It is hidden, not revoked. See Open questions.
- No new namespace, no change to `rowApplyDecision`, no change to the pairing or
  invite flow, no change to `list:` or `item:` rows.

## Why not the obvious designs

**A tombstone on the member row.** `rowApplyDecision` enforces no-resurrection:
once `deleted: true` is stored, every later write to that key is rejected,
forever. Tombstoning a member would make them permanently unrosterable even if
the owner later re-invited them. `left` / `evicted` are revocable flags for
exactly this reason.

**A new `evict:{pubkey}` namespace.** This is the design the TODO assumed, and it
is unsafe now. `applyListOp` drops any key outside `NAMESPACES`, so an old peer
would ignore the op while a new peer does `view.put`. The two then compute
DIFFERENT Hyperbee views from the same op log, and Autobase indexers sign the
view. That is a fork, not a cosmetic difference. It is survivable pre-release,
which is how `member:` itself landed as a new namespace on 2026-06-30, before
v1.0.0. It is not survivable now that v1.0.0 is in three stores.

**A self-declared identity -> writer-key mapping.** Needed for Phase 2, not here,
and it must not be self-declared: a malicious member could claim a victim's
writer core key, and the owner's eviction would then remove the victim. The
unforgeable binding is `node.from.key` in apply (the writer core that actually
appended the block), which nobody can fake. Recorded here so Phase 2 starts from
the right primitive.

## Compat

The whole design is chosen so that old and new peers compute a BYTE-IDENTICAL
view. Both `space` and `member:` rows are stored verbatim by `view.put`, and
neither apply branch strips unknown fields. An old peer therefore stores exactly
the same value a new peer does; it simply does not INTERPRET `evicted` / `left`.

- Old peer, new data: applies the same bytes, keeps showing the evicted member in
  its roster. Cosmetic degradation, no divergence, no fork.
- New peer, old data: no `evicted` / `left` present, behaves as today.
- Mixed space: converges. The evicted device is hidden for everyone on new code
  and visible to stragglers until they update.

No migration. No flag day. Nothing to backfill.

## Verify

- Unit (pure, no Autobase): the `space` owner rule already rejects a non-owner
  update; add cases for an eviction written by a non-owner (rejected), by the
  owner (accepted), revocation, and `member:getAll` filtering (`evicted`, `left`,
  `deleted`).
- Two-peer on-device (TCL + Pixel), the real test:
  1. Owner removes a member -> member disappears from the roster, count and
     assignee picker on BOTH devices.
  2. Owner restores them -> they reappear. Proves the no-resurrection trap is
     avoided.
  3. A member leaves -> gone from the owner's roster; the leaver's space is gone
     locally.
  4. Non-owner sees no Remove action, and a forged non-owner eviction is dropped
     in apply.
- Old-peer compat: a device on the v1.0.0 store build stays in the same space
  through an eviction and keeps syncing lists and items normally. This is the
  load-bearing check for the whole proposal.
- `npm run verify` green.

## Rollback

Revert the commit. The `evicted` / `left` fields are inert to reverted code,
which simply stops filtering and shows those members again. No data is destroyed
by the feature (no tombstones), so nothing needs undoing on-wire, and a peer that
already stored the fields is not corrupted by a peer that no longer writes them.

## Open questions

1. **A stale OWNER is a dead end.** Only the owner can evict, so if the owner's
   device is the one that died, their ghost is unremovable, and (post Phase 2)
   permanently an admitted writer. A new device rejoining gets a NEW identity
   pubkey, so it is not the owner and cannot evict the old one. Wants an owner
   hand-off (`space:transferOwner`, owner-signed) or a recovery rule. Not solved
   here. Argues for doing hand-off sooner rather than later.
2. **Phase 2: real revocation (T3).** Hiding a member does not revoke their write
   access. Real revocation means `base.removeWriter()` (it exists in Autobase
   7.28.1; the only constraint is you cannot remove the last indexer). Writer
   membership is CONSENSUS state, so a peer on old code that ignores the op
   computes a different indexer set and forks. That needs a capability gate:
   every member advertises support in their roster row, and the owner's Remove
   only hard-revokes once the whole space is known to support it. Separate
   proposal.
3. **Eviction never revokes READ access.** The evicted device keeps the swarm
   topic and the encryption key, so it can still read the space it already has.
   Genuinely fixing that means re-keying the space, which Autobase bootstrap does
   not allow, i.e. it means migrating everyone to a new space. Out of scope, and
   worth saying plainly in the UI copy: "Remove" is not "block".
4. **Historical assignments.** Items still assigned to an evicted member resolve
   to "Member" once they leave the roster. Acceptable, or should eviction clear
   their assignments?
5. **Concurrent owner devices** racing two evictions do a read-modify-write on the
   same `space` row and LWW, so one can be lost. Rare (one owner), acceptable,
   noted.
6. Suite-wide: PearCal and PearGuard have the same gap. If the shape holds here,
   promote it to `@peerloom/core` rather than re-deriving it per app.
