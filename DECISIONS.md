# PearList Decisions

Append-only, newest on top. See Constitution §4.

## 2026-07-11 - Grocery aisle categorization (category field + grouped UI)
Tier: T1 (additive field + new read-only-ish methods; no pairing/topic/encryption
change).
Context: PearList's backlogged "categories/aisles" feature - group a grocery list
by supermarket aisle so it maps to how you shop.
Choice: add an optional `category` aisle label to the item row, written by new
`ai:categorize` / `ai:categorizeList` / `ai:setCategory` worklet methods, and
group grocery lists by aisle in the UI (collapsible sections + long-press
drag-reorder). Classification goes through a single seam (`classifyItem` in
listMethods.js -> `classifyAisle` in aisles.js), backed by a pure offline keyword
classifier - instant, deterministic, works on every device, no dependencies.
`category` is additive: old peers accept + ignore it, non-grocery lists never show
it, so no merge rule changes. Aisle order + collapsed state are device-local
(localStorage), NOT synced; dragging an item onto another aisle recategorizes it
(via ai:setCategory, which does sync).
Alternatives: compute categories per-device as presentation only (rejected -
categorize once and sync the result so low-end/AI-less devices still see aisles).
Consequences: the `classifyItem` seam is the swap point for a smarter classifier
(an on-device LLM is layered in a separate follow-up branch, keeping the keyword
pass as the always-available baseline).

## 2026-07-07 - @peerloom/core stays one package with subpath exports (split CLOSED)
Tier: T0 (design decision + documentation; no code change). Resolves the open
question in proposals/2026-06-30-pearlist-core-extraction.md and the "core package
split" backlog item.
Context: the extraction proposal left open whether to keep a single @peerloom/core
with subpath exports or split into @peerloom/core + @peerloom/seeder +
@peerloom/device-link. Backlog carried "single package for v1, split once proven."
Findings: core is 828 LOC across 7 files and ALREADY ships subpath exports
(identity, records, swarm, ids, pairing, engine), so fine-grained imports exist
without multiple packages. It is tightly coupled around engine.js (493 LOC), which
requires identity/swarm/ids/pairing; records requires identity. Both consumers
(pearlist and pearpetal) use the engine, so nobody wants an engine-less subset. The
optional Tier-3 modules the split targeted (seeder, device-link, invite-kit) were
never built, so there is nothing optional to carve out. Splitting the base
substrate would fragment an interdependent unit and worsen the existing cross-app
native-version lockstep (see core's rocksdb-native pin) for zero functional gain.
Decision: keep @peerloom/core as a single package with subpath exports. Close the
split question and the backlog item.
Reopen trigger: only when an actually-optional, independently-useful module
(blind-seeder, device-link, invite-kit) is BUILT and an app wants it WITHOUT the
engine. Then extract that one module into its own package. Do not split the base
substrate speculatively.

## 2026-07-07 - Background-while-killed notifications: Android best-effort, iOS impossible serverlessly (WON'T-FIX)
Tier: T0 (design decision + documentation; no code change).
Context: the backlog asked for notifications delivered when the app is
backgrounded or killed. Notifications are LOCAL: the worklet's maybeNotify
computes them when it applies a synced peer change, so the process must be alive
(receiving P2P traffic and running code) for one to fire. "While killed" means it
is not.
Decision:
- Android: already the best achievable. The bg-sync foreground service (DECISIONS
  2026-07-05, default ON) keeps the process alive and connected while backgrounded,
  so notifications fire. A user force-stop or an aggressive OEM battery-killer
  stops it; START_STICKY + onTaskRemoved AlarmManager re-arm + the boot receiver
  resume it. That residual gap is inherent to Android and accepted.
- iOS: NOT possible under the no-server constraint. iOS suspends the app seconds
  after backgrounding and forbids the long-lived background networking Hyperswarm
  needs. BGTaskScheduler runs too rarely and briefly to coincide with a peer being
  online in a serverless mesh (near-useless). The only mechanism that wakes a
  killed iOS app is a push server (APNs), a centralized dependency the suite
  rejects. iPhones therefore stay "open-to-sync" (notify only while running),
  matching the suite pattern (PearGuard's Android foreground-service backbone; iOS
  has no background).
Rejected: an APNs/FCM push relay, even a content-blind or E2E-encrypted one. It is
still a server to run, against the no-server principle.
Deferred (serverless, not built): an on-open "while you were away" in-app catch-up
digest (not a notification). It would need a since-last-seen watermark separate
from maybeNotify's 60s freshness window, which deliberately suppresses the
catch-up burst to avoid replay spam.
Status: backlog item CLOSED as as-designed. Reopen only if the no-server principle
is ever revisited.

## 2026-07-07 - Completion notifications (P2) + notifications ON by default
Tier: T2 (additive app-local schema + notification policy). Second phase of
proposals/2026-07-07-list-categories-completion-notify.md; builds on the kind
field below.
Context: the notify loop was one-directional (assign -> notify:assigned to the
assignee, already shipped) but completing work fired nothing. A chore board wants
the return leg: when someone checks items, tell the person who oversees the list.
Choice (P2): the worklet's maybeNotify (listWire.js) gained a completion branch.
When a peer's item goes checked false->true and I am the list's CREATOR/owner
(list.createdBy === my key) and it was not my own change, my device emits
notify:completed per the list's mode. New optional list field `notifyOnComplete`
(`off | each | done`), additive + LWW like `kind`; absent -> derived default
(chore lists -> 'done', else 'off'), so existing chore lists get all-done alerts
with no migration. 'each' fires per completion; 'done' scans the list's items and
fires once when the last open one is checked (the just-checked item is already in
the view). maybeNotify is now async (reads the list row + item range) and awaited
in applyListOp inside try/catch so a read error never breaks apply. New IPC
list:setNotifyOnComplete; UI exposes it on chore lists (list options -> "Notify
when completed"). Shell (app/index.tsx) raises the OS notification on a new
'completion' channel and forwards an in-app banner; the all-done copy reads
"Chore list \"X\" is all done" (kind-aware).
RECIPIENT REVISED (per Tim, during on-device review): originally the proposal
picked the overseer (list.assignee). Changed to the list CREATOR (list.createdBy):
in the parent/kid model the parent creates a chore list and assigns it to the kid
(who gets notify:assigned = "this list is yours"); the parent, as creator, is who
should hear it got done. So assignment and completion now target different people
by design, which is the intuitive split.
Choice (policy reversal): notifications are now ON by default. loadNotifEnabled
requests the OS permission on first run and enables if granted, persisted so a
later explicit toggle-off is honored and we never re-prompt. This REVERSES the
2026-06-30 "opt-in, OFF by default" decision (per Tim). Watch: App Store review
may question a cold-start notification prompt; the Profile toggle still lets users
turn it off, and permission is only requested once.
Verified: `npm run verify` green (40 tests incl. 7 completion-branch unit tests +
setNotifyOnComplete round-trip; all builds). PENDING: on-device check of the
end-to-end assign->complete->notify loop across two phones.
Alternatives: per-item only or all-done only (rejected - shipped both via the
per-list toggle, Tim's call); notifying the assignee/overseer (rejected on review
in favor of the creator - see RECIPIENT REVISED above).

## 2026-07-07 - List categories (kind) + planned completion notifications
Tier: T2 (additive, app-local). Adds an optional `kind` field to the `list:`
record and new notification semantics later; touches only PearList's own
listWire.js / listMethods.js / UI, NOT @peerloom/core, the wire framing, or
pairing. Proposal: proposals/2026-07-07-list-categories-completion-notify.md.
Context: every list looked and behaved the same, and the notify loop was one-way
(assign fires notify:assigned, completion fired nothing). A chore board wants the
return leg: child completes -> overseer notified.
Choice (P1, this branch): lists carry a category `kind` enum
(grocery | chore | todo | list), chosen from a UI selector and NEVER inferred
from the list name. `kind` is optional and additive so old peers accept-and-ignore
it and old/absent lists default to the generic 'list' (rowApplyDecision only
validates pubkey/updatedAt/sig/namespace, LWW as usual - no migration). Drives a
per-list icon + color and groups the Lists page into category sections (headers
only show once more than one category is in use). New IPC: list:create gains an
optional `kind`; list:setKind changes it. Verified: engine round-trip test for
kind default/normalize/setKind + full `npm run verify` green (32 tests, all
builds).
Decisions (per Tim, for P2 - NOT yet built): completion notifications target the
list overseer (`list.assignee`) only (no createdBy fallback); granularity is a
per-list user choice (`notifyOnComplete: off | each | done`, default `done` for
chore lists). P2 also inherits the background-delivery limit (fires only while
the recipient's app runs; Android bg-sync covers it, iOS does not) - tie to
backlog #4.
Alternatives: keying behavior off the free-text list name (rejected - brittle);
user-defined category labels (deferred - fixed enum for v1 so behavior can key
off it safely, free-text tags can layer on later); notifying item createdBy
(rejected in favor of overseer-only per Tim).

## 2026-07-05 - Android background sync via a foreground service (default ON)
Tier: T1 (device-local infra; no wire/schema/cross-peer change - a background-
syncing peer talks to any peer normally).
Context: notifications only fired while the app was running, because Android
suspends the process when backgrounded and drops the Hyperswarm connection. For a
serverless P2P app, a periodic wake (15 min) rarely coincides with a peer being
online, so nothing syncs. A persistent foreground service keeps at least the
Android device continuously connected as a reliable sync/relay backbone; iOS has
no equivalent (App Store restrictions), so iPhones stay open-to-sync.
Choice: added an Android-only Expo local module `modules/bg-sync` (ported and
simplified from PearGuard's ParentConnectionService): a foreground Service
(startForeground + persistent notification + START_STICKY + onTaskRemoved
AlarmManager restart + wakeHost via the launcher intent), a BgSyncBootReceiver
(resumes on reboot if opted in, persisted in SharedPreferences), and a
BgSyncModule (start/stop). Setting `pearlist:bgsync`, default ON on Android;
toggle "Keep syncing in background" in Profile (hidden off Android). foreground
ServiceType=dataSync; FOREGROUND_SERVICE(+_DATA_SYNC) + RECEIVE_BOOT_COMPLETED.
Decisions (per Tim): default ON + boot restart. Verified: Kotlin compiles, service
+ receiver + permissions merge into the release manifest, verify/tsc green.
PENDING: on-device runtime validation of actual background sync + boot/kill
recovery (OEM-dependent; only Tim can confirm on real devices).
Alternatives: periodic background task (rejected - peers rarely online together);
Android foreground service was chosen over it for reliable continuous sync.

## 2026-07-02 - Strip aps-environment so expo-notifications signs with the wildcard profile
Tier: T1 (build/signing config; no runtime behavior change).
Context: expo-notifications ships its OWN config plugin (runs on prebuild even when
not listed in app.json) that adds the aps-environment entitlement + Push
Notifications capability. iOS archive then FAILS ("provisioning profile ... doesn't
include the Push Notifications capability / aps-environment") because PearList signs
with Xcode's wildcard team profile + empty entitlements (2026-07-01 bring-up
decision, no Apple-portal trip). We use LOCAL notifications only - no APNs - so the
entitlement is unwanted.
Choice: added plugins/with-strip-aps.js (withEntitlementsPlist deletes
aps-environment), listed LAST in app.json plugins so it runs after
expo-notifications. Entitlements regenerate empty; wildcard signing works. Also
removed the redundant explicit "expo-notifications" plugin entry (the package
auto-applies its plugin; POST_NOTIFICATIONS is set directly via android.permissions).
Alternatives: enable Push in the Apple portal + a real profile (rejected - we do
not use push and want to keep zero-portal wildcard signing).
Consequences: run `expo prebuild -p ios` after touching notifications; the strip
plugin keeps it durable. Also recorded the "npm install on the Mac after adding a
dep" gotcha in the devices memory.

## 2026-07-02 - Notifications implemented: assignment + join, opt-in, local
Tier: T1 (local plumbing; no wire/schema/cross-peer change). Implements the
2026-06-30 notifications policy (assignment-only, opt-in, off by default) and adds
join alerts per request.
Choice: detection lives in the worklet apply (listWire maybeNotify), so it fires
exactly when a peer's change is synced and reaches the RN shell even if the
WebView is backgrounded. It emits notify:assigned {text,by} when someone ELSE
assigns me an item (using core's new apply-ctx selfKey, core PR #11) and
notify:joined {name} for a never-seen member row. A 60s freshness window skips the
historical burst applied during an initial catch-up sync (no alert spam on
join/reopen); own-change and already-mine-item are also filtered. The shell
(expo-notifications ~0.32.17) raises a local OS notification if the user opted in
(shell:notifications:get/set, AsyncStorage, OFF by default; toggle in Profile),
with Android channels assignment/membership. setNotificationHandler suppresses the
banner while foreground (the WebView shows an in-app banner for assignment; join
already shows via the roster diff); the OS shows it when backgrounded.
Scope: NO background sync, so this fires while the app runs (foreground + brief
background window). Background delivery stays deferred (policy). Verified: 6 unit
tests on the detection logic (fresh/historical/self/already-mine/join), verify
green. On-device OS delivery needs a permission grant + two-device assignment test.
Alternatives: detect in the UI (misses backgrounded WebView, duplicates logic);
notify on every change (rejected by policy, spammy).

## 2026-07-02 - Live view-change events replace the 2.5s poll
Tier: T1 (additive local worklet->UI event; no wire/schema/cross-peer change).
Context: the UI polled list:getAll + item:getAll + member:getAll every 2.5s so a
peer's changes would surface. Wasteful and up to 2.5s stale.
Choice: @peerloom/core now emits `group:updated { groupId }` whenever a mounted
base's Autobase view updates (local edit or replicated-then-applied remote
change), trailing-debounced 120ms (core PR #10, engine mountBase). The UI
subscribes and refetches the active space on that event instead of the interval.
Kept: an immediate refresh on mount + on peer:connected, plus a slow 15s backstop
so a missed event self-heals (worst case 15s, not broken sync - never worse than
before). member:publish still retries on each refresh until writable.
Alternatives: emit on every 'update' undebounced (IPC flood during fast-forward);
debounce in the UI (still floods IPC); keep polling (the status quo).
Consequences: near-instant cross-peer updates, far less churn. New core event is
additive so old/new peers interoperate. Two-peer integration test added in core
(remote change -> group:updated on receiver, ~430ms), gate 39/39.

## 2026-07-01 - Reused-connection pairing fix VALIDATED / SHIPPED
Tier: T3 (writer-admission pairing in @peerloom/core).
Context: on-device re-trace was the last open item on
proposals/2026-07-01-pairing-reused-connection.md (the mux.pair lazy-open fix,
core aa83311).
Choice: accept the fix as shipped. All three devices (iPhone, Pixel, TCL) run it.
Validation trace (pearlist scripts/pull-pair-trace.sh): iPhone joined a new space
TraceTest2 (4-_t6dJN) over the connection it already had with the Pixel (single
peer:connected, never dropped) and went pair:remote-open -> onopen -> hello-sent
-> became-writable in ~5s, no 3rd-peer dependency. Pre-fix that channel got no
onopen and closed ~100ms later.
Consequences: multi-space writer admission now works over reused connections.
Proposal Status -> VALIDATED/SHIPPED. reviews/2026-07-01-pairing-reused-connection.md
added (Constitution §6). Candidate merges: core feature/pairing-trace-hook,
pearlist feature/ios-bring-up. Separate slow first-connect (DHT discovery) stays
open - see TODO and DECISIONS below.

## 2026-07-01 - iOS Local Network permission force-prompt module
Tier: T1 (device-local permission trigger; no wire-format, IPC, Hyperbee key, or
Hyperswarm-topic change - old and new peers still talk, LAN or relay).
Context: PearList never appeared under iOS Settings -> PearList -> Local Network
and never prompted, even though app.json/Info.plist correctly declare
NSLocalNetworkUsageDescription + NSBonjourServices. Root cause: iOS only surfaces
the prompt/toggle after the app first actually touches the LAN, and modern
Hyperswarm (hyperdht, DHT + UDP holepunch, no Bonjour) apparently never attempts
a direct same-subnet connection on first launch. Suspected cause of the
unconfirmed ~147s cold first-connect (peers falling back to the relayed path).
Choice: added an iOS-only Expo local module `modules/local-network`
(LocalNetworkModule.swift) that, at app boot, advertises + browses a throwaway
Bonjour service `_pearlistlan._tcp` (added to NSBonjourServices) via the Network
framework. Browsing makes iOS evaluate LAN access and show the prompt; once
granted, the whole app process (including the Bare sockets) may reach LAN peers
directly. Called fire-and-forget from app/index.tsx boot effect
(requestLocalNetworkPermission), no-op off iOS via requireOptionalNativeModule.
Probe tears itself down after ~8s. ios/ regenerated via prebuild so the new
Bonjour type ships.
Alternatives: reuse the inert `_hyperswarm._udp` type (rejected - UDP NWListener
advertising is finicky and mismatches a TCP listener); browse-only with no
advertise (less reliable trigger across iOS versions); a native AppDelegate hook
via config plugin (more brittle than an autolinked local module).
Consequences: first PearList native module. Verify green (25/25), tsc clean,
autolinking resolves podName LocalNetwork. Pending on-device confirmation that
the prompt appears + the toggle shows, then whether it actually cuts same-WiFi
connect latency (the real motivation).

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
