# 2026-07-29 - Your name follows you, not your phone

**Status:** DRAFT 2026-07-29, awaiting approval. Follows
proposals/2026-07-29-one-person-many-devices.md, which shipped as PR #125 and is
proven on hardware. This is the defect that showed up minutes after it landed.

**Goal**

Make a person's display name and avatar belong to the PERSON, so a household sees
one stable name no matter which of that person's phones last wrote to a space.

**Tier**

T2. It moves where a field is stored and changes which device may write it, but it
does not change the space wire format: `member:{pubkey}` rows keep carrying
`displayName` exactly as they do today. Old peers are unaffected because nothing
they read changes shape.

## The forcing function

Watched on hardware 2026-07-29, immediately after the routing gate passed. The
Pixel's profile says "Tim". The linked TCL's says "TCL". Every space shows the
merged member as **"TCL"**.

Nothing is corrupt. `collapseMembers` is doing what it was told:

> Name and avatar come from the most recently updated row, so renaming on your
> newer phone is what the household sees - rather than whichever row happened to
> sort first.

That rule is sound, and it was written for a world where the two rows describe the
same person under the same name. They do not, because **`displayName` is per-device
state**: it lives in each device's own `localDb` `profile` row and is published on
that device's own member row. Two phones, two profiles, one person.

So the name your housemates see is whichever of your phones most recently
republished - which is not a thing the user chose, cannot see, and cannot fix
except by renaming both phones identically and hoping.

**It is worse than a cosmetic flip.** Every republish is a chance for it to change:
a profile edit, a fresh join, the roster backfill. The household's view of who you
are is tied to which of your devices was busiest.

**Why this was nearly missed.** It only became visible because the two test phones
were deliberately named differently. In the field most people name both phones the
same, which hides it completely until one day it does not.

## The options

### A. Do nothing

Defensible only if you assume people name every phone identically. The app cannot
enforce that and never asks for it: the onboarding prompt is "Set your name so the
people you share with know who's who", asked once **per device**, with no hint that
it is anything other than per-device. We are actively inviting the divergence.

Rejected.

### B. Copy the name at pairing time

When a device links, the secondary adopts the primary's `profile`.

Cheap, one function. But it fixes only the moment of pairing: rename either phone
afterwards and they diverge again silently, which is the same bug with a longer
fuse. It also has no answer for which way the copy should go when someone links a
phone they have already been using.

Rejected as a fix. Worth keeping as a **migration step** inside option D.

### C. Make the collapse prefer a fixed device's row

Pick deterministically - say the identity root (bootstrap) device - rather than the
most recent.

Stable, and about four lines. But it makes renaming on your other phone silently do
nothing, with no feedback, which is a worse user experience than the flip: at least
the flip is visible. It also picks a "main phone" the user never nominated, and
strands them if that device is gone.

Rejected.

### D. Store the profile on the person - RECOMMENDED

`@peerloom/device-link` already maintains a **personal Autobase shared across one
person's devices**. It exists for precisely this class of data, and PearList
currently declares its personal-scope record types EMPTY on purpose.
`src/deviceLink.js` says so in as many words, and names this kind of device-local
state as the obvious future candidate.

So: `profile` (displayName, avatar) becomes a personal-scope record.

- One profile per person, replicated between their own devices.
- Renaming on either phone changes both, which is what a user means by "change my
  name".
- The conflict `collapseMembers` resolves today **stops existing**: both member
  rows carry the same name, so most-recent-wins picks the same answer either way.
  That rule can stay exactly as it is.
- Unlinked devices are unaffected: with no personal base, the profile stays local
  and behaves as it does now.

**Space rows do not change.** Each device still publishes `member:{pubkey}` with
`displayName` on it. Peers read what they always read. This is the property that
keeps it T2 rather than T3.

## Scope

**In:** moving `profile` to personal scope, the migration for devices already
linked, and republishing member rows when the shared profile changes.

**Out:** anything that changes the space wire format. Out: per-space nicknames
(a different feature). Out: the device roster's own nicknames in Settings, which
are deliberately device-level and stay that way.

## Compat

- **Unlinked device:** no personal base, no change in behaviour.
- **Old peer in the same space:** reads `displayName` off member rows exactly as
  before. Cannot tell the difference.
- **Already-linked pair (i.e. today's test devices):** needs a one-time migration -
  see the open question below, because this is where option B's copy returns as a
  legitimate step.

## Verify

- `npm run verify` green.
- Unit: with a personal profile present, both devices publish the SAME
  `displayName`, so `collapseMembers` returns that name regardless of which row is
  newer. This is the regression test for the bug as observed.
- Unit: a device with no personal base falls back to its local profile unchanged.
- **On hardware, two linked phones, and this is the point:** rename on phone A and
  confirm phone B shows the new name AND that a third device (a housemate) sees the
  new name in the members list. Then rename on phone B and confirm it does not flip
  back. The 2026-07-29 rig (Pixel + TCL linked, iPhone as the housemate) is exactly
  the one to reuse.
- Old-peer check: a device on the pre-change build in the same space still shows a
  sensible name and does not fork.

## Rollback

Clean. Stop reading the personal profile and each device falls back to its local
one, which is still there. Rows already published carry a name either way - and
they carry a name that was at worst *correct at the time*, which is better than
today's position.

## Open questions

**1. Which name wins for devices that are ALREADY linked?** Today's rig has "Tim"
and "TCL" and no basis for choosing. Options: the identity root device's name (has
a deterministic answer, but may be the phone you care less about), the most
recently edited (matches today's rule, and is at least what the household is
currently seeing), or ask the user once at migration ("You have two names on this
account - which is yours?"). Asking is the only one that cannot pick wrong, and it
happens once, behind a flag that has not shipped - so the blast radius is the test
devices. **Recommend asking, and defaulting the prompt to the root device's name.**

**2. Does the avatar move with the name?** They are one `profile` row today, and
splitting them would be strange. But the avatar is a blob and the personal base has
different size characteristics than localDb. Recommend moving both, and measuring
the blob path before committing - if it is a problem, moving the name alone still
fixes the reported bug and the avatar can follow.

**3. Should renaming republish member rows immediately, or lazily?** A shared
profile change has to reach every space the person is in, on both devices, or the
household sees the old name until something else triggers a republish. Immediate
republish is correct but is a fan-out across every space from both phones at once -
and PR #125 already had to fix a write-amplification bug in this exact area
(dcdb22b). Whatever is chosen must be measured on hardware the way that one was:
count `publishMember` calls over 90 s and require it to settle at zero.

**4. Is this a blocker for flipping DEVICE_LINK_ENABLED?** It is the last
user-visible defect known in linking. Arguably yes. But if the answer to question 1
is "ask the user", that prompt is itself part of the linking UX, so the two want to
ship together rather than in sequence.
