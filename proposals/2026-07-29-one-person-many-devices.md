# 2026-07-29 - One person, many devices: what a member IS

**Status:** DRAFT 2026-07-29, awaiting Tim. Follows PR #123 (the linking UI), which
closed the last of the buildable gaps in
proposals/2026-07-28-device-linking.md. Everything left is this.

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

### B. Correlate the rows - a person id on the member row

Add an optional `personId` to the `member:` row: a value both of a person's
devices can derive, so the space can tell that two device keys are one person
without changing what signs anything.

- **Derivation.** `deriveProfileId(identityPublicKey)` already exists in
  device-link (`src/identity.js`) and is exactly this: a stable 16-byte hash of the
  mnemonic-derived identity key. A device that has linked can publish it; a device
  that has not simply omits it.
- **Display.** Members with the same `personId` collapse to one row.
- **Routing.** `assignee` keeps meaning a device key on the wire, but the notify
  rule matches on *my person* rather than *my device*: fire if
  `assignee === selfKey` OR the assignee's member row shares my `personId`.
- **Compat.** Additive optional field, same argument as `caps`, `kind` and
  `remindAt`: `rowApplyDecision` validates only pubkey/updatedAt/sig/namespace and
  `applyListOp` stores rows verbatim, so an old peer keeps the field on a
  read-modify-write and never forks. An old peer shows two rows and routes to one
  device - i.e. exactly today's behaviour, which is the correct degradation.

**What it does not fix.** A reinstall is still a new person: the new install has a
new per-device key, so it publishes a new member row. `personId` makes it
*recognisable* as the same person, which is enough for display and routing but
does not restore ownership or writer status. It is a correlation, not an identity.

Honest risk: `personId` is self-attested, like `displayName`. A device can claim
someone else's. Today that buys an attacker a merged row and assignment
notifications inside a space they are *already a member of* - so it is a nuisance,
not an escalation - but it is a new claim on a signed row and should be reasoned
about rather than waved past.

### C. Mnemonic-root - one identity, derived from the phrase

Slice 4 of the device-linking proposal: derive core's per-device signing key from
the device-link mnemonic, so both phones sign as the *same* member. Two phones
become one row because they genuinely are one writer. A reinstall holding the
phrase is the same person, which also resolves the ownership-loss case that
2026-07-28 closed as won't-build.

This is the correct model and the expensive one. From the existing proposal:

> Every space in the field has member rows and an owner keyed to the current
> per-device keys. Changing how that key is derived either needs those identities
> carried across (the old key keeps working, the mnemonic-derived one is added) or
> it orphans people from their own spaces.

It also breaks a property the current design relies on: two phones sharing one
writer key means two devices appending to the same Autobase writer, which is not
something the current engine does. That needs answering before this is costed, and
it may be the thing that decides it.

## Scope

**In:** the decision, and whichever of B or C follows. **Out:** anything that
changes what `assignee` *stores* on the wire. Both options deliberately keep
`assignee` a device key so old peers keep working.

**Recommendation: B now, C as the goal, and do not flip the flag until B ships.**

B is additive, degrades to today's behaviour on old peers, reuses a derivation
that already exists, and fixes the failure that actually harms people. C is where
this should end up, but it is a migration with an unanswered engine question, and
holding the whole feature hostage to it means linking ships never. Doing B first
does not make C harder: `personId` is derived from the same identity key that C
would root the signing key in, so the correlation stays true afterwards and the
member rows it produced remain valid.

## Compat

- **B:** additive optional field. Old peers store it verbatim, show two rows and
  route to one device - today's behaviour. No migration, no fork. New peers with
  no linked device publish no `personId` and are unaffected.
- **C:** not additive. Needs identities carried across, and its own old-peer fork
  test (a device on the previous build must not diverge from one on the new).

## Verify

- `npm run verify` green.
- Unit: two member rows sharing a `personId` collapse to one; rows without one are
  never merged (an absent `personId` must not match another absent one).
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

1. **Does `personId` belong on the member row or the item?** On the member row it
   is published once and every reader correlates. On the item it would have to be
   written at assign time, which bakes today's answer into rows that outlive it.
   The proposal assumes the member row; worth a second opinion.
2. **What does the members list show for a collapsed person?** One row with both
   devices' avatars, or one row that has simply stopped mentioning devices? The
   second is more honest to what a person is, but loses the ability to see that a
   partner has an old phone still attached.
3. **Can two devices share one Autobase writer at all (option C)?** This is the
   question that decides whether C is expensive or impossible, and nobody has
   answered it. It should be answered before C is scheduled, not during.
4. **Does self-attested `personId` need hardening?** See the risk in B. A signed
   claim from the linked device (it can prove it holds the identity key) would be
   stronger than an asserted hash, at the cost of a real protocol addition.
