# Re-pairing a phone you removed

**Status:** proposed
**Tier:** T2 (T3 if it were done the other way - see Rejected below)
**Date:** 2026-07-30

## The forcing function

Tim removed a linked iPhone during the offline-removal test, then tried to pair it
again from Settings the normal way. It failed, and it will always fail. Removal is
permanent by design and nothing in the app said so.

That is worth stating plainly: the person who built the removal flow expected a way
back. A user hunting a lost phone, who removed it in a panic and then found it in a
coat pocket, will expect one far more strongly. Today their only route is "delete
the app and set it up from scratch", and they have no way to know that.

PR #134 follow-up makes the confirm say so, which is the honest stopgap. This
proposal is about whether the answer should stay "no".

## Why it is permanent today

`device:remove` appends `{ removeWriter: <key> }` to the personal base.
Apply writes `revokedWriter:<key>` into the VIEW, and the admission branch refuses
any later re-admission:

```js
if (op.addWriter) {
  const hex = op.addWriter
  if (await isRevoked(view, hex)) continue      // <- here
```

(`peerloom-device-link/src/personal.js`)

### CORRECTION, same day, and it changes the design

This section originally claimed: "the original `addWriter` is still in the log and
is re-applied every time the view is rebuilt, so without a replicated record that
the key was revoked, the removal would silently undo itself on the next rebuild."

**That is wrong.** Measured on a real Autobase in `test/readmission.test.js`:

| Question | Answer |
| --- | --- |
| Does a revocation survive a full rebuild from disk, with NO denylist? | **Yes.** Apply is ORDERED - `addWriter` at seq 5 then `removeWriter` at seq 50 linearizes to removed, every time, forever. |
| Does a LATER `addWriter` re-admit, with no denylist? | **Yes.** |

So the denylist is not what makes removal stick. It is a **policy**: it refuses a
*future* re-admission. That is a choice, and the two bases in this app already
choose differently:

- **personal base** - keeps `revokedWriter:` rows, refuses forever
- **shared spaces** - keep no such record, so a later `addWriter` re-admits today

Believing the wrong version made the change look far more dangerous than it is, and
it went into a merged commit message and PR body before being checked. The lesson
is the same one this repo keeps relearning: assert nothing about Autobase semantics
without a real base under it.

### What follows from the correction

**The scope shrinks a lot.** Shared spaces need nothing at all - re-admitting a
removed phone there is an ordinary `addWriter` from a device that may append, which
is exactly what pairing already does. Only the **personal base** refuses.

So the question narrows to: how does a phone get back onto the personal base?

## Two designs

### Rejected: an `unrevokeWriter` op

Add an op that removes the `revokedWriter:` row, so a later `addWriter` is honoured
again. Ordered apply makes this coherent (admit at 5, revoke at 20, un-revoke at
40, admit at 41 - every device computes the same final writer set).

Rejected on cost, not on correctness:

- It is **consensus state** - it changes what the view contains and therefore which
  keys are writers - so a peer that does not understand `unrevokeWriter` computes a
  different writer set and SILENTLY FORKS. That means a third capability after
  `revoke1` and `revoke2`, with the same "every member must advertise it first"
  gate and the same long tail before it can ever be armed. See
  `test/forkSafety.test.js` for what that failure actually looks like.
- It makes a security-relevant rule conditional, and the rule is currently
  absolute and easy to reason about: a revoked key is dead on the personal base,
  forever.
- It buys nothing the alternative does not.

Note this survives the correction above. The denylist turning out to be policy
rather than load-bearing makes it *easier* to change, but changing it is still a
change to replicated view content, which is still a fork risk on old peers.

### Proposed: rotate the phone's writer key, then pair normally

The thing revocation kills is a **writer key**. It is not the phone and it is not
the person. A phone that presents a key which was never revoked is admitted by the
existing path, with no rule changed.

Autobase supports this directly:

```js
await base.setLocal(key, { keyPair })   // public API, autobase/index.js
```

So: when a device finds it has been revoked and the user asks to pair it again, it
mints a fresh keypair, rotates its local writer, and runs the ordinary pairing
handshake. Nothing else changes.

- **No new op, no capability gate, no fork risk.** The apply rules are untouched,
  so an old peer is unaffected.
- **The revoked key stays dead forever.** Whoever holds the genuinely-lost phone
  keeps a dead key.
- **Still safe.** Pairing needs the QR from a phone the user is currently holding.
  Someone who has the lost phone cannot produce it.
- **It is what a reinstall already does**, by accident - wiping the app throws away
  the key store, which is a key rotation with extra steps. This makes the working
  path deliberate instead of folklore.

## Rotation, MEASURED 2026-07-30

Proved on a real Autobase carrying the personal base's denylist model, before
writing any feature code. Results in order:

| Step | Result |
| --- | --- |
| Admit, then revoke the peer | works, `base.writable` goes false |
| Re-admit the OLD key | **refused** - the denylist holds |
| Rotate via `setLocal(newKey)` | **works**, `base.local.key` changes |
| Admit the NEW key | **works**, `base.writable` goes true again |
| The rotated peer writes | lands in its OWN view |
| ...does it reach the other peer? | **NO** |
| ...after re-establishing the connection? | **YES** |
| Old key still denied at the end | yes |

**The mechanism.** `setLocal(key)` resolves the key through `store.get({ key })`,
which only yields a SIGNABLE core if the corestore already holds that keypair. So
the new key must come from a named core in the base's own namespace
(`store.namespace(ns).get({ name: 'local-2' })`), not be generated freely. Confirmed
working.

### THE TRAP, and it is the whole reason this was measured first

A rotated peer reports `writable: true` and writes happily into its own view, while
its edits reach **nobody**, until the replication connection is re-established. The
other peer never picks up a writer core that was created after the stream was
opened.

In the app that is the worst shape a bug can take: the re-paired phone looks
completely healthy - it is on the roster, it is writable, its own screen updates -
and the household simply never sees anything it does. It would present exactly like
the "silently half-working" failure this proposal already flagged for `seedGroups`,
and it would be blamed on sync.

**So rotation MUST be followed by a reconnect of that base's peers**, not treated as
a local operation that completes when `setLocal` resolves. That is a hard
requirement on the implementation, not a nicety, and it needs its own test: assert a
rotated peer's write reaches another peer *without* the test manually reconnecting.

## Scope

Narrowed by the correction above - spaces need no change at all.

1. `device:rotateLocalWriter` in the worklet: take a fresh NAMED core from the
   base's own namespace, `setLocal` on the PERSONAL base, persist which name is in
   use so a later rotation does not collide. Only that base refuses re-admission.
2. **Reconnect that base's peers after rotating.** Non-negotiable - see the trap
   above. A rotation that is not followed by a reconnect produces a phone that
   looks healthy and is invisible to everyone else.
3. Shared spaces: nothing. A removed phone is re-admitted to a space by an ordinary
   `addWriter`, which the existing `grantGroupWriter` already appends. Verified in
   `test/readmission.test.js`.
   ONE THING TO CHECK: `seedGroups` SKIPS a space the device is already in ("the
   common case for a re-pair"), so nothing currently re-grants a space writer for a
   space the phone never left. That skip is right for joining and wrong for
   re-admission, and it is the likeliest place for this to half-work.
4. **Fix the `_w` staleness check** - compare against the base's current local key
   instead of testing presence (see answer 1). This is not optional garnish: without
   it a re-paired phone cannot be removed again properly, which turns a recovery
   feature into a way to defeat the removal feature.
5. UI: when pairing fails because this device was removed, offer "set this phone up
   again" rather than an error. That is the whole user-facing surface.

## Open questions - ANSWERED 2026-07-30

### 1. Only the Autobase writer key rotates. The identity keypair does not.

They are separate: `pubkeyHex(ctx)` (core's per-device signing key, the `appPubkey`)
versus `base.local.key` (the Autobase writer core). Only the second is what
`addWriter` / `removeWriter` name, and only the second is refused by the denylist.

The identity must NOT rotate, because it is what makes the phone still *you*:
`member:{pubkey}` rows, the `identityProof` attestation, `assignee` routing and
`createdBy` all key off it. Rotating it would make the phone a new person - losing
its assignments, needing re-attestation, and leaving its old member row behind as a
ghost that `collapseMembers` cannot merge away.

**But this surfaces a problem that has to be fixed as part of the work.** The `_w`
binding on a member row records the writer key that wrote it. After a rotation it
is STALE - it names the dead key. And the readiness check does not notice:

```js
const bound = !!(mine && typeof mine._w === 'string')
if (armed && mine && !bound) publishMember(ctx, groupId).catch(() => {})
```

(`space:revocationStatus`) It tests only that `_w` is *present*, not that it matches
the writer this device actually uses now. So after a rotation `bound` stays true,
the republish never fires, and `_w` keeps naming a key that was revoked ages ago.

The consequence is the bad one: a LATER removal of this phone would append
`revokeWriter` for the dead key and silently do nothing - a removal that degrades to
hide-only, which is exactly the failure that comment warns about and that was found
on-device once already.

**Required change:** compare `_w` against `ctx.bases.get(groupId).local.key` rather
than checking presence, and republish when they differ. That also makes the check
correct for any future reason a writer key changes, not just this one.

### 2. Nothing lingers, on either base.

- **Shared spaces:** the identity does not change, so there is no second member row
  - it is the same row, and `_w` re-derives on the next publish (applyListOp stamps
  it from `node.from.key` on every member write while armed). No duplicate member,
  nothing to tombstone.
- **Personal base:** `deviceMetaHidden:` is keyed by WRITER key
  (`peerloom-device-link/src/personal.js`), so the removed row stays hidden under
  the old key while the rotated device publishes a fresh row under its new one. No
  ghost and no duplicate in the roster.

One detail worth knowing rather than tripping over: a `deviceMeta` put DELETES the
hidden tombstone for its own writer key. That cannot resurrect the removed row here,
because the old key can never append again - but it means the tombstone is not a
permanent record, and nothing should be built on it as if it were.

### 3. Explicit, confirmed.

A phone that silently re-keys and re-admits itself is the shape the denylist exists
to prevent, even though the pairing handshake would still gate it. It also makes the
UI honest: the user asked for this phone to come back.

## Verify

- Unit: a rotated key is admitted while the old key stays refused, on a real
  Autobase (the `test/readmission.test.js` harness shape, not a mock view).
- Unit: the `revokedWriter:` row survives the rotation - removal must still stick.
- **Unit: a re-paired phone can be removed AGAIN and it actually revokes.** This is
  the regression that the `_w` staleness would cause, and it is the one that turns
  the feature into a hole. Assert the second removal names the CURRENT writer key.
- Unit: `space:revocationStatus` reports unbound when `_w` names a key that is not
  this base's local key.
- Two-device, hardware: remove a phone, rotate + re-pair it, confirm it returns as
  ONE member and not two, and that the old key is still refused.
- An old peer in an armed space is unaffected, since no apply rule changed.
- `npm run verify` green.

## Rollback

Nothing is written to a shared view, so reverting the code reverts the feature. A
phone that already rotated keeps its new key and stays admitted, which is correct
and needs no undo.
