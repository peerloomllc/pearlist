# Arming should not be a user decision

**Status:** proposed
**Tier:** T2
**Date:** 2026-07-31

## The forcing function

Tim, on hardware, 2026-07-31, after linking the iPhone to the TCL:

> I created "New" space on TCL, but it doesn't automatically show up on the iPhone.
> I have to send an invite to the iPhone, and then it looks like the iPhone is not
> considered an owner of that space.

The first half is a different proposal (`2026-07-31-your-spaces-follow-you.md`).
This one is about the second half, and about the thing Tim named ten minutes later
without yet knowing the two were the same bug:

> the "Stronger Removal" language doesn't make sense to me and doesn't seem
> intuitive, maybe because we originally added it as part of the capability to
> remove members from a space? It needs a review, at the least, since I don't think
> the regular user will understand it.

They are the same bug. The reason the iPhone is not an owner of "New" is that "New"
has not been armed, and the only way to arm it is a control called **Stronger
removal** that says nothing about ownership.

## Confirmed on the device, not just in the code

The TCL's Members sheet for "New" still offers **"Stronger removal / Turn on"**, so
`revokeV1` is off on that space. Read as text from the UI dump, 2026-07-31 16:0x.

The chain, all of it deliberate and all of it tested:

| Step | Where |
| --- | --- |
| The linked phone may manage a space only if `canActAsOwner` says so | `src/listMethods.js:563` |
| `canActAsOwner` returns false unless `meta.revokeV2 === true` | `src/listMethods.js:567` |
| It must not be wider than apply's gate, which is also `revokeV2` | `src/listWire.js:355` |
| The FIRST arming needs the owner device, so the linked phone cannot self-serve | `src/listMethods.js:785` |
| Pinned by a test that says so in its name | `test/ownerOtherPhone.test.js:200` |

> `an UNARMED space still refuses the other phone, because apply would drop it`

So nothing is broken. PR #162 shipped exactly what it claimed and stopped exactly
where it had to. The defect is that the prerequisite is **invisible, unrelated to
what it gates, and named after the mechanism**.

## What the user actually experiences

You link your second phone. The app tells you it is you. It puts "(You)" on your own
row and takes the Remove button off it. Then you make a space, and the second phone
silently has no buttons. Nothing is shown, nothing is explained, and the fix is a
one-way security toggle called Stronger removal that mentions only removals.

That is three separate failures stacked:

1. The capability the user wants (my other phone works) is gated on a capability they
   were never asked about (removal strength).
2. The control is named after its implementation. `revokeV1` is writer revocation, so
   the UI called it strong removal. The user never used the word "revocation".
3. The decision is not one the user can make. The safety condition is "every member
   runs a build that understands the new apply rules", which is checkable by code and
   unknowable by a person. We ask them to confirm something they cannot evaluate.

## The proposal

**Stop asking. Arm whenever the gate passes, and delete the control.**

The gate is already the real safety property, it is already computed, and it is
already trusted enough to fire without asking in one place. `revoke:status` has run
an unattended catch-up since PR #150:

```js
// listMethods.js:1154
const canManage = await canActAsOwner(ctx, base, meta)
if (armed && canManage && (meta.revokeV2 !== true || meta.promoteV1 !== true)) {
  if (allMembersSupportSelfRevoke(rows, evicted) || allMembersSupportPromote(rows, evicted)) {
    armRevocation(ctx, groupId).catch(() => {})
  }
}
```

`revokeV2` and `promoteV1` already turn themselves on with no confirm, no copy and no
user involvement. Only `revokeV1`, the first flag, still demands a dialog. There is no
principled reason for the split. It is history: `revokeV1` shipped first, in
`2026-07-13-writer-revocation.md`, when the gate was new and we did not yet trust it.
Two capabilities later we trust it completely.

### Two places it fires

**At creation.** `space:init` writes the `space` row and `member:publish` publishes
the creator's row (`App.jsx:1789`). Once that row lands, the space has exactly one
member, that member is us, and we advertise all three caps
(`caps: [REVOKE_CAP, REVOKE_SELF_CAP, PROMOTE_CAP]`, `listMethods.js:488`). So
`allMembersSupportCap` is trivially satisfied and the space can be armed immediately.

Ordering matters and is easy to get wrong: `allMembersSupportCap` returns **false on
an empty row set** (`listWire.js:219`), so arming before the member row lands fails
silently and the space stays unarmed forever with nothing to retry it. Arm after
publish confirms, not alongside it.

**On existing spaces.** Extend the catch-up above to arm `revokeV1` too, not just the
later flags, whenever `allMembersSupportRevoke` passes. Every space in the household
converges on armed without anyone being asked, and old spaces stop being second-class.

### What the user sees instead

Nothing. That is the point. The Members sheet loses the "Stronger removal" block
entirely. No new copy is needed for the normal case, because the normal case stops
having a decision in it.

The one place copy is still owed is the **honest failure**, which already exists and
already reads well:

> `${name} removed from the list, but their device could not be cut off (it has not
> been online since Stronger removal was turned on).`

That sentence needs rewording once the feature has no name (see Open questions).

## Compat

This is the section that decides whether the proposal is any good, because arming
early trades a known-safe condition for an assumed-safe one.

**What arming changes on the wire.** Three things, and only the third is new risk:

1. `authorizeRevoke` accepts a same-identity revocation (`revocation.js:87`).
2. Apply accepts a same-identity `space` write (`listWire.js:355`).
3. `admitWriter` admits every later writer as a **non-indexer** (`revocation.js:100`).

**The real exposure.** Today the gate means "every member present has updated". Arming
at creation means "every member present has updated, and I am betting none of the
members who join later is on an older build". A peer older than `revoke1` that joins
an armed space computes a different indexer set from the same log. Indexers sign the
view, so that is a fork, not a soft failure.

**Three things make the bet a reasonable one.**

- It is not a new bet, only a more common one. Arming before anyone joins is reachable
  today with two taps, and nothing warns against it. This proposal makes the existing
  hole the default path, which is a reason to measure it rather than a reason to stop.
- The install base is three phones, all on the current build, all Tim's. There is no
  fleet of old peers to fork.
- Non-indexer joiners are the **intended** end state, not a side effect.
  `2026-07-30-the-space-creator-cannot-be-removed.md` documents the opposite default
  (creator is the sole indexer forever) as the bug it set out to fix.

**What we still owe.** A version floor would convert the bet into a guarantee: refuse
to admit a writer whose member row does not advertise the caps. It cannot be done in
`admitWriter`, which runs inside apply and must stay deterministic across builds, so
it belongs on the invite/join path instead. Out of scope here, worth its own item,
noted in Open questions.

**Old peers already in an existing space** are unaffected: the catch-up extension uses
the same `allMembersSupportRevoke` gate that guards the manual button today, so a space
with an old member simply does not arm, exactly as now.

## Scope

**Changes**

- `space:init` (or its caller) arms once the creator's member row has landed.
- `revoke:status` catch-up extends to `revokeV1`, not only `revokeV2` / `promoteV1`.
- The Members sheet drops the Stronger removal block and its confirm dialog.
- The one remaining user-visible sentence naming the feature gets rewritten.

**Does not change**

- The capability gate itself. Same predicate, same three caps, more call sites.
- Apply. No wire rule moves, which is what keeps this T2 rather than T3.
- `space:armRevocation` stays as an IPC method. Only the button goes.
- Ownership transfer, revocation semantics and the housemate rules are all untouched.

## Verify

- Unit: a space armed at creation has `revokeV1`, `revokeV2` and `promoteV1` all set.
- Unit: arming attempted BEFORE the member row lands does not leave the space
  permanently unarmed. This is the regression the ordering trap creates, so it gets a
  test that fails without the fix.
- Autobase harness, extending `test/ownerOtherPhone.test.js`: on a space armed at
  creation, the owner's linked phone can remove a member, and every peer keeps it.
  The existing `armed: false` test stays and keeps its meaning, because an unarmed
  space must still refuse.
- Autobase harness: an existing unarmed space with a member lacking `revoke1` does
  NOT auto-arm.
- Hardware, the case that started this: create a space on the TCL, join from the
  linked iPhone, confirm the iPhone shows Remove, Add back and the trash icon with
  nobody having touched a settings toggle.

The mock-view trap applies. Per `[[mock-view-hides-apply-bugs]]`, anything asserting
what apply accepted runs against a real Autobase, not the mock view in the listWire
tests.

## Rollback

Cheap in one direction and impossible in the other, which is worth being blunt about.

- **Before any space auto-arms:** revert the commit. Nothing to undo.
- **After:** arming is one way by construction. Reverting the code stops FUTURE spaces
  from auto-arming and restores the manual control, but every space already armed stays
  armed. That is survivable because armed is the state we want, and because the manual
  button could have produced the identical state at any time.
- The genuine unrecoverable case is a fork caused by an old peer joining an armed
  space. Rollback does not help there. That is an argument for the version floor, not
  for keeping the dialog, because the dialog does not prevent it either.

## Open questions

1. **Does the manual control survive as a fallback?** Recommend no. A control that
   fires only when the automatic path declined is a control shown exactly when it is
   unsafe to use.
2. **What replaces "Stronger removal" in the hide-only banner?** It has to name a
   moment, not a feature, now that the feature has no name. Something in the shape of
   "it has not been online since you set the space up" reads better and is closer to
   true, but "set the space up" is wrong for a space that armed later via catch-up.
3. **Does the version floor land here or separately?** Recommend separately. It is the
   thing that converts the bet into a guarantee, but it touches the join path, and
   bundling a join-path change into this would push it to T3.
4. **Should `space:armRevocation` stay callable over IPC with no UI caller?** Keeping
   it costs nothing and keeps the tests honest, but a method nothing calls tends to rot.
5. **Anything else gated on arming that users would not connect to removals?** The
   sweep here found ownership. It was not looking for a third.
