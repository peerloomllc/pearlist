# 2026-07-29 - "I lost my phone, take it off my account"

**Status:** READY 2026-07-29, awaiting approval. Both sharp questions answered by Tim
the same day - it gets its own `revoke2` capability gate, and a space owned by the
removed phone has ownership transferred to another of the person's own devices first.
The last blocker on flipping DEVICE_LINK_ENABLED. Everything else in device linking is
shipped and proven on hardware (see DONE.md: PRs #117, #121, #123, #125, #127).

**Goal**

Make removing a linked phone actually stop that phone, rather than only hiding it
from a list.

**Tier**

T3. The recommended option changes who may author a `revokeWriter` op, which is
consensus state: a peer that disagrees about writer membership does not error, it
silently forks the space (peerloom-core `test/writer-revocation.test.js`).

## The forcing function

`device:remove` today is one line:

```js
async function removeDevice (writerKey) {
  await pAppend({ op: 'del', type: 'deviceMeta', key: 'deviceMeta:' + writerKey })
}
```

It deletes a row in the personal base. That is all. There is **no `removeWriter`
anywhere in `@peerloom/device-link`**. So a phone you have "removed":

- keeps the recovery phrase, so it keeps the identity;
- keeps its writer key on the personal base;
- keeps its per-space writer keys, granted by `grantGroupWriter` at pairing, so it
  can still **edit every space you were in**;
- keeps the space keys locally, so it can still **read** everything;
- does not even drop itself from its own roster - `decideDeviceMetaDel` returns
  `self: true` for the target's own row, so only OTHER devices stop showing it.

The UI copy is already honest about this and a test guards the wording, so nobody
is being actively misled. But the reason the button exists is a lost or stolen
phone, and in that situation it does nothing that matters.

**This is the last thing gating the flag**, which is why it is worth doing properly
rather than papering over.

## What already exists, and is easy to miss

PearList has a complete writer-revocation path **for spaces**, from
proposals/2026-07-13-writer-revocation.md:

- `revokeWriter` op in core's engine, gated by the app's `authorizeRevoke` hook.
- `src/revocation.js`: honours a revocation only if the **owner** signed it, for
  that group, on an **armed** space. Deterministic, so every peer drops a forged
  one identically.
- A capability gate: the owner may only arm `space.revokeV1` once **every** other
  member advertises `revoke1`, because an old peer that ignores the op keeps
  accepting the revoked writer and forks.
- `_w`, the writer-core binding, taken from the authoring core (never self-declared)
  and self-healed by `space:revocationStatus` for rows written before arming.
- `member:remove` already issues the revocation when the space is armed.

So the primitive is built and hardened. **Device removal simply does not use it.**

## The asymmetry that makes this more than wiring

Member removal and device removal look alike and are not:

|  | who is removed | who can authorise today |
| --- | --- | --- |
| `member:remove` | someone else | the space **owner** - and they are the one doing it |
| `device:remove` | **my own** phone | the space owner, who may be someone else entirely |

If I remove my lost phone, and the space belongs to a housemate, **I cannot revoke
its writer key there.** I can hide it from my own device roster and nothing else.
That is not a gap in the wiring; it is a missing authorisation rule.

## The options

### A. Personal base only

Add `removeWriter` on the personal base in device-link. Stops the removed phone
writing personal-scope data.

Honest about its value: personal-scope records are currently **empty**
(`makeRecords()` returns `{}`), so today this stops nothing a user can see. It also
leaves the actual harm untouched - the removed phone keeps editing every shared
space. Necessary, nowhere near sufficient.

### B. Ask the space owner

Removing a device publishes a signed "this device of mine is revoked" record; each
space owner's device notices and issues the `revokeWriter` itself.

Works within today's authorisation rule. But it needs the owner to come online
before anything happens, which in a household is fine and for a lost phone is
exactly the wrong latency. It also adds a new wire record and a new
owner-side automatic behaviour - an owner's device issuing consensus ops it was not
asked for, which is a meaningful change in who is responsible for what.

### C. Let a person revoke their own device - RECOMMENDED

Extend `authorizeRevoke` to honour a `revokeWriter` **either** from the space owner
(today's rule, unchanged) **or** from a device that can prove it is the same person
as the target.

That proof now exists and is already in the space. PR #125 put `identityProof` on
every member row: each device attests its own key with the identity key derived from
the recovery phrase, and any peer can verify the chain. So a peer can check, from
replicated state alone and therefore deterministically:

1. the revocation is signed by member row X;
2. X's `identityProof` and the target's `identityProof` verify to the **same
   identity root**;
3. therefore X and the target are one person, and a person may evict their own
   device.

No new cryptography, no new record type on the wire, and the check is exactly the
one `sameIdentityKeys` already performs for notification routing. It is the natural
consequence of what shipped today.

**Why this is safe.** A forged proof does not verify - measured 2026-07-29, and
`test/memberIdentity.test.js` guards it. A device with no proof can revoke nobody,
because there is no root to match. And a housemate cannot revoke your phone,
because their root differs.

**Combine with A.** C covers the shared spaces, which is the harm; A covers the
personal base. Both are needed for "removed" to mean anything.

## What removal will still NOT do, and the UI must keep saying so

**It cannot stop the phone READING.** Core replicates to any connection with the
topic and key, and the removed phone has both on disk. Cutting off reads means
re-keying, and DECISIONS.md 2026-07-28 already concluded that re-keying is really
"make a new space" - which now costs little, since a space can be recreated and
re-invited without retyping lists.

**It cannot un-know the recovery phrase.** The removed phone can always re-derive
the identity. What it cannot do, once revoked, is write - and it cannot re-pair,
because pairing is initiated by the remaining device, not requested by the joiner.

So the honest promise is: **"it can no longer change anything, and it can still see
what it already had. To take that away too, make a new space."** The current copy
is close to this already; it should be updated rather than softened.

## Scope

**In:** `removeWriter` on the personal base (device-link); same-identity
authorisation in `authorizeRevoke` behind a new `revoke2` capability; same-identity
ownership transfer for spaces the removed device owns; `device:remove` issuing
revocations across every space the device is a writer in; UI copy stating what removal
does and does not do, plus surfacing which spaces are not armed yet.

**Out:** re-keying or read revocation - that is "make a new space". Out: ownership
RECOVERY where no device of the owner survives - that stays WON'T BUILD per
proposals/2026-07-28-space-ownership-recovery.md, and this proposal deliberately does
not reopen it. Out: revoking a device that was never a writer anywhere (nothing to
do). Out: any change to how rows are signed.

## Compat

The capability gate is the whole compat story, and it is already built: a space must
be **armed** before any revocation is honoured, and it can only be armed once every
member advertises `revoke1`. Extending *who* may author one does not change that.

But it does mean the honest answer to "will removal work?" is **"in armed spaces,
yes; in un-armed ones it still only hides"** - and un-armed is the default. The
`space:revocationStatus` UI already exists to tell an owner who is holding arming up.
Whether device removal should PROMPT the user to arm, or refuse and explain, is an
open question below.

A new-code peer must also not honour a same-identity revocation on a space where any
member is old, or that peer forks against the old one. The existing `armed` check
covers this only if arming is genuinely gated on the new capability too - so this
wants its own cap bump (`revoke2`?), not a silent widening of `revoke1`.

## Verify

- `npm run verify` green.
- Unit (peerloom-core): a `revokeWriter` signed by a device whose proof shares the
  target's identity root is honoured; one signed by a different person's device is
  **dropped**; one with no proof is dropped.
- Unit: an old-code bystander in the same space does not fork - the existing
  `test/writer-revocation.test.js` shape, extended to the new authoriser.
- Unit (device-link): `removeDevice` removes the writer, and the removed key can no
  longer append to the personal base.
- Unit: a `space` row rewritten to name a new owner is honoured when the writer proves
  the same identity root as the current owner, and REJECTED when it does not - the
  no-seizure property, and the one that has to be airtight.
- Unit: revocation is skipped rather than attempted when it would leave no indexer,
  and the ownership transfer lands before the revocation.
- Unit: a space armed only under `revoke1` does not honour a same-identity revocation.
- **On hardware, three devices, and this is the point:** link a second phone, arm a
  space, remove that phone from the first, then try to edit a list ON the removed
  phone and confirm the edit does not reach the others. The 2026-07-29 rig (Pixel +
  TCL linked, iPhone as the housemate) is the one to reuse - and the housemate
  matters, because it proves a third party converges on the same writer set rather
  than forking.
- Confirm the removed phone can still READ, deliberately, and that the UI says so.

## Rollback

The personal-base half reverts cleanly. The authorisation half does not, in the
usual way: once a space has honoured a same-identity revocation, a build that no
longer recognises one disagrees about the writer set and forks. So it rides the cap
gate, and rollback means "do not arm", not "revert the code".

## Open questions

**1. Should `device:remove` be able to arm a space it is not the owner of?** It
cannot - arming is the owner's call and gated on every member. So removing a device
from an un-armed space degrades to hide-only, which is today's behaviour and the
thing this proposal is meant to end. Options: prompt the owner ("to make this stick,
update everyone and arm revocation"), refuse with an explanation, or remove and warn.
**Recommend remove-and-warn**, since a hidden device is still better than nothing and
the user has usually lost the phone already - but the wording has to avoid implying a
lockout that did not happen.

**2. ANSWERED by Tim 2026-07-29 - YES, this gets its own `revoke2` capability.**
Nobody honours a same-identity revocation until every member of that space advertises
support, exactly as `revoke1` works today. Reusing `revoke1` was rejected: an armed
old-build peer accepts `revoke1` ops but would reject a same-identity one, so the two
disagree about the writer set - the silent fork the capability system exists to
prevent.

The cost is accepted and should be stated in the UI rather than hidden: **device
removal does nothing in a space until that space is armed under `revoke2`**, which
needs every member updated. For a feature reached in a hurry after losing a phone,
that is poor timing - so `space:revocationStatus`, which already reports who is
holding arming up, should be surfaced on the removal screen rather than only in the
owner's settings.

**3. ANSWERED by Tim 2026-07-29 - transfer ownership to another of your own phones
first, then revoke.**

**This is the part that was impossible in July and is not any more, and the distinction
matters.** proposals/2026-07-28-space-ownership-recovery.md is marked WON'T BUILD, and
one of its reasons was that any ownership change hands a member "a seizure button in a
couples app". That objection stands for what it was describing - ownership *recovery*,
where the owner identity is gone from every phone and somebody else must be allowed to
claim the space. Nothing can distinguish a legitimate claim from a grab there.

Ownership *transfer between one person's own devices* is a different question, and
#125 answers it: another phone can **prove** it shares the owner's identity root. That
is not a seizure, it is the same person. So the rule is narrow and checkable, from
replicated state alone:

> The `space` row may be rewritten to name a new owner if the writer is a device whose
> `identityProof` verifies to the same identity root as the current `space.owner`.

Consequences to honour:

- It only works while **another of your devices still exists**. Lose your only phone
  and you are back to the July answer: export/import into a new space. That limit
  should be said out loud, because it is the difference between this and the recovery
  feature that was declined.
- Autobase refuses to remove the last indexer (`base.removeable`), and the engine
  already skips rather than throwing. So the transfer must land **before** the
  revocation, and the revocation must be skipped if it would leave no indexer.
- This makes the July proposal worth revisiting **in this narrow respect only**. It
  should not be reopened as ownership recovery; the n=2 finding recorded there still
  applies to that.

**4. Should removal be automatic on re-pair?** The roster already accumulates stale
"Unnamed device" entries, one per pairing, because a re-paired phone adds an entry
rather than replacing its own (its own TODO item). If a device re-pairs with the same
identity, is the old entry revoked, merged, or left? Merging is probably right, but it
interacts with this proposal because a revoked-then-re-paired device must not silently
regain writer access.

**4. Should removal be automatic on re-pair?** The roster already accumulates stale
"Unnamed device" entries, one per pairing, because a re-paired phone adds an entry
rather than replacing its own (its own TODO item). If a device re-pairs with the same
identity, is the old entry revoked, merged, or left? Merging is probably right, but it
interacts with this proposal because a revoked-then-re-paired device must not silently
regain writer access.
