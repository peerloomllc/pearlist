# Adopt @peerloom/device-link (one person, several devices, one identity)

## Goal

Let one person's phones be one person - so a second phone, or a replacement
phone, is not a stranger to their own household.

## Tier

T3. Identity is what every trust rule in the app is keyed on: `space.owner`,
`space.evicted`, the member-row write rule, `assignee`, `reminderTargetOf`. How
far this proposal goes decides whether apply behaviour changes at all (see
"The decision that decides everything").

## This replaces a from-scratch design, and that is the point

The first version of this file designed two mechanisms from nothing. Both were
worse than what the suite already has, and writing them was wasted effort that a
few minutes of looking would have avoided. What actually exists:

- **`@peerloom/device-link`** - mnemonic identity, a personal multi-device
  Autobase, the pairing handshake, and a linked-device roster. Extracted from
  PearCal the way `@peerloom/core` was extracted from PearCircle.
- **PearPetal has already adopted it** (`pearpetal/proposals/2026-07-12-adopt-device-link.md`),
  so the integration shape is not hypothetical - there is a worked example with
  decisions already argued.
- **Core's seam is already cut.** device-link needs the app's `store` and `swarm`;
  core exposes both on the engine object and in `methodCtx`, with a comment naming
  device-link as the reason. **No core change is needed to adopt.**

## State of the parts, verified rather than read off a README

| | Status |
| --- | --- |
| device-link pure modules (pair-link, handshake, device-meta, identity) | `npm test` **21/21** |
| device-link stateful engine (`personal.js`) | `npm run test:integration` - two-peer pairing **passes**, group-plugin fan-out **passes** (both run 2026-07-28) |
| Core seam (`store` / `swarm` exposed) | already in `master` |
| PearPetal adoption | proposal decided, `deviceLink.js` + `privateStore.js` wired |

**And the thing that matters most: the donor never fully shipped.** PearCal's
mnemonic and pairing code exists and reads as complete, but it is not in use
(Tim, 2026-07-28). So this is NOT a battle-tested feature waiting to be consumed.
PearList would be helping finish it, and should plan for engine bugs surfacing in
`@peerloom/device-link` rather than in PearList. PearPetal's proposal already
carries one such known defect: a **deferred B->A writer stall under connection
churn**, with a hard gate that it must be proven fixed on hardware before their
flag flips.

## The decision that decides everything

PearPetal chose **coexist**, and it is the low-risk option:

> core's per-device keypair keeps signing rows exactly as today; device-link's
> mnemonic is the recovery + pairing anchor for the personal base only.

**Read that carefully, because for PearList the low-risk option does not buy the
headline.** PearList's spaces are core groups. Their rows are signed by the core
per-device key. So under coexist:

- Two linked phones are still **two members** of a space.
- A reinstall is still a **new person**, even holding the recovery phrase.
- `space.owner` still dies with the device.

Coexist gives PearList a recovery phrase for a personal base it does not currently
have, and a device roster - real, but not the wart anyone actually feels.

The version that fixes the wart is the one PearPetal explicitly deferred:

> **Mnemonic-root**: derive core's per-device key from the device-link mnemonic so
> there is a single identity source. Touches core identity generation - a separate
> T3, not this change.

That is the slice PearList actually wants, and it is the dangerous one: it changes
what a member IS, across every space already in the field, in an app where the
member key is written into signed rows that other people's devices have already
accepted.

**Recommendation: plan for mnemonic-root as the goal, but land it last and behind
its own gate.** Slices 1-3 are useful on their own and are how the engine gets
exercised before it is trusted with identity.

## What PearList must supply

device-link is injected with the app's runtime and its app-specific pieces:

1. **A keystore.** PearList has none today - the mnemonic must live in native
   secure storage, not localDb, or a device wipe takes the recovery phrase with
   it and the whole point is lost. PearCal does this through a native request;
   PearList would need the equivalent module.
2. **`records` + `mirror`** - what personal-scope records exist and where they
   land locally. PearList has no personal-scope data today. Candidates that are
   currently device-local and were lost on a wipe until this afternoon's backup:
   Learned Aisles, custom aisle names, saved lists. Moving those onto the personal
   base would make them follow the person rather than the phone.
3. **A `groupPlugin` - unlike PearPetal.** PearPetal injects none, because partner
   sharing stays on core. For PearList the groups ARE the product: a newly linked
   device must be cross-granted writer access on every space the person is in, or
   it links successfully and then cannot write to anything. device-link has this
   leg (`group-plugin.integration.js`, passing) and PearList would be its first
   real consumer.

## UI (the question that prompted this)

There is none today, because nothing is built. Where it goes, following PearCal:

- **Onboarding becomes a two-level choice.** Today PearList asks one question
  (create / join / open a saved copy). With identity separated from space, the
  first question becomes *who are you* - "Start fresh" vs "I already use PearList"
  (pair with a device you still have, or enter a recovery phrase) - and only then
  the existing space question. PearCal's wording is worth stealing: *"Pair to
  bring your identity, profile, and groups across from another device."*
- **Settings -> Linked devices**: the roster from `listLinkedDevices()`, with
  nickname editing and unlink, plus a "Pair another device" action.
- **Settings -> Recovery phrase**: show and save, with a re-entry point for
  restore. This is the user-visible payoff, and it is the first screen in PearList
  where showing something on-screen is itself the risk - it deserves the scarier
  confirmation, not the same styling as an invite.

## Slices

1. **Dependency + keystore + personal base, dark.** No UI. `createDeviceLink`
   beside the group engine, behind a flag. Exercises nothing user-facing.
2. **Pairing + Linked devices in Settings.** The roster and the handshake, with
   the group plugin so a linked device can actually write. This is where the
   engine gets its real workout, and where the B->A stall would show up.
3. **Recovery phrase surface + restore in onboarding.** Under coexist this
   recovers the personal base, not space membership - the copy must not overstate
   it, or the first person to lose a phone will be angrier than if we had said
   nothing.
4. **Mnemonic-root (separate T3, own gate).** Core's signing key derives from the
   mnemonic. Only now do "same member across my phones" and "a reinstall is still
   me" become true. Needs a migration story for identities already in the field
   and its own fork test.

## Compat

- Slices 1-3 are additive: a device that never pairs behaves exactly as today.
- Slice 4 is not. Every space in the field has member rows and an owner keyed to
  the current per-device keys. Changing how that key is derived either needs those
  identities carried across (the old key keeps working, the mnemonic-derived one
  is added) or it orphans people from their own spaces. That migration is the
  hard part of slice 4 and should be designed before slice 4 is started, not
  during.

## Verify

- device-link's own gates green: `npm test` 21/21 AND `npm run test:integration`
  (both files), since the second is where the engine actually lives.
- PearList `npm run verify` green.
- **On hardware, and the emulator counts**: today's swarm-key work was verified
  with an Android emulator as a genuine second peer (NAT'd, so discovery and
  holepunching are real). The same rig works for pairing.
- **Hard gate, borrowed from PearPetal: B->A must be proven on hardware before any
  flag flips.** An edit on the linked device must reach the founder device without
  a restart.
- Slice 4 additionally needs the old-peer fork test: a device on the previous
  build must not diverge from one on the new.

## Rollback

Slices 1-3 sit behind a flag and revert cleanly. Slice 4 does not: once a space
has accepted rows signed by a mnemonic-derived key, reverting the derivation
strands them. That is the reason it is last and separately gated.

## Open questions

1. Does PearList want personal-scope records at all (slice 1's `records`/`mirror`),
   or is the personal base only an identity anchor? Moving Learned Aisles and saved
   lists onto it is the obvious win, but it is also a second migration.
2. Under coexist, what exactly does the recovery-phrase screen promise? "Recovers
   your identity" is false for spaces until slice 4.
3. Is the swarm keypair (shipped today, core #17) enough of a per-device anchor, or
   does device-link want its own notion of "this device" for the roster? The roster
   keys on the Autobase writer key today, which is per-device already.
