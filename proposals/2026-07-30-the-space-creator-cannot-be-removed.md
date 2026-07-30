# The phone that created a space can never be cut off

**Status:** proposed
**Tier:** T3 (it changes the INDEXER set, which is consensus state)
**Date:** 2026-07-30

## The forcing function

Removing the TCL from the iPhone reported "that phone can no longer edit your shared
lists". The TCL went on editing them, and went on receiving the iPhone's updates.

PR #142 made the app tell the truth about this, which is the urgent half. This
proposal is about whether the limit itself should stand.

**The limit, plainly: you cannot cut off the phone that created a space.** That is
the worst possible phone for it to be, because the phone that creates the household
space is usually the person's main one - exactly the phone whose loss makes someone
reach for "remove this device" in the first place.

## Why it happens

Autobase refuses to remove the last INDEXER of a base. And `admitWriter` in
`src/revocation.js` admits every writer added AFTER arming as a non-indexer:

```js
// once a space is armed, new writers are admitted as NON-indexers - they
// can still write, they just do not sign the view, so revoking one never
// touches the indexer set.
return armed(meta) ? { indexer: false } : { indexer: true }
```

That rule is good and was chosen deliberately: it keeps revocation away from the
indexer set entirely. But it has a consequence nobody wrote down - the space's
creator is its only indexer, permanently, and therefore permanently un-removable.

Every removal before 2026-07-30 went the other way (removing a device that had
JOINED, i.e. a non-indexer), which is why this survived a full day of testing that
was specifically looking for removal bugs.

## It is fixable, and the fix is measured

A non-indexer can be PROMOTED by re-issuing `addWriter` with `indexer: true`. No new
op type. Verified end to end on a real Autobase:

| Step | Result |
| --- | --- |
| B admitted as a non-indexer | writable |
| A (creator) removeable? | **false** - the trap |
| Promote B via `addWriter{indexer:true}` | accepted |
| A removeable now? | **true** |
| Revoke A | A is no longer writable |
| B writes afterwards | lands |

So the shape is the one the codebase already uses for ownership: **promote first,
revoke second**, in that order in the log, exactly as `revokeDeviceFromSpaces`
already transfers ownership before revoking.

## The cost, and it is the whole decision

`admitWriter` would have to honour an explicit `indexer: true` instead of forcing
`false` whenever the space is armed. **That changes how the indexer set is computed
from the same log** - so a peer on today's build computes `indexer:false` for an op a
new peer computes `indexer:true`, and the two disagree about who signs the view.

That is consensus divergence, i.e. a fork, and `test/forkSafety.test.js` shows what
that looks like: silent, confined to some rows, and it freezes the signed frontier.

So it needs its own capability gate - a third after `revoke1` and `revoke2` - with
the same "every member must advertise it before the owner may arm it" rollout and the
same long tail. That is the real price, not the code.

## Options

1. **Promote-then-revoke, behind a new capability.** Fixes the case properly. Costs a
   third gate and a rollout.
2. **Admit the owner's OWN devices as indexers even when armed** (same-identity,
   checkable from the member rows), so a person's two phones both sign and either can
   be removed. Narrower and arguably the right default - a housemate staying a
   non-indexer is the part that was worth having. Same fork risk, same gate needed.
3. **Do nothing.** The app is now honest: it says the phone keeps the shared lists and
   that the way out is moving them to a new space. For a household app with small
   spaces that is a legitimate answer, and "make a new space" is already the documented
   escape hatch for re-keying (DECISIONS.md 2026-07-28).

## Recommendation

**Option 2, but not yet.** It is the smallest rule change that removes the trap for
the case that matters (your own lost phone), it keeps the property the current rule
was chosen for (a housemate's revocation never touches the indexer set), and it is
checkable from replicated state.

But it is a third capability gate on a feature that is not shipped yet. The sane order
is: ship device linking with the honest message from #142, see whether anyone actually
hits this, and add the gate once there is a reason to spend it. Adding a third
consensus gate before the first two have ever run in the field is how the tail gets
unmanageable.

## Verify (when built)

- Unit, real Autobase: promote a non-indexer, then revoke the former sole indexer, and
  assert the promoted device can still write afterwards.
- Unit: an un-promoted space still refuses, and the app still reports `sole-indexer`
  rather than claiming success (the #142 behaviour must not regress).
- Fork safety: a peer without the new capability must not be in a space where it is
  armed - the existing `allMembersSupportCap` machinery, with a third cap.
- Two-device hardware: remove the space's CREATOR and confirm it actually stops
  editing, which is the thing that failed on 2026-07-30.
