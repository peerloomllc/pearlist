# PearList Decisions

Append-only, newest on top. See Constitution §4.

## 2026-07-01 - iOS bring-up (first iPhone build)
Tier: T1 (build/infra; no wire-format or app-behavior change).
Context: iOS was the last unproven leg of the three-layer stack. Android deploy
was already live; the iPhone had never run the app.
Choice:
- **Native project**: generated with `expo prebuild -p ios` (NOT committed - ios/
  stays gitignored per the existing "regenerate native from app.json + plugins"
  convention). app.json already carried the iOS bits (bundleId com.pearlist, and
  the P2P-critical Info.plist keys NSLocalNetworkUsageDescription +
  NSBonjourServices `_hyperswarm._udp` + NSCameraUsageDescription for QR scan).
  Generated entitlements are empty (`<dict/>`) so Xcode's cached wildcard team
  profile covers com.pearlist with no Apple-portal trip - same approach as
  PearCircle.
- **Pipeline**: `scripts/ios-dev-install.sh`, ported from PearCircle's proven
  dev-install (rsync -> pod install -> Release archive -> export dev IPA ->
  install + launch via `xcrun devicectl`). Same Mac mini host, team G79ALD29NA,
  and paired iPhone SE. Made self-contained: it runs prebuild if ios/ is absent.
- **One-time Mac setup** (rsync excludes node_modules; pod install resolves
  expo/react-native from it, and PearList's `file:../peerloom-core` dep needs the
  sibling present): rsync peerloom-core to the Mac + `npm install` in pearlist.
  Documented in the script header; node_modules then survives future rsync runs.
Consequences: first iOS build installed + launched on the iPhone SE. Still open:
the cross-platform sync smoke (iPhone joins a Pixel/TCL space) to prove iOS
local-network P2P end to end.

## 2026-07-01 - Item notes + hyperlink
Tier: T1 (additive item fields; no wire-format break - item rows already carry
arbitrary signed fields).
Context: user wants a per-item note and the ability to link an item to an
external product page (Shipt-style), tappable to open in the browser.
Choice:
- **note**: optional free-text on an item, capped at 2000 chars. Rendered as
  small muted text directly under the item text in the list row, and editable in
  the item detail sheet. In item:edit, `note: undefined` leaves it untouched,
  `''` clears it.
- **url**: optional link, sanitized by cleanUrl() in the worklet: full http(s)
  kept as-is, a bare domain (kroger.com/p/x) upgraded to https://, anything else
  (javascript:, data:, ...) dropped to ''. Shown as a link icon on the row and
  in the editor; tapping opens it externally via the existing shell:openUrl.
- Deferred the live price/catalog half of the Shipt idea: that needs a
  centralized/third-party store API and cuts against the no-server ethos. This
  ships the hyperlink half only (see [[project_pearlist_feature_backlog]]).

## 2026-07-01 - Invite links, wallet detection, haptics, back gesture
Tier: T2 (invite presentation + new shell bridges); no wire-format change.
Context: four polish items for the shell/UX.
Choice:
- **Invite as a URL**: the raw invite stays an opaque base64url blob (core
  encoder), but the UI now presents it as
  `https://peerloomllc.com/pearlist/join#<blob>`. The blob rides in the URL
  FRAGMENT so it never reaches the peerloomllc.com server (it grants access).
  QR, copy, and share all emit the URL; parseInvite() accepts a bare blob, a
  #fragment, an ?i= query, or a post-/join tail, so paste/scan/deep-link all
  work. The shell forwards opened invite URLs as a `deeplink:invite` event and
  the UI auto-joins. NB: tapping an https link auto-opens the app only once
  peerloomllc.com hosts /.well-known/assetlinks.json (domain verification);
  until then the reliable paths are copy-link/paste and scan-QR (both shipped).
- **Early-event buffer**: events delivered before React mounts (a cold-start
  deep link fires at WebView onLoad, before the app's on() listeners register)
  were lost. ipc.js now buffers events with no listener and replays them when a
  listener subscribes. Fixes deep-link-on-cold-start; harmless for live events.
- **Lightning wallet detection**: Android 11+ hides external handlers unless
  declared. New config plugin plugins/with-android-queries.js adds a <queries>
  block for lightning:, bitcoin:, https:, and mailto: so canOpenURL/openURL
  work (the BTC donate flow can detect an installed wallet).
- **Haptics**: shell:haptic already existed; the UI now calls it. Shared Button
  (light; danger buzzes 'warn') and IconButton wrap their onClick via tap();
  the item checkbox ('success' on check), Toggle, and the add (+) buttons buzz.
- **Back gesture**: the UI reports canBack (any open sheet / full-screen view /
  list detail / modal) via shell:navState; the shell's BackHandler forwards a
  'back' event to dismiss the top layer and consumes the press, else lets the OS
  exit. New shell bridge: shell:navState.

## 2026-07-01 - Menu tidy, contrast, animated avatars
Tier: T1 (UI) plus a stored-value cap bump (mildly wire-relevant).
Context: on-device UX pass. Four asks.
Choice:
- **Delete space** moved from the Profile bottomsheet to the **Spaces switcher**:
  a trash affordance per row, shown only for spaces this device owns
  (`space.owner`). deleteSpace(groupId) now targets any owned space, not just
  the active one; a joiner sees no trash. Reasoning: delete belongs with the
  space list, not personal settings.
- **Invite peers** removed from the Profile bottomsheet: redundant with the
  share button already on the Space page. Menu is now profile + About only.
- **Contrast** bumped in both themes (border, divider, text-muted) and the
  Toggle gained a dedicated `--color-track` off-state + knob shadow, so the
  dark-mode switch is legible in light mode (was near-invisible white-on-white).
- **Animated avatars**: gif/webp are stored as their raw base64 data URL (no
  canvas re-encode, which flattened them to one frame); static images still
  downscale + re-encode to jpeg. Cap the raw file at 2 MB; the worklet's
  profile.avatar stored-value cap rises 400 KB -> 3 MB chars to clear a 2 MB
  file's base64. Cost: an animated avatar replicates inline in each member row
  across every joined group. Acceptable behind the 2 MB cap; revisit if member
  rows get heavy (a blob-core for avatars is the later fix).

## 2026-07-01 - Space delete (owner-only) + members view + join banner
Tier: T3 (new `space` singleton wire key) for delete; T1 for the UI-only bits.
Context: owner should be able to delete a space and notify members; users want to
see who is in a space and get told when someone joins.
Choice:
- **Owner** = whoever claimed the space's signed `space` owner record first.
  On create the founder calls space:init, which writes a signed
  `space` = { owner:<self pubkey>, name, createdAt }. applyListOp accepts the
  FIRST `space` write only if owner === signer, and every LATER write only from
  that owner (v.pubkey === existing.owner). spaces:list derives its `owner` flag
  by reading space.owner from the view.
  NB: an earlier draft tied ownership to the Autobase bootstrap writer
  (base.local.key === base.key). Rejected: that identity is only stable right
  after create and flips after a remount, so Delete vanished on-device. The
  signed record is durable across remounts.
- **Delete**: owner writes a signed `space` tombstone ({ ...meta, deleted,
  deletedAt }). Only the owner's signed update is accepted (see above). On a
  fresh delete the apply emits `space:deleted`; each member's UI calls
  space:forget (drops groups:joined) and moves off it. The owner also forgets
  locally on delete. New methods: space:init, space:delete, space:forget.
- **Members view**: lives on the Space page as a MembersBar (overlapping avatars
  + count) that opens the members sheet, NOT in the Profile bottomsheet (moved
  there for discoverability). Lists member:getAll (already synced).
- **Join notification**: v1 is an IN-APP banner ("X joined"), detected by diffing
  the roster in the poll (skips initial load + self). True OS/push notifications
  need expo-notifications + background sync - deferred (see notifications policy).
Alternatives: per-member ACL for delete (rejected, single-owner rule is simpler);
real OS notifications now (deferred, bigger).
Consequences: base stays mounted in-memory after delete until app restart (minor;
groups:joined removal stops it next launch). Non-owner delete throws.

## 2026-06-30 - Model: multiple "spaces", not one household
Tier: T2 (app model + new method; no wire-format change)
Context: users need lists shared with different people (family vs a friend group)
kept fully separate. Per-list ACLs inside one group are NOT real privacy - every
group member replicates the whole Autobase, so hiding is cosmetic.
Choice: each sharing circle is its own space = its own group / Autobase (own
encryption key + swarm topic + members + invite). A device can be in many; the
@peerloom/core engine already supports multiple groups, and every list/item/
member method already takes groupId. UI reframed from "household" to "spaces"
with a top-level space switcher; "household:get" became "spaces:list". Segregation
is cryptographic: a friend-space peer never replicates family-space data.
Alternatives: one group + per-list visibility flags (rejected, not real privacy);
one Autobase per LIST (rejected, re-invite the same people for every list).
Consequences: onboarding creates/joins a space; invite is per-space; members and
assignment are per-space. Existing single-group data is just a space of one.

## 2026-06-30 - Member roster + member-based assignment (items and lists)
Tier: T3 (new wire namespace + persisted field)
Context: assignment was free-text with no notion of who is in the household.
Choice: add a shared member roster. Each device publishes its profile as a
`member:{pubkey}` row (signed { pubkey, displayName, avatar?, updatedAt }),
owner-scoped: rowApplyDecision requires the key's pubkey segment to equal the
signed value's pubkey, so nobody can spoof another member's entry. Assignment is
by pubkey: item.assignee and list.assignee hold a member pubkey (or null). The UI
resolves pubkeys to name+avatar via the roster and offers a tap-to-pick member
sheet. Lists are assignable too (a "responsible person"). New methods:
identity:get, member:publish, member:getAll, list:assign.
Alternatives: free-text names (rejected, no identity, can't drive notifications);
storing name/avatar on each item (rejected, denormalized + stale on rename).
Consequences: unblocks the assignment notification from the notifications
decision. member:publish is retried by the UI poll until the base is writable.

## 2026-06-30 - Notifications: minimal, assignment-only, off by default (v1)
Tier: T1 (product policy, no wire change)
Context: deciding whether and what to notify in a shared-list app.
Choice: keep notifications minimal. The ONLY notification is "someone assigned an
item to you" (accountability), opt-in and OFF by default. No notifications for
item add / check / edit - too frequent, the surest way to get an app muted or
deleted. A quiet once-a-day digest is a possible later opt-in, not in v1.
Notifications are LOCAL (no server, no push): generated on-device when the worklet
syncs a change, same as the suite's background sync. First release may ship with
notifications OFF entirely and add assignment alerts in a follow-up.
Alternatives: notify on every change (rejected, spammy); none ever (viable, but
assignment alerts add real value once assignees map to members).
Consequences: the assignee feature should carry enough context to raise a local
notification later; assignees are free-text today, so member-mapped assignees are
a prerequisite. Revisit when the shell + background sync exist.

## 2026-06-30 - Items use shared content-keyed rows, not writer-scoped rows
Tier: T3
Context: the original proposal sketched items as item:{listId}:{pubkey}:{seqPad}
(writer-scoped, like PearCircle trips). That would let only the author edit or
check an item. A shared shopping/chore list needs ANY household member to check
or edit ANY item.
Choice: items are keyed item:{listId}:{itemId} (itemId = newEntityId). Any
admitted writer may write any item; the value's `pubkey` records the LAST editor
and the signature proves it; concurrent edits resolve last-writer-wins by
updatedAt with a signature tie-break. Same shape for list:{listId} rows. Delete
is a { deleted: true } tombstone with no-resurrection. Implemented in
src/listWire.js (rowApplyDecision) + src/listMethods.js.
Alternatives: writer-scoped item keys (rejected, blocks shared check-off);
CRDT per-field merge (overkill for a list).
Consequences: no per-writer integrity on rows, which is fine inside a trusted
admitted-writer household. Supersedes the item-key shape in proposal
2026-06-30-pearlist-core-extraction.md.

## 2026-06-30 - PearList is the @peerloom/core extraction vehicle
Tier: T3
Context: suite needs a reusable P2P core; substrate already proven by three
shipped apps (PearCal, PearGuard, PearCircle), so the next build's job is reuse,
not de-risking. PearList is the cheapest low-stakes app to extract against.
Choice: build PearList on a new `@peerloom/core` package extracted from
PearCircle (the modular donor). Leave the three shipped apps on copy-fork for
now; migrate them later in a separate proposal.
Alternatives: copy-fork PearList too (rejected, defers the extraction with no
gain); build PearCare first (rejected, do not refactor shared infra under a
live sensitive app).
Consequences: see proposal 2026-06-30-pearlist-core-extraction.md.

## 2026-06-30 - Standardize on PearCircle's IPC envelope and topic model
Tier: T3
Context: PearCircle and PearCal diverge on two substrate choices the core must
unify.
Choice: (1) IPC envelope = PearCircle's object-args handler-map with
`{ id, result }` responses; PearCal's reverse-RPC `nativeRequest` becomes an
optional opt-in. (2) Swarm topic = `blake2b(groupKey)` with a separate block
encryption key (PearCircle), NOT PearCal's key=topic, so blind seeders stay
possible later.
Alternatives: PearCal's positional-args switch + key=topic (rejected, less
extractable and forecloses blind seeders).
Consequences: `@peerloom/core` freezes this in its v1 API.
