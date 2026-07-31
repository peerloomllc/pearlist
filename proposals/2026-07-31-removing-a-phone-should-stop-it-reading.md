# Removing a phone should stop it reading

**Status:** proposed
**Tier:** T3 (key management, security-critical)
**Date:** 2026-07-31

## The forcing function

Tim, after being told that removal denies writing and never denies reading, and asked
whether to fix the general case before building the sealing workaround:

> Propose it next, before any code. If removal minted a fresh personal record,
> plaintext secrets would be safe and the sealing scheme would be unnecessary for
> anything new. Worth knowing that before building the workaround.

That is exactly the right instinct and exactly the right moment to ask. **The answer
is not the one the question expects, which is why it was worth asking.**

## The headline: rotation NEEDS the sealing primitive, it does not replace it

Rotation means minting a new personal base the removed device does not have, and
moving the remaining devices onto it. The step that decides everything is the last one:
**how do the remaining devices learn the new base key?**

Not over the old base. The removed device is still replicating it and would read the
new key immediately, which converts the whole exercise into an elaborate no-op.

So the new key has to reach the remaining devices over something the removed device
cannot read. That is precisely the problem
`2026-07-31-space-secrets-locked-to-your-current-phones.md` (PR #167) exists to solve,
and its answer is the only one available: seal to a per-device key that a removed
device cannot possess or publish, resting on the one property removal actually
provides, which is that a removed device cannot append.

**So `boxPubkey` is a prerequisite for rotation, not a workaround that rotation makes
unnecessary.** The dependency runs the opposite way to the assumption.

### With one exception, and it is the common case

At **two devices**, rotation is trivial. Remove one and there is exactly one device
left, so there is nobody to distribute a new key to. The remaining phone mints a fresh
base for itself and the problem disappears.

The distribution problem only exists at **three or more devices**. Tim runs three, so
it is not hypothetical here, but it is worth being precise: for most users, most of
the time, rotation needs no key distribution at all.

That suggests shipping rotation in two stages, and the first stage is genuinely small.

## The ceiling: rotation cannot make a removed phone stop being you

This bounds the value of everything below and has to be stated before the design, not
buried in a caveat.

Identity is derived from the mnemonic, and every linked device is given the mnemonic.
From `identity.js`:

> **EACH DEVICE ATTESTS ITSELF.** Both devices hold the mnemonic after pairing, so each
> bootstraps its own key independently.

A removed phone can therefore mint a fresh device key, attest it to your identity root,
and present itself as you in any space it can reach. Rotating the personal base does
not touch that. It changes what the phone can **read**, never who it can **claim to
be**.

Making removal revoke identity means rotating the mnemonic, which changes your identity
root in every space you are in and invalidates every attestation on every roster. That
is almost certainly the wrong trade for a household list app: your identity should not
change because you sold a phone.

So the honest layering, with what each step actually buys:

| Layer | Buys | Status |
| --- | --- | --- |
| Writer revocation | removed phone cannot change your personal base | shipped |
| Sealing (PR #167) | cannot read space secrets created after removal | proposed |
| Base rotation (here) | cannot read anything on your personal base after removal | this |
| Identity rotation | cannot BE you | out of scope, probably forever |

Level 4 being unreachable is the reason to be sober about level 3. Rotation is worth
doing because it closes a whole class rather than one record type, not because it makes
a removed phone harmless. It does not.

## What is actually exposed today

Everything on the personal base, forever, to any phone ever linked and later removed:

- `deviceMeta:` rows: every device's name, its app pubkey, when it was seen
- `identityProfile` and `profile`: display name, avatar
- `deviceGroupWriter`: which spaces you are in, by groupId, and the writer keys
- `revokedWriter:`: which devices you removed and when
- every record type added in future, automatically, with no review step

That last line is the real problem. The base has no notion of a lesser-privileged
reader, so **every new record type is exposed by default and nothing prompts anyone to
notice**. PR #167 is the first change to hit it and only because it happened to carry
secrets. A future record would not get that scrutiny.

## Design

### Stage 1: rotate when nobody needs telling

When a removal leaves **exactly one device**, that device mints a fresh personal base
and migrates its own state onto it.

- Mint a new Autobase, write the new key to `personalMeta:bootstrap`.
- Copy forward from the old view: this device's own `deviceMeta` row, `identityProfile`
  / `profile`, and `deviceGroupWriter` rows for spaces it is still in.
- Do NOT copy `revokedWriter:` rows. The removed device was never a writer on the new
  base, so there is nothing to deny. Carrying them over would be cargo cult.
- Leave the old base's swarm topic and stop replicating it.
- Keep the old base on disk, unreplicated, until the next launch confirms the new one
  opened. Deleting it eagerly is how a half-finished rotation becomes an unrecoverable
  one.

No distribution, no new crypto, no new record type. This is the whole feature for
anyone with two phones.

### Stage 2: rotate with distribution

When two or more devices remain, the rotating device seals the new base key to each
remaining device's `boxPubkey` and appends the sealed bundle **to the old base**. That
is safe precisely because it is sealed: the removed device replicates the record and
cannot open it.

Each remaining device opens its entry, switches `personalMeta:bootstrap`, and reopens
on the new base. Depends on PR #167 landing first, since `boxPubkey` is published
there.

### The failure that will actually happen

**A device offline during rotation never learns the new key.** It keeps replicating the
old base, sees no new devices, no profile changes and no new spaces, and looks
completely healthy. This is the house failure mode
(`[[autobase-silently-skips-missing-data]]`, `[[rotated-writer-is-invisible]]`) and it
must be designed for rather than discovered.

Mitigations, all three needed:

1. The rotating device keeps replicating the old base for a grace period and keeps
   re-appending the sealed bundle, so a device that comes back within the window
   catches up on its own.
2. A device that finds itself the only writer on a base that used to have several
   treats that as "I may have been left behind" and says so, rather than showing an
   empty roster as if it were the truth.
3. Re-pairing is the recovery path and must be reachable without wiping the app. The
   re-pair flow already exists and already rotates writer keys (`personal.js:543`).

## Compat

**T3, key management, and the blast radius is one person's own devices.** No
shared-space wire rule changes. No household member on another person's phone observes
anything.

- **A remaining device on an old build** does not understand the rotation record, stays
  on the old base and is silently orphaned. This is the worst compat case in the
  proposal and it is not solvable in the old build by definition. Stage 1 avoids it
  entirely (nothing to distribute); stage 2 must gate on every remaining device
  advertising support, the same capability-gate shape the spaces already use for
  `revoke1` / `revoke2` / `promote1`.
- **Migration:** the rotation IS the migration. Nothing to backfill.
- **The old base is not deleted**, so a botched rotation is recoverable by pointing
  `personalMeta:bootstrap` back at it.

## Verify

- Unit: state migration copies deviceMeta, profile and deviceGroupWriter forward, and
  does NOT copy `revokedWriter:`.
- Autobase harness, stage 1: link two devices, remove one, and assert the survivor is on
  a NEW base key, that its profile and space list survived, and that the removed device
  replicating the OLD key sees nothing written afterwards. That last assertion is the
  security claim and must fail if rotation is skipped.
- Autobase harness, stage 2: three devices, remove one, and assert both survivors reach
  the new base and the removed device cannot open the sealed bundle.
- Autobase harness, the offline case: three devices, one offline during rotation, and
  assert it recovers when it returns within the grace period, and that it reports being
  left behind rather than showing an empty roster when it does not.
- Per `[[autobase-harness-beats-hardware]]` and `[[mock-view-hides-apply-bugs]]`, every
  security assertion runs against a real Autobase. A mock view would let "the removed
  device sees nothing" pass vacuously, which is the only assertion that matters.

## Rollback

- **Before release:** revert. Nothing has rotated.
- **After a stage 1 rotation:** the old base is still on disk, so pointing
  `personalMeta:bootstrap` back at it restores the previous state, minus anything
  written to the new base in between. Recoverable but lossy, and the loss window is why
  the old base is kept rather than deleted.
- **After a stage 2 rotation:** the same, except every remaining device must be rolled
  back together. A pair split across two bases is a worse state than either base alone,
  which is the strongest argument for gating stage 2 on a capability the way spaces
  already gate arming.
- **What does not roll back:** nothing here writes a secret that cannot be retracted,
  which is the main way this differs from the cleartext design rejected in the parent
  proposal.

## RCA readiness

Required for T3. The failure to instrument is a device silently left on the old base.

- Trace at rotation: how many devices remained, how many were sealed to, how many were
  skipped for a missing `boxPubkey`. Zero recipients with survivors remaining is the
  signature and is otherwise invisible.
- Trace at open: bundle seen, entry for self found or not, switch succeeded or failed.
  "No entry for me" and "found one and could not open it" are different faults and must
  not share a log line.
- A device must be able to answer "which base am I on, and when did it change" from the
  pair trace alone, since the symptom is indistinguishable from an idle app.
- Both ride the existing `_trace` buffer that `scripts/pull-pair-trace.sh` pulls
  (`[[pull-pair-trace-first]]`).

## Open questions

1. **Ship stage 1 alone first?** Recommend yes. It is small, needs no crypto, no
   capability gate and no new record, and it is the entire feature for a two-phone user.
   Stage 2 then lands behind PR #167 without holding stage 1 hostage.
2. **How long is the grace period for an offline device?** Too short orphans a phone in
   a drawer, too long means the removed device keeps reading the old base while it
   remains replicated. Note the old base keeps receiving writes during the grace period,
   so this is a direct trade against the thing the proposal exists to fix.
3. **Should rotation happen on every removal, or only on a removal the user marks as
   "this phone is lost"?** Every removal is simpler and safer. A prompt invites the
   wrong answer at the worst moment, but rotating on a routine tidy-up of an old phone
   costs an unnecessary migration.
4. **Does the `space` record from the parent proposal still need sealing once rotation
   ships?** Yes, for spaces created between a removal and the rotation completing, and
   for any device left on the old base during the grace period. The seal is not made
   redundant, only less load-bearing.
5. **Is level 4 truly out of scope?** Recorded here so it is a decision rather than an
   omission: a removed phone keeps the mnemonic and can present itself as you forever.
   If that is ever unacceptable, it is a different and much larger proposal.
