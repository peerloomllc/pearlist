# Space ownership recovery (when the owner's device is gone)

> **STATUS: WON'T BUILD (2026-07-28).** Superseded by space export / import (PR
> #116), which shipped the same afternoon this was written. See DECISIONS.md
> 2026-07-28. Kept because the reasoning is still the useful part - in particular
> the n=2 finding below, which applies to any future "recover the space" feature.
>
> The short version: ownership gates rename, delete, evict and arm-revocation.
> Eviction only HIDES a member and revocation stops writes but not reads, so the
> real answer to "get them out" was always a new space - and export/import makes
> that cheap while carrying the household's lists across. What ownership recovery
> would still have bought is keeping the same space id and not re-sending invites,
> which is not worth a T3 trust change and a seizure button in a couples app.

## Goal

Let a household keep running a space whose owner identity no longer exists on any
phone - after a lost, broken, wiped or reinstalled device - without handing any
member the ability to take a space from the person who owns it.

## Tier

T3. Ownership decides who may write the `space` row, and that row gates eviction
and revocation arming. Any change here changes APPLY behaviour, which is consensus
state: a peer on old code that computes a different answer stores a different
`space` value, and indexers sign the view, so the space FORKS. Same hazard class
as writer revocation (2026-07-13), and it needs the same capability gate.

## Where this came from

2026-07-28, a real user. He reinstalled PearList, which destroyed the identity his
space was owned by, and rejoined from his wife's invite as a new device. Admission
is unaffected - PearList passes no `mintAddWriter` and no `authorizeWriter`, so any
writer admits and every `addWriter` op is honoured - but nobody can ever again
rename that space, delete it, evict or restore a member, or arm revocation.

Ownership is per-DEVICE and nothing says so. `space.owner` names an identity
pubkey; identity is a keypair in that device's store; a reinstall makes a new one.
See the memory note "device identity is not a person": Tim's Pixel and iPhone are
already two members of his own household.

## Scope, stated honestly

**What is actually locked, and it is less than it sounds.** With the owner gone:

| Blocked | Still works |
| --- | --- |
| rename the space | every list and item operation |
| delete the space | joining, admission, invites |
| evict / restore a member | leaving (PR #112) |
| arm writer revocation | export / import (PR #113) |

Nothing in daily use stops. That is why this proposal argues for MED, not the HIGH
it was filed as: it is a permanent one-way door, but the household does not walk
through it most days.

**There is already a complete escape, shipped.** Export the space to a file and
import it (PR #113): the importing device founds a NEW space it owns, with every
list and item intact. The cost is re-inviting the household and losing assignees.
Anything proposed below has to be better than that, and "better" here means "keeps
the same space and the same invites", not "recovers data" - the data is not at
risk.

## The hard problem, which no design escapes

**In a two-person household, ownership recovery and ownership theft are the same
operation.** There is no signature, quorum or proof that distinguishes "my partner
lost their phone, let me take over" from "I am taking this space from my partner".
Absence cannot be proven in a P2P system: a device that is offline and a device
that no longer exists are identical from every other peer's point of view.

Every quorum rule collapses to this at n=2. "A majority of members excluding the
candidate" is one person. "Unanimous consent of the remaining members" is one
person. "All members except the current owner" is one person. Two-person
households are the common case for this app.

So the choice is not "safe recovery vs unsafe recovery". It is:

1. Accept that a member can seize a space, and make the seizure LOUD instead of
   preventable, or
2. Require the owner to have prepared for it BEFORE losing the device, which does
   nothing for anyone already in the broken state, or
3. Shrink what ownership gates, so losing it costs less.

## Options

### A. Quorum handover (reject)

A `claimOwner` op accepted when enough current writers sign an endorsement.
Deterministic to apply (count valid endorsements in the view), and honest for a
five-person household. At n=2 it is unilateral seizure with extra steps, and it
adds a new signed op to the wire for a case that export/import already covers.
The complexity is real and the safety is illusory where it matters.

### B. Prove the owner is gone (reject outright)

Not possible. Offline is indistinguishable from destroyed. Listed only so nobody
proposes it again.

### C. Pre-designated successor (recommended, part 1)

While the owner still has their device, they name one or more successor pubkeys on
the `space` row:

```
space.successors?: [pubkeyHex]     // owner-written, so already owner-gated
```

Later, a named successor appends a signed `claimOwner`, and apply accepts it only
if the claimant is in `successors` on the CURRENT `space` row. Fully deterministic,
no quorum, no counting, and it cannot be used to seize: only a device the owner
personally named can claim.

It rides the existing owner-gated `space` row, so it needs NO new trust rule for
the setup half - only the `claimOwner` acceptance is new.

**Its honest weakness: it requires foresight, and our reporter had none.** It fixes
the next household, not this one. Worth it anyway, because "the next household" is
every household, and the alternative designs are worse.

Surface it where a person will actually meet it: a one-line prompt in the space's
member sheet ("If you lose this phone, who should take over?") once a space has a
second member.

### D. Shrink the gate (recommended, part 2)

Most of what breaks does not need owner authority at all. Rename is cosmetic and
already last-writer-wins. Split the rule so that:

- `space.name` may be updated by ANY writer.
- `space.deleted`, `space.evicted` and `space.revokeV1` stay owner-only.

Then an ownerless space is merely unable to delete itself, evict, or arm
revocation - and the household never notices day to day.

**This is still fork-inducing** and that is the whole difficulty: a peer on old
code rejects a non-owner name write that a new peer accepts, so the two store
different `space` values and the view diverges. It therefore needs the same
capability gate revocation already uses - every member advertising support in
`member.caps` before the app ever issues a non-owner name write. That machinery
exists (`REVOKE_CAP`, `allMembersSupportRevoke`), so this is a second user of a
proven pattern rather than a new mechanism.

### E. Do nothing, document export/import (the baseline to beat)

Costs nothing, ships nothing, and already works. If C and D are not clearly worth
their fork risk, this is the correct answer and should be recorded as one in
DECISIONS.md rather than left as an open TODO that gets re-proposed.

## Recommendation

**C + D, in that order, and explicitly NOT A.** C is cheap, deterministic and
cannot be abused. D is where the actual relief is, and it is a second use of a
pattern we have already shipped and tested. Neither hands anyone a way to take a
space from a live owner, which is the property worth protecting: this app is used
by couples, and a "recover the space" button is a "take the space" button in a
household where things have gone wrong between the two people using it.

For the user who is already stuck: export / import. Tell him that now.

## Compat

- C is additive: `successors` is an unknown field to old peers, which store it
  verbatim and ignore it (same as `evicted` and `left`). A `claimOwner` op from a
  new peer would be IGNORED by an old peer's apply, which means an old peer keeps
  the old owner and a new peer sees the new one. **That diverges**, so `claimOwner`
  needs the capability gate too, not just D.
- D needs the capability gate before any non-owner name write is issued.
- Both stay dormant on a space where no successor is named and no member has
  advertised support, so an un-upgraded household behaves exactly as today.

## Verify

1. Unit, in listWire: `claimOwner` accepted from a named successor; REJECTED from a
   member who is not named, from a forged signature, and when `successors` is
   absent. Non-owner name write accepted only when every member advertises support.
2. Two-peer, in the engine harness: owner names a successor, both peers converge on
   the same `space` row; successor claims; both peers agree on the new owner.
3. The fork test that matters, mirroring writer-revocation's: an OLD-code bystander
   must not silently diverge. If it does, the gate is wrong.
4. On-device: two phones, hand over, then confirm the new owner can evict and the
   old owner's device can no longer.

## Rollback

C and D are both dormant until used, so rollback is "stop issuing the new ops".
A space that has already handed over cannot be un-handed-over by a code revert -
the `space` row names the new owner and that is replicated. Say so in the UI copy
before the confirm: handover is permanent.

## Open questions

1. Should a handover be visible after the fact? A `space.ownerHistory` would make a
   seizure legible rather than silent, at the cost of a growing field on a row that
   is read on every list render.
2. Does D want `name` moved OFF the `space` row entirely (its own key, its own
   rule) rather than a per-field exception inside one row's apply branch? Cleaner
   to reason about, but it is a new namespace and `applyListOp` drops keys outside
   NAMESPACES, which is its own compat problem.
3. Is delete worth keeping owner-only at all, given every member can already leave
   and an ownerless space can simply be left by everyone?
