# Your spaces follow you to your other phone

**Status:** proposed
**Tier:** T2
**Date:** 2026-07-31

## The forcing function

Tim, on hardware, 2026-07-31:

> I created "New" space on TCL, but it doesn't automatically show up on the iPhone.
> I have to send an invite to the iPhone.

Sending yourself an invite is absurd once the app has told you the two phones are the
same person. It puts "(You)" on your own roster row and then makes you QR-code a
household space from your left hand to your right.

## The correction that shrinks this

`TODO.md` recorded this as "not replicated anywhere ... device-link's personal base is
the obvious carrier", sized as "T2 at least, probably a proposal. It is a new
replicated record and a new lifecycle."

**The carrier already exists and already runs.** Device-link has a group plugin with
exactly two legs for this:

```js
// pearlist/src/deviceLink.js:258
collectGroups()   // primary: which spaces am I in? carries groupKey, encryptionKey, bootstrap
seedGroups(gs)    // secondary: join each of them, skipping any already joined
```

`collectGroups` is called from `handleHello` (`personal.js:508`). `seedGroups` is
called from `handleGranted` (`personal.js:539`). Both sit **inside the pairing
handshake**, and the space list rides the `granted` message next to the mnemonic.

So spaces do follow you to your other phone. Once. At the moment you link, and never
again. Tim linked the phones, then made "New", and nothing was ever going to carry it.

That is not a missing mechanism. It is a mechanism wired to the wrong event.

## The proposal

**Move space membership from the handshake onto the personal base, so it is a fact
that replicates rather than a message that was sent.**

The personal base already has everything this needs, and PearList already uses all of
it for other things:

| Piece | Already exists | Used today by |
| --- | --- | --- |
| App-declared record types | `records.js`, registry at `deviceLink.js:360` | the person's profile |
| Apply mirrors any registered type | `personal.js:192` | `identityProfile`, `profile` |
| An exported writer | `dl.putRecord(type, key, value)` | `putProfileRecord`, `deviceLink.js:208` |
| Per-space records appended AFTER pairing | `deviceGroupWriter` | `device:announceSpaceWriters`, `listMethods.js:1425` |

That last row is the precedent that matters most. `device:announceSpaceWriters`
already walks every mounted space and appends a per-space record to the personal base,
long after the handshake is over. This proposal is the same shape carrying a different
payload.

### The record

Register a `space` type. One record per space, keyed by `groupId`, holding exactly
what `joinGroup` needs, which is exactly what `collectGroups` already gathers:

```
type: 'space'
key:  'space:' + groupId
value: { groupId, groupKey, encryptionKey, bootstrap, name, joinedAt }
```

Write it whenever this device joins or creates a space. Read it on the other device
when apply mirrors it, and join. `seedGroups` is already idempotent and skips a space
the device is in (`deviceLink.js:283`), so the join path needs no new guard.

### Automatic, not offered

Recommend joining automatically rather than prompting.

The alternative ("your TCL is in New, join?") is the safer-sounding option, and it is
the one the TODO leaned toward. It is the wrong call here for one reason: **linking
already joins you to everything, silently, with no prompt.** `seedGroups` fans out
across every space the primary is in at pair time and never asks. Prompting for spaces
created afterward would mean the same app answers the same question two different ways
depending on when the space happened to be made. That is harder to explain than either
policy on its own.

If we want a prompt, it belongs at linking, covering both paths, and that is a
different proposal.

## The lifecycle, which is the actual hard part

The TODO was right that this is where the difficulty lives. A replicated membership
record makes **leaving** ambiguous in a way it is not today.

Today `space:leave` deletes `groups:joined:{groupId}` locally
(`listMethods.js:1217`). If membership is replicated and leaving is only a local
delete, the record is still on the personal base, apply mirrors it again, and the
device rejoins the space it just left. A leave button that undoes itself is worse
than no sync at all.

So leaving needs a decision, and there are only three honest options:

1. **Leaving is per person.** The record is deleted from the personal base, and every
   one of your phones leaves. Matches "these phones are you", and matches how removal
   already works since PR #161 (removing someone removes all their phones).
   **Recommended.**
2. **Leaving is per device**, and the record grows a per-device suppression so the
   leaving phone stops rejoining while the others stay in. Honest, but it invents a
   second concept and the UI then has to explain which kind of leave you meant.
3. **Leaving is per person with no tombstone.** Rejected outright. Without a record of
   the leave, any phone that has not caught up re-announces the space and everyone
   rejoins. This is the resurrection bug the list items already solved with tombstones,
   and it would be embarrassing to reintroduce at the space level.

Option 1 keeps the model to one sentence: a space is something a PERSON is in, not
something a phone is in. That is the same correction PRs #161, #162 and #163 have been
making everywhere else, so this is consistency rather than a new idea.

## Compat

**Old peers in a shared space are unaffected.** Nothing here touches the space wire
protocol, the `space` row, apply, or the invite format. A household member on an old
build cannot tell the difference, because this is entirely about how one person's own
devices talk to each other.

**Old builds of PearList on a person's own second phone** are the only compat surface.
An unregistered record type is dropped by apply (`records.js`, `decideRecordPut`), so a
phone on a build without the `space` type simply does not act on the records. It keeps
working exactly as it does today, which is to say it gets its spaces at pair time and
no later. Degraded, not broken, and no fork, because the personal base is per person
and nobody signs a shared view off it.

**Migration.** None needed for correctness. Spaces already joined keep working from
`groups:joined:` untouched. On first run with the new code, write a `space` record for
every space already in `groups:joined:`, which is the same walk
`device:announceSpaceWriters` already does. That backfills the pair so existing spaces
start following you too, rather than only ones created from here on.

## Security, stated plainly

The record carries `groupKey`, `encryptionKey` and `bootstrap`. Those are secrets.

Today they cross the authenticated pair channel, which as `deviceLink.js:220` notes
carries the mnemonic already, so it adds no new trust assumption. Moving them onto the
personal base keeps the same trust boundary, since the personal base replicates only
between one person's own devices.

**The delta is persistence, and it deserves a straight answer.** Today the secrets are
transient in a handshake. On the personal base they are durable and they keep
replicating. A device that was REMOVED from the person still holds the personal base
key, and `revokedWriter:` stops it writing but does not stop it reading. So a removed
phone could learn the join secrets for spaces created after its removal, which it
cannot do today.

That is a real regression and it is not hand-waved away by "it already has the
mnemonic", because a removed device is precisely the one we assume is out of our
hands. It is the strongest argument against this design and it is unresolved. See
Open questions.

## Scope

**Changes**

- Register a `space` record type on the personal base.
- Write the record on join and on create.
- Act on mirrored records by joining, reusing `seedGroups`.
- Backfill records for spaces already in `groups:joined:` on first run.
- `space:leave` deletes the record rather than only the local row.

**Does not change**

- The space wire protocol, apply, the `space` row, invites or pairing.
- `seedGroups` and `collectGroups` themselves, which stay as the pair-time path.
  Belt and braces: pairing still seeds directly, and the records cover everything after.
- Anything a household member on another person's phone can observe.

## Verify

- Unit: a `space` record round-trips through `decideRecordPut` and is refused if the
  type is not registered.
- Autobase harness, two devices of one person: create a space on A AFTER linking, and
  assert B joins it with no invite. This is the exact reported failure and it must fail
  without the change.
- Autobase harness: A leaves, and B leaves too, and neither rejoins after a settle.
  The resurrection case, which is the one most likely to be got wrong.
- Autobase harness: a device on a build without the `space` type registered ignores the
  records and does not crash.
- Backfill: a device with spaces in `groups:joined:` and no records writes them once
  and not repeatedly.
- Hardware, the reported case: make a space on the TCL and watch it appear on the
  linked iPhone with nothing sent between them. Per `[[autobase-harness-beats-hardware]]`
  the harness proves the semantics, so hardware is confirming the wiring, not the rules.

## Rollback

- **Before release:** revert. The records are additive and unregistered types are
  dropped, so a reverted build ignores anything already written.
- **After release:** reverting stops new records being written and acted on. Records
  already on the personal base stay in the log and are then inert, which is the same
  end state as an old build. No cleanup pass is required and none should be attempted,
  since deleting from a personal base other devices are still reading is how the
  resurrection bugs start.
- The security concern above does NOT roll back. Secrets written to the personal base
  stay in its log. That asymmetry is a reason to settle Open question 1 before writing
  code, not after.

## Open questions

1. **Do the join secrets belong on the personal base at all?** The alternative is a
   record carrying only `groupId` and `name`, with the other phone asking a phone that
   holds the secrets to hand them over live. That keeps secrets transient and confines
   them to devices currently in the pair, at the cost of not working while the other
   phone is offline. **This should be decided before implementation**, because it is
   the one choice that cannot be rolled back.
2. **Automatic or offered.** Recommended automatic above, on consistency grounds.
   Worth Tim confirming, since it is the question the TODO flagged as needing a call.
3. **Per-person or per-device leave.** Recommended per person, option 1.
4. **Does a space created on a phone that is NOT yet writable on the personal base get
   its record?** Same race `device:announceSpaceWriters` documents at
   `listMethods.js:1414`. It needs the same deferred retry rather than a silent drop.
5. **Interaction with the arming proposal.** A space auto-armed at creation
   (`2026-07-31-arming-should-not-be-a-user-decision.md`) and then auto-joined by the
   linked phone means the second phone arrives at a space already armed and already
   co-owned. That is the intended end state, but the two land together and neither has
   been tested against the other.
