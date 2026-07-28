# Device linking (one person, several devices, one member)

## Goal

Let one person's phones be one member of a household, instead of one member per
device - so a second phone, or a replacement phone, does not arrive as a stranger.

## Tier

T3. It changes what a signed row's `pubkey` MEANS, which every trust rule in the
app is keyed on: `space.owner`, `space.evicted`, the member-row write rule,
`assignee`, `reminderTargetOf`. Apply behaviour changes, so a peer on old code
computes a different view and the space FORKS. Same hazard class as writer
revocation, and it needs the same capability gate.

## Where this came from

2026-07-28, working the rejoin report. Ownership recovery was proposed, accepted,
then dropped (DECISIONS.md, same day) once export/import made "recreate the space"
cheap. What was left standing after that argument was the thing underneath it:

**Identity is per-DEVICE and nothing in the app says so.** Tim's Pixel and his
iPhone are two members of his own household. A reinstall makes a new person. The
memory note "device identity is not a person" has been true the whole time and
this is the first proposal aimed at it rather than around it.

## What this DOES NOT fix, stated first

**It does not fix the report that started all this.** That device was never
ADMITTED as an Autobase writer. A fresh install has a NEW writer core whatever
identity it holds - the writer core comes from the corestore namespace, not from
the keypair - so it still has to be admitted by a writer that is online at the
same time. Linking changes who the device claims to BE, not whether it may write.

I said the opposite earlier in the session. It was wrong, and worth writing down
here because it is the natural thing to assume about a feature called "linking".

**It does not rescue a phone that is already gone.** Both designs below need the
two devices to meet, at least once, while both work. Like the successor mechanism
this replaces, it protects the next household, not the one already broken.

## The finding that decides the design

`identity` currently does two unrelated jobs:

1. **It signs rows.** `signValue(..., ctx.identity.secretKey)`, and every trust
   rule compares `value.pubkey` against it.
2. **It is this node's DHT identity.** `swarm = makeSwarm({ keyPair: identity })`
   in engine.js - the same object, handed to Hyperswarm as its keypair.

That coupling is the whole problem. "Who I am" wants to be shared across my
devices; "which node this is" must not be - two peers announcing the same DHT
keypair is two records for one public key, and anyone dialling it reaches either
one. Discovery and holepunching are not built for that, and the failures would be
intermittent, which is the worst kind.

**So step one, whichever design wins: give the swarm its own per-device keypair
and stop handing it the signing identity.** That is a small change in core, it is
independently correct, and it can ship on its own with no wire change - a device's
DHT key becoming a random per-device key breaks nothing, because nothing in the
app derives meaning from it. Do this first and measure it before anything else.

## Two designs

### A. Share the identity (the same keypair on both devices)

The second device receives the Ed25519 secret key and stores it as its own
identity. Both devices then sign as the same pubkey.

- **One member row**, automatically. No new rules: every existing check keyed on
  pubkey keeps working, unchanged, because there genuinely is one identity.
- **Ownership, assignment and reminders follow for free.** A new phone holding the
  linked identity IS the owner.
- Each device still has its own Autobase writer core, so each is admitted
  separately - the pair channel already does exactly this.

**The cost is that a secret key has to travel.** A QR or deep link carrying a
secret is a screenshot away from handing someone your identity permanently, and
unlike an invite it cannot be revoked - there is no way to un-know a private key.
It would need to be one-shot, short-lived, shown only on an explicit "link a
device" screen, and it should never be the same code path or visual language as an
invite, because an invite is safe to forward and this is not.

### B. Alias claim (each device keeps its own key)

Device B keeps its own keypair and publishes `member:{B}` carrying a claim to be
the same person as A, countersigned by A. The roster merges them for display.

- **No secret ever moves.** That is the whole appeal.
- But "one member" becomes a VIEW-level merge, not a cryptographic fact. Every
  rule keyed on pubkey has to learn about alias sets: owner checks, the
  member-row-write rule, evicted lookups, assignee rendering, reminder targeting.
  Each one is a place to get it subtly wrong, and getting it wrong on the apply
  side forks the space.
- Revoking a link is possible here (A can retract), which A cannot offer.

### Recommendation

**A, after the swarm-key split.** Not because sharing a secret is comfortable -
it is not - but because B pays for its safety with a permanent widening of every
trust rule in the app, and this codebase has just spent a day discovering how much
gets silently missed when one concept is spread across many places. A concentrates
the risk into a single, auditable moment (the transfer) rather than dispersing it
across the apply path forever.

If the transfer risk is judged unacceptable, the honest answer is not B - it is to
do the swarm-key split, fix nothing else, and leave people with two members and
export/import, which is where we already are.

## Compat

- The swarm-key split is invisible to peers: nothing reads another peer's DHT key.
- Linking itself is dormant until used, but a linked device's writes are
  indistinguishable from the original device's, so old peers need no new
  understanding under design A. That is a real advantage over B, which needs the
  capability gate before any alias claim is written.

## Verify

1. Swarm split alone: two devices, same identity file, confirm discovery and
   pairing still work and no intermittent dial failures over a long soak. This is
   the step most likely to surface something unexpected, so it ships alone.
2. Link a second device; confirm ONE member row, one avatar in the roster, and
   that an item assigned to that person rings on the device that set the reminder
   (reminderTargetOf already records the actor, so this should hold).
3. Both linked devices online at once, writing concurrently: they are two writers
   with one identity, so check no rule assumes one-writer-per-pubkey. The
   writer-binding `_w` field in listWire is the first place to look.
4. The old-peer fork test from the revocation proposal.

## Rollback

The swarm split is a straight revert. A link, once made, cannot be un-made in
design A - the other device knows the secret forever. The UI must say that in
those words before the transfer, not after.

## Open questions

1. Should linking be restricted to the same person's devices in any enforceable
   sense? It cannot be - possession of the key is the whole claim. So the question
   is really what the copy says, and whether "link a device" needs a scarier
   confirmation than anything else in the app.
2. Does the roster show one entry or one-with-two-devices? Two devices behave
   differently (an iPhone syncs only when open), so a household may genuinely want
   to know which one they are looking at.
3. Does this obsolete the per-device reminder targeting, or make it worse? If both
   my phones are one member, "ring on the device that set it" is still right, but
   `remindBy` now names a device that shares an identity with another.
