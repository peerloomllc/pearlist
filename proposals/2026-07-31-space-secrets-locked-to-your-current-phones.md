# Space secrets locked to your current phones

**Status:** SUPERSEDED 2026-08-01, unbuilt. See below.
**Tier:** T3 (key management)
**Date:** 2026-07-31
**Amends:** `2026-07-31-your-spaces-follow-you.md`, Open question 1

## SUPERSEDED - the threat it defends against was ruled out of scope

This exists to stop a phone you have REMOVED from learning the secrets needed to
join spaces you create afterwards. Tim settled what removal means the same evening,
after measurement showed a removed member gets re-admitted over a live connection
(DECISIONS.md, "Removing someone from a space is a ROSTER action, not a lock"):

> I don't care about "if they lose their phone and need to revoke access" because
> they can just delete a space and create a new one.

That is precisely the threat this seals against, so sealing buys nothing he wants
and costs a two-repo cryptography change. `2026-07-31-your-spaces-follow-you.md`
shipped instead with the plain record it originally proposed (PR #174), which is
the T2 it started as.

Two things narrow the exposure further, and are worth recording so the trade is not
re-litigated from memory:

- These secrets **already** cross the pair channel today, in `collectGroups`. Putting
  them on the personal base changes their durability, not who can see them.
- Removing your last other phone now mints a fresh personal base that the removed
  phone cannot read at all (device-link #15), so the common case is covered by
  rotation rather than by encryption.

**WHAT IS STILL TRUE HERE, and why this file is kept rather than deleted:** the
analysis of why the obvious "ask my other phone for the secrets" design cannot work -
every linked device holds the mnemonic, so a removed phone proves it is you perfectly -
is unaffected by the decision. If space removal is ever wanted as a real boundary,
start here rather than rediscovering it.

The rest of this document is left exactly as approved.

## Why this exists

The parent proposal asked one question it refused to answer:

> **Do the join secrets belong on the personal base at all?** ... **This should be
> decided before implementation**, because it is the one choice that cannot be rolled
> back.

Tim chose to fetch them live rather than store them in the clear. Working out how to
do that turned up something that makes the naive version of "fetch live" useless, and
this proposal is the design that survives it.

## The thing that breaks the obvious design

"Ask another of my phones for the secrets" needs the answering phone to decide whether
the asker is a phone the person still has. That decision cannot be made from identity.

**Every linked device is given the person's mnemonic** (`personal.js:527`,
`keystore.setMnemonic(parsed.mnemonic)`). So a removed phone can prove it is you,
perfectly and forever. Any challenge-response over identity keys authenticates the
attacker as well as the victim.

And removal does not take reading away. `device:remove` writes `revokedWriter:` and
calls `base.removeWriter` (`personal.js:135-152`). That stops it **appending**. It
keeps the personal base key, keeps replicating, and keeps the mnemonic.

The personal base says as much, in the comment justifying why its rules are looser
than a shared space's:

> there is no lesser-privileged party to defend against. That is NOT true of a shared
> space, which is why the space-side change needs a real same-identity check and its
> own capability gate.

That was true when it was written. Device removal created a lesser-privileged party
and the base's threat model was never revisited. This proposal is the first thing to
depend on the distinction, which is why it is the first thing to hit it.

## The one thing removal DOES take away

A removed device cannot **append to the personal base**. Its writer is out of the
writer set, so its ops are not in the log at all.

Everything here rests on that single property, because it is the only one that
actually holds.

## Design

**Each device publishes a public lock. Space secrets are sealed to the locks of the
devices you currently have.**

### 1. A per-device box keypair

On first run of a linked device, generate a curve25519 keypair.

- Secret half: `localDb`, device-local, never replicated, never leaves the phone.
- Public half: published as `boxPubkey` on that device's own `deviceMeta` row.

`deviceMeta` is the correct carrier and needs no new record type. It is keyed by the
device's personal-base writer key and is **self-attested**: `decideDeviceMetaPut`
rejects any row whose `writerKey` does not equal the Autobase-attested author
(`device-meta.js:16`). A removed device cannot author one, because it cannot append.

There is already a precedent for carrying an app-level key on this row. `appPubkey`
exists so PearList can map a device between the two key spaces it otherwise cannot
join up. `boxPubkey` is the same move.

### 2. The space record, sealed per device

When a device joins or creates a space, it appends to the personal base:

```
type: 'space'
key:  'space:' + groupId
value: {
  groupId,
  name,                       // cleartext: it is already on the roster of every member
  at,
  sealed: [                   // one entry per CURRENT device
    { writerKey, box }        // box = crypto_box_seal(secrets, thatDevice.boxPubkey)
  ]
}
```

`secrets` is exactly what `collectGroups` already gathers and `joinGroup` already
needs: `{ groupKey, encryptionKey, bootstrap }`.

The seal list is built by reading the current devices out of the replicated view and
**skipping any whose writer is revoked**. That decision is made by a current device
from replicated state, so every device agrees on it.

### 3. Opening it

A device receiving the record finds the entry matching its own writer key, opens it
with its box secret, and joins via the existing `seedGroups` path, which already skips
a space the device is in (`deviceLink.js:283`).

A device that finds no entry for itself does nothing. That is the correct outcome for
a removed phone, and also for a phone on a build too old to have published a
`boxPubkey`.

### Why not reuse the keys that already exist

- **Identity keys.** Derived from the mnemonic, which a removed device has. Useless
  here, and using them would look secure while defending nothing.
- **The Autobase writer core keypair.** This one WOULD work, since each device's is
  its own and a removed device's is revoked. Rejected on implementation risk: nothing
  in either repo reaches the secret half today, only `.key` (checked across
  `personal.js`), so it means reaching into corestore internals for the one thing that
  must not be fragile.
- **A fresh per-device keypair.** Costs one record field, uses only public API, and
  the thing that makes it trustworthy (you cannot publish a lock without being able to
  append) is the property we already established is the only reliable one.

## What this does NOT protect

Stated plainly, because a security design that oversells itself is worse than none.

- **Spaces created BEFORE the removal.** Those records are sealed to that device and it
  can still open them. That is correct: it legitimately had access at the time, and it
  has the space keys locally anyway. Nothing can retract that.
- **Anything else on the personal base.** Device names, profile, the roster and every
  future record stay readable by a removed device. This proposal fixes one record type.
  The general fix is rotating the personal base on removal, which is its own item.
- **Forward secrecy.** `crypto_box_seal` has none. If a device's box secret is
  extracted later, every record sealed to it opens. Acceptable here because that device
  also has the mnemonic and its local space keys, so the box secret is not the weakest
  thing on it.

So the claim is narrow and true: **a phone you removed cannot join spaces you create
after removing it.** That is the gap the parent proposal opened and this closes.

## Compat

**T3 because it is key management**, not because it breaks the wire. No shared-space
wire rule changes. Nothing a household member on another person's phone can observe
changes. The blast radius is one person's own devices.

- **An old build on a linked phone** does not register the `space` record type, so apply
  drops it (`records.js`, `decideRecordPut`). It keeps getting spaces at pair time and
  no later, exactly as today. Degraded, not broken, no fork, because the personal base
  is per person and nobody signs a shared view off it.
- **A linked phone with no `boxPubkey`** cannot be sealed to and is skipped. It is not
  an error and must not be treated as one, or a mixed-version pair fails loudly for a
  reason the user cannot act on.
- **Writer rotation on re-pair** (`personal.js:543`) re-keys the device's `deviceMeta`
  row, so it must republish `boxPubkey` on the new row. Records sealed to the OLD writer
  key are unopenable afterwards, which is fine: a re-paired device gets its spaces from
  `seedGroups` at pair time.
- **Migration:** none. Existing spaces keep working from `groups:joined:`. Backfill is
  deliberately NOT done, because sealing historical spaces would seal them to whatever
  device set exists at backfill time, which is a different and less defensible claim
  than sealing at creation.

## Verify

- Unit, pure: seal to N devices, open with each secret, and confirm a non-recipient
  secret fails. No Autobase.
- Unit: `decideDeviceMetaPut` still rejects a row carrying a `boxPubkey` if the author
  does not match. The self-attestation is the load-bearing check and must be pinned
  against a row that looks otherwise valid.
- Autobase harness, two devices of one person: create a space on A after linking, and
  assert B joins with no invite. The parent proposal's headline case.
- Autobase harness, **the security claim**: link A and B, remove B, create a space on
  A, and assert B's view contains the record but B cannot open it and does not join.
  This must fail if the seal list is built without consulting the revocation, so it is
  the test that proves the feature rather than the plumbing.
- Autobase harness: a linked device with no `boxPubkey` is skipped and the others still
  receive theirs.
- Hardware: TCL creates a space, linked iPhone joins with nothing sent between them.

Per `[[mock-view-hides-apply-bugs]]` and `[[autobase-harness-beats-hardware]]`, the
security assertions run against a real Autobase. A mock view would let the revocation
check pass vacuously, which is the one failure mode that matters here.

## Rollback

- **Before release:** revert both PRs. Unregistered record types are dropped, so a
  reverted build ignores anything written.
- **After release:** reverting stops new records being written and acted on. Records
  already on the base are inert, the same end state as an old build. No cleanup pass,
  and none should be attempted: deleting from a personal base other devices are still
  reading is how the resurrection bugs start.
- **What does not roll back:** sealed records stay in the log. That is the point of
  choosing sealed over cleartext. A revert leaves ciphertext nobody reads, whereas a
  revert of the cleartext design would leave secrets nobody can retract. This asymmetry
  is the main reason to build this version.

## RCA readiness

Required for T3. The failure that would matter is **a device that should have received
a space silently not receiving it**, since every step is best-effort and silence is the
house failure mode (`[[autobase-silently-skips-missing-data]]`).

- Trace on the sealing side: how many devices were in the seal list, and how many were
  skipped for revocation versus for a missing `boxPubkey`. A drop to zero recipients is
  the signature of the bug and is otherwise invisible.
- Trace on the opening side: record seen, entry for self found or not, open succeeded or
  failed. "Found no entry for myself" and "found one and could not open it" are very
  different faults and must not share a log line.
- Both go through the existing `_trace` pair-trace buffer, which
  `scripts/pull-pair-trace.sh` already pulls (`[[pull-pair-trace-first]]`).

## Open questions

1. **Does the box secret belong in `localDb` or the OS keystore?** The keystore
   interface today is only `hasMnemonic` / `getMnemonic` / `setMnemonic`, so the
   keystore route means widening it in device-link. `localDb` is device-local and never
   replicated, which is probably enough, but this is a secret and the question deserves
   a deliberate answer rather than defaulting to whatever is easier.
2. **Should removal ALSO rotate the personal base?** That is the real fix for the whole
   class and would make this proposal unnecessary for future records, though not for
   this one. Recommend filing separately rather than growing this.
3. **Two PRs or one?** `boxPubkey` on `deviceMeta` is device-link, the `space` record
   and sealing are PearList. They must land device-link first, since PearList's version
   depends on a field the other repo publishes.
4. **What does the UI say when a linked phone gets no entry?** Today: nothing, it just
   does not get the space. Silent is wrong given how much of this app's history is
   silent failures, but a message about locks and keys is worse than none.
