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

**The denylist is not only an anti-theft measure, and this is the part that is easy
to get wrong.** Autobase apply is deterministic over the whole log: the original
`addWriter` for that device is still in there and is re-applied every time the view
is rebuilt. Without a replicated record that the key was revoked, the removal would
silently undo itself on the next rebuild. The denylist is what makes removal stick
at all.

So it must not simply be deleted.

## Two designs

### Rejected: an `unrevokeWriter` op

Add an op that removes the `revokedWriter:` row, so a later `addWriter` is honoured
again. Ordered apply makes this coherent (admit at 5, revoke at 20, un-revoke at
40, admit at 41 - every device computes the same final writer set).

Rejected on cost, not on correctness:

- It is **consensus state**, so a peer that does not understand `unrevokeWriter`
  computes a different writer set and SILENTLY FORKS. That means a third capability
  after `revoke1` and `revoke2`, with the same "every member must advertise it
  first" gate and the same long tail before it can ever be armed. See
  `test/forkSafety.test.js` for what that failure actually looks like.
- It makes a security-relevant rule conditional, and the rule is currently
  absolute and easy to reason about: a revoked key is dead everywhere, forever.
- It buys nothing the alternative does not.

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

## Scope

1. `device:rotateLocalWriter` in the worklet: mint a keypair, `setLocal`, persist.
2. The personal base is the only base that must admit the new key at pairing time -
   the existing `grantGroupWriter` already re-grants per space.
3. UI: when pairing fails because this device was removed, offer "set this phone up
   again" rather than an error. That is the whole user-facing surface.

## Open questions

1. **Does the core per-device identity keypair rotate too, or only the Autobase
   writer key?** They are separate (`appPubkey` vs writer key). Rotating only the
   writer means the phone keeps its identity and its member rows, which is probably
   what a user wants - it is still their phone. Needs checking against
   `memberIdentity` and the `_w` binding, because a stale binding is what makes a
   removal silently degrade to hide-only (see `space:revocationStatus`).
2. **What happens to the old, revoked member row in each shared space?** It should
   stay as a tombstone. Confirm the rotated device does not show up twice.
3. **Should this be automatic on detecting revocation, or explicit?** Explicit. A
   phone silently re-admitting itself is exactly the shape the denylist exists to
   prevent, even if the handshake would still gate it.

## Verify

- Unit: a rotated key is admitted while the old key stays refused, on a real
  Autobase (the `test/forkSafety.test.js` harness shape, not a mock view).
- Unit: the `revokedWriter:` row survives the rotation - removal must still stick.
- Two-device, hardware: remove a phone, rotate + re-pair it, confirm it returns as
  ONE member and not two, and that the old key is still refused.
- An old peer in an armed space is unaffected, since no apply rule changed.
- `npm run verify` green.

## Rollback

Nothing is written to a shared view, so reverting the code reverts the feature. A
phone that already rotated keeps its new key and stays admitted, which is correct
and needs no undo.
