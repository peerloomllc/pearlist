# 2026-07-29 - Your name follows you, not your phone

**Status:** READY 2026-07-29, awaiting approval. ALL FOUR open questions are
answered - the avatar moves with the name, a fresh phone inherits rather than being
asked, the image transfers during the pairing window, and a rename republishes
immediately behind a coalescing guard. Tim also decided this does NOT block
flipping the flag: linking ships first. Follows
proposals/2026-07-29-one-person-many-devices.md, which shipped as PR #125 and is
proven on hardware. This is the defect that showed up minutes after it landed.

**Goal**

Make a person's display name and avatar belong to the PERSON, so a household sees
one stable identity no matter which of that person's phones last wrote to a space.

**Name and avatar are one thing.** Tim's call, 2026-07-29: together they ARE the
person as far as everyone else is concerned. Neither is a per-device setting and
they do not move independently - a change that carried the name across but left the
avatar behind would still show the household two different people.

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
`displayName` and the avatar reference on it. Peers read what they always read.
This is the property that keeps it T2 rather than T3.

### The avatar is a reference, and that is the interesting part

A member row does NOT carry the image. It carries
`{ avatarBlob: { key, id }, avatarHash, avatarType }` and the bytes live in a blob
core, fetched with `ctx.blobs.get(row.avatarBlob)` (see `resolveAvatar` in
`src/listMethods.js`). So moving the profile to personal scope moves a few dozen
bytes, not a picture, and the personal base does not become a blob store.

The real question is therefore not size, it is **reachability**: today a housemate
gets your avatar bytes over the SPACE's replication, because you are both in that
space and the blob core is served there. A freshly paired second phone is not in
any space yet at the moment it inherits your profile - it gets the reference over
the PERSONAL base and must be able to fetch the bytes over that same path.

Consequences the implementation has to face:

- The blob core the reference points at must be served to the person's own devices,
  not only to space peers. Both bases share one Corestore, so this is a question of
  what is announced and replicated, not of copying data.
- **FETCH THE BYTES DURING PAIRING, not on first render.** Tim's point, and it
  settles the design: the primary is online *by construction* while pairing - it
  generates the link and holds the session open until `expires`. That window is the
  one moment both devices are guaranteed to be up and talking. Today
  `resolveAvatar` is lazy: bytes are fetched when something renders a roster, which
  may be minutes later, after the old phone has been pocketed, closed or swiped away
  (and the TCL reaps the worklet on swipe-away). Leaving it lazy would mean the
  cheapest guaranteed opportunity is the one we skip. So the inherit step should
  pull the image, not just the reference.
- **The fallback still has to exist**, because the eager fetch can fail - the window
  is short and the blob may be large. `Avatar` already renders initials when there
  is no avatar, which is the right thing to show and must not look like an error.
  But it must heal on its own the next time both devices are connected, rather than
  waiting for a re-pair or a reinstall. The point of the eager fetch is to make that
  path rare, not to remove it.
- Re-publishing the same reference into a space from the second phone must not
  duplicate the blob. The hash is already there to make that checkable.

## Scope

**In:** moving `profile` - displayName AND avatar, together, per Tim's call - to
personal scope; making the avatar bytes reachable on a person's own devices, not
only on space peers; the migration for devices already linked; and republishing
member rows when the shared profile changes.

**Out:** anything that changes the space wire format. Out: per-space nicknames
(a different feature). Out: the device roster's own nicknames in Settings, which
are deliberately device-level and stay that way - that is naming a PHONE, which is
the one place a per-device name is the right thing.

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
- Unit: a freshly paired device with no profile of its own inherits the primary's
  name AND avatar reference, with no prompt. A device with a real differing profile
  does not silently inherit.
- Unit: republishing is skipped when the row would not differ. This is the guard
  that keeps question 3's "immediate" from becoming dcdb22b again, so it gets a test
  rather than only a hardware measurement.
- **On hardware, the amplification gate (non-negotiable, per question 3):** rename,
  then count `publishMember` calls over 90 s on BOTH linked phones and require it to
  settle at zero. The same measurement that caught dcdb22b.
- **On hardware, two linked phones, and this is the point:** rename on phone A and
  confirm phone B shows the new name AND that a third device (a housemate) sees the
  new name in the members list. Then rename on phone B and confirm it does not flip
  back. The 2026-07-29 rig (Pixel + TCL linked, iPhone as the housemate) is exactly
  the one to reuse.
- **On hardware, the avatar specifically:** set an avatar on phone A only, then
  pair a freshly installed phone B. B must end up showing that avatar - not
  initials - and the housemate must see ONE person with that avatar, not two rows.
  This is the check the whole "name and avatar are one thing" decision rests on.
- **On hardware, the case that actually happens:** pair B, then immediately close A
  (swipe it away - the TCL reaps the worklet, so this is a real partition, and it is
  exactly what someone does after pairing). B must ALREADY have the image, because
  it was fetched during the pairing window. This is the check that the eager fetch
  is really eager; with today's lazy `resolveAvatar` it would fail.
- **On hardware, the fallback:** force the eager fetch to fail (pair with A's app
  killed the instant the handshake completes). B should render initials, not a
  broken image, and must pick the avatar up the next time both are connected -
  without a re-pair or a reinstall.
- Old-peer check: a device on the pre-change build in the same space still shows a
  sensible name and does not fork.

## Rollback

Clean. Stop reading the personal profile and each device falls back to its local
one, which is still there. Rows already published carry a name either way - and
they carry a name that was at worst *correct at the time*, which is better than
today's position.

## Open questions

**1. ANSWERED by Tim 2026-07-29 - INHERIT by default, and only ask when there is a
real conflict.** The prompt was over-designed. The ordinary case is a phone you
just installed the app on: it has no profile worth keeping, so it should simply
become you - name and avatar - with nothing to decide and nothing to tap. That is
also what a user means by "this is my other phone".

So the migration rule is:

- **Secondary has no profile of its own** (fresh install - the common case):
  inherit the primary's silently. No prompt.
- **Secondary has only the untouched default** (`displayName` still "Member", no
  avatar): treat as no profile. Inherit silently.
- **Secondary has a real, DIFFERENT profile** (someone linked a phone they had
  already been using): this is the only case where the app cannot know, so ask
  once - "Which of these is you?" - showing both name+avatar pairs. Default the
  selection to the primary, since the phone being linked is the one joining.

The rare case keeps the prompt; the common case never sees it.

**2. ANSWERED by Tim 2026-07-29 - YES, the avatar moves with the name, and this is
not optional.** Name and avatar together are the person other people see. Carrying
one without the other leaves the household looking at two different people, which
is the bug this proposal exists to fix, half-fixed.

This also retires the size worry the first draft raised: the profile carries an
avatar REFERENCE, not the image, so nothing large moves. The work is in
reachability instead - see "The avatar is a reference" above, which is now the
substantive part of this proposal rather than a footnote.

**2b. ANSWERED by Tim 2026-07-29 - fetch the image during pairing.** The first
version of this question asked what to show "if the primary is offline at pairing".
That case does not exist: the pairing flow REQUIRES the primary to have the app
open, since it generates the link and holds the session until `expires`. Both
devices are guaranteed up and connected for that window.

Which turns the question into a design answer rather than a fallback policy: pull
the avatar bytes THEN, during the inherit, instead of leaving it to
`resolveAvatar`'s lazy on-render fetch. Lazy means the fetch happens whenever the
new phone first renders a roster - possibly much later, by which time the old phone
may genuinely be closed or swiped away. The one moment both are certainly connected
is the moment we currently do not use.

The initials fallback still has to exist for a failed or interrupted fetch, and
still has to heal without a re-pair. It just stops being the expected path.

**3. ANSWERED by Tim 2026-07-29 - IMMEDIATE, with a coalescing guard.** A rename
republishes to every space as soon as the shared profile changes, so housemates see
it at once. Fixing a wrong name is most of why anyone renames, and a lazy update
that leaves quiet spaces stale for days fails at exactly that.

The guard is not optional, because this is the same code that already produced a
write-amplification bug in PR #125 (dcdb22b, 21 appends in 90 s):

- **Debounce**, so a burst of edits (typing a name, then picking a photo) is one
  write per space rather than one per keystroke.
- **Write only when the row would actually differ.** Compare against what is
  already published and skip a no-op republish. This is the property that stops a
  refresh loop from turning into an append loop.
- **Both phones will try.** Two devices in the same space each republishing their
  own row is correct - each owns its own `member:{pubkey}` - but it doubles the
  fan-out, so the debounce has to hold per device, not per person.
- **Measured on hardware the way dcdb22b was**: count `publishMember` calls over
  90 s after a rename and require it to settle at ZERO. Not "looks fine".

**4. ANSWERED by Tim 2026-07-29 - NO. This does not block the flag; linking ships
first.**

Recorded against the recommendation, which was to block. Tim's call: linking is
proven and works, and the name flip only bites someone who named their two phones
differently, which is not the common case.

What follows from that, and should be understood rather than discovered:

- **The first thing a linked user may notice is their name changing on its own.**
  That is the accepted cost. It is cosmetic and reversible - no data is affected -
  but it will look like a bug to whoever hits it.
- The inherit-on-pairing step from question 1 is part of the LINKING flow, not this
  proposal, so if linking ships first then a freshly paired phone keeps its own name
  until this lands. In practice that is the flip, made likely rather than rare.
  Worth deciding whether to carry just the inherit-at-pairing copy (option B, which
  this proposal rejected as a *fix*) into the linking release as a stopgap - it is
  cheap and it makes the common fresh-install case correct without waiting for
  personal-scope storage.
- **This is no longer the critical path to the flag.** The remaining flag blockers
  are `device:remove` not actually revoking, and the `device:status` stall WATCH.
  Those now decide when linking ships.
