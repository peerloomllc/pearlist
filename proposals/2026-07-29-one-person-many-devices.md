# 2026-07-29 - One person, many devices: what a member IS

**Status:** READY 2026-07-29, awaiting approval. All open questions closed - three
answered with evidence while drafting (which rewrote two of the three options),
the fourth decided by Tim: **the members list shows one person, with no mention of
devices.** Follows PR #123 (the linking UI), which closed the last of the
buildable gaps in proposals/2026-07-28-device-linking.md. Everything left is this.

**Goal**

Decide what a space member represents - a device or a person - so that linking a
second phone does not make one person appear, and behave, as two.

**Tier**

T3. Both live options change what other people's devices have already accepted:
one adds a new signed field that routing depends on, the other changes how the
signing key itself is derived. Either way an old peer and a new peer must still
agree, and the wrong answer strands people from their own spaces.

## The forcing function

The visible symptom is cosmetic and it is the least of it. Watched on hardware
2026-07-29: pairing a second phone took ThreeWay from 3 members to 4, and the
household now sees the same person twice with nothing saying so.

The real problem is that **routing is keyed to a device**, so a person with two
phones is not merely displayed wrong, they are addressed wrong. In
`src/listWire.js`:

```js
if ((isItem || isList) && value.assignee === selfKey) { ... emit('notify:assigned') }
```

`selfKey` is this device's pubkey. `assignee` is a device pubkey. So:

- **Assign a chore to Tim and only one of his phones ever tells him.** Whichever
  phone's key was picked in the assignee menu is the only one that fires. The
  other is silent, and it is the same person.
- The **completion** leg has the same shape and a second failure mode: it routes to
  `list.createdBy`, so a list created on the Pixel notifies the Pixel forever, even
  after the person has moved to a new phone entirely.
- `member:remove`, ownership and every other per-person judgement inherit this.

This is already recorded as a hazard in memory
(`device-identity-is-not-a-person`), written down before device linking existed.
Linking does not create the problem; it makes it ordinary. Today you need two
installs to hit it. After the flag flips it is the advertised feature.

So the choice is not "do we tidy the members list". It is: **ship a feature that
makes assignment unreliable for anyone who uses it, or decide what a member is
first.**

## The options

### A. Do nothing - flip the flag, accept two rows

Costs nothing to build. Ships one-tap seeding of every space onto a second phone,
which is a real convenience with six spaces.

Rejected as a default, not because of the duplicate row but because of the
routing. Shipping a chore board whose assignments silently reach one of a person's
phones is worse than not shipping linking. It is also the hardest to walk back:
the flag reverts, the extra member rows in other people's spaces do not.

Worth keeping on the table only if linking is scoped to people who do not use
assignment - which is not a thing the app can know.

### B. Attest the device - publish a proof on the member row

**This section was rewritten after answering open questions 3 and 4 below. The
first draft proposed a self-attested `personId` hash. That is strictly worse than
what the stack already provides and should not be built.**

`keet-identity-key` - already a device-link dependency, already in the worklet
bundle - exists for exactly this problem. The identity key derived from the
mnemonic **attests** each device's own key, producing a proof any peer can verify:

```js
const proof0 = await id.bootstrap(deviceA.publicKey)                    // first phone
const proof1 = await IdentityKey.attestDevice(deviceB.publicKey, deviceA, proof0)
IdentityKey.verify(proof1, null)  // -> { identityPublicKey, devicePublicKey }
```

So the member row carries `identityProof` (bytes), not a hash anyone can claim.

- **Correlation.** Two member rows whose proofs verify to the same
  `identityPublicKey` are one person. Verified, not asserted.
- **Display.** Those rows collapse to one.
- **Routing.** `assignee` keeps meaning a device key on the wire; the notify rule
  matches if `assignee === selfKey` OR the assignee's row proves the same identity
  root as mine.
- **Compat.** Additive optional field - same argument as `caps`, `kind` and
  `remindAt`. `rowApplyDecision` validates only pubkey/updatedAt/sig/namespace and
  `applyListOp` stores rows verbatim, so an old peer preserves the field on a
  read-modify-write and never forks. An old peer shows two rows and routes to one
  device: exactly today's behaviour, which is the correct degradation.
- **Cost.** Measured: 139 bytes for a bootstrapped device, 235 for an attested
  second one. Roughly 190-315 chars base64 on a row that today holds a display
  name and an avatar reference. Not free, not a problem.

**Forgery fails, measured.** Attesting an attacker's own key against someone
else's proof, signed with the attacker's own keypair, does not verify. That closes
the impersonation hole the self-attested version would have opened - which is why
that version is withdrawn rather than kept as a cheaper alternative.

**What it still does not fix.** A reinstall publishes a new member row with a new
device key. The proof makes it *provably the same person*, which is enough for
display and routing - but restoring ownership additionally requires `space.owner`
checks to accept an identity root rather than a device key. That is a separate,
smaller change this proposal does not make, and it is now possible without
touching key derivation at all.

### C. Mnemonic-root - derive the signing key from the phrase

Slice 4 of the device-linking proposal. **The framing in that proposal, and in the
first draft of this one, was wrong**, and open question 3 is what exposed it.

The assumed mechanism was "both phones sign as the same member", i.e. share one
writer key. That is not viable and never was: an Autobase writer is a Hypercore,
Hypercore is a single-writer append-only log, and it carries an explicit `fork`
counter with detection logic (`hypercore/lib/core.js` - "both proofs are valid,
now check if they forked"). Two devices appending to one core at the same index is
precisely the forked condition. Autobase gives each writer its own core for this
reason.

So option C, in the form it was written, is **not expensive - it is unavailable**.

What remains of the idea is per-device keys *derived from* the mnemonic rather
than generated randomly. That gets a reinstall its old key back, which is real -
but it does NOT collapse two phones into one member, because two devices still
need two distinct keys. It would therefore still need option B on top to solve the
problem this proposal is about, while additionally carrying the migration the
device-linking proposal warned about:

> Every space in the field has member rows and an owner keyed to the current
> per-device keys. Changing how that key is derived either needs those identities
> carried across [...] or it orphans people from their own spaces.

Recommend dropping C from this decision entirely and reopening it later, on its
own terms, as "should a reinstall recover its old device key" - which is a
different question from "is this the same person".

## Scope

**In:** the decision, and whichever of B or C follows. **Out:** anything that
changes what `assignee` *stores* on the wire. Both options deliberately keep
`assignee` a device key so old peers keep working.

**Recommendation: build B, drop C from this decision, and do not flip the flag
until B ships.**

That is a stronger recommendation than the first draft made, because answering the
open questions removed the tradeoff rather than resolving it. B is no longer "the
cheap option with a self-attestation risk" - it is verified by the identity key,
it uses a library already in the bundle, it is additive, it degrades on old peers
to exactly today's behaviour, and it fixes the routing failure that actually harms
people. C is not the expensive-but-correct alternative it was described as; in the
form written it cannot be built at all.

## Compat

- **B:** additive optional field. Old peers store it verbatim, show two rows and
  route to one device - today's behaviour. No migration, no fork. A device that
  has never linked publishes no proof and is unaffected.
- **C:** withdrawn. If the residual idea (mnemonic-derived per-device keys) is
  ever picked up it is not additive and needs identities carried across plus its
  own old-peer fork test.

## Verify

- `npm run verify` green.
- Unit: two member rows whose proofs verify to the same identity root collapse to
  one; rows with no proof are never merged (an absent proof must not match another
  absent one, or every unlinked member becomes the same person).
- Unit: a proof that does not verify is IGNORED, not trusted and not fatal - a
  malformed or forged row must leave the member visible as their own device rather
  than merging them into someone else or hiding them.
- Unit: the notify rule fires for an assignment to *either* of a person's devices,
  and does not fire for a different person in the same space.
- **On hardware, three devices, and this is the point of the change:** assign a
  chore to a person who has two linked phones and confirm BOTH notify. The rig
  from 2026-07-29 (TCL + Pixel + iPhone SE) is the one to use.
- Old-peer check: a device on the pre-change build in the same space still sees
  its lists, can still edit, and does not fork.

## Rollback

B reverts cleanly: stop publishing `personId` and stop reading it. Rows already
carrying it are ignored by a build that does not know the field, which is the same
position an old peer is in. Nothing needs unwinding.

C does not revert - once a space has accepted rows signed by a mnemonic-derived
key, changing the derivation back strands them. That asymmetry is most of why B
goes first.

## Open questions

**1. ANSWERED - the proof goes on the MEMBER row, not the item.** On the member
row it is published once and every reader correlates for itself. On the item it
would have to be written at assign time, freezing today's answer into rows that
outlive it - and an assignment made before a second phone was linked could never
learn about it. Nothing argues the other way once stated, so this is settled
rather than open.

**2. ANSWERED by Tim 2026-07-29 - one person in the members list, no mention of
devices.** The members list shows people. It does not show, hint at, or let you
expand to see how many phones anyone is carrying.

Consequences the implementation has to honour:
   - No device count, no "2 devices" badge, no expandable row. If it would tell a
     housemate something about your hardware, it does not belong here.
   - The roster in your own Settings stays the only place devices are visible, and
     it stays yours: it lists YOUR phones, never anyone else's.
   - The avatar and display name come from ONE of the collapsed rows, so the merge
     needs a deterministic pick - most recently updated row wins, so a rename on
     your newer phone shows rather than whichever row happened to sort first.
   - A member the app cannot prove is you stays a separate row. Collapsing on a
     guess would be the one way this decision could mislead someone.

**3. ANSWERED - no, and it is the wrong question.** Two devices cannot share one
Autobase writer: a writer is a Hypercore, Hypercore is single-writer append-only
and carries an explicit `fork` counter with detection (`hypercore/lib/core.js`),
so two devices appending to one core at the same index is the forked condition by
definition. Autobase gives every writer its own core for exactly this reason.
**But nothing needs to share a writer.** `keet-identity-key` links separate device
keys to one identity root by attestation - which is what option B now uses. This
answer is what rewrote both B and C above.

**4. ANSWERED - self-attestation is not needed, so the risk goes away.** The
identity key signs an attestation of each device key and peers verify the chain.
Measured: two devices with separate keypairs both verify to the same
`identityPublicKey`, and a forged proof (attacker's key, attacker's signature,
against someone else's proof) does **not** verify. The self-attested `personId`
from the first draft is withdrawn rather than kept as a cheaper option, because
there is no longer anything cheaper about it.

## What is left for Tim

Nothing but approval. All four questions are closed - three with evidence, the
fourth by Tim's call on 2026-07-29.
