# Getting a space back after 1.0.9 ate its own blocks

**Status:** proposed
**Tier:** T3 - repair re-runs the pairing flow, and a repaired device has to be
re-admitted as a writer. No wire change, no new op, no consensus state.
**Date:** 2026-09-10

## The forcing function

A user reported PearList 1.0.9 opening to a black screen after a GrapheneOS system
update, then a black screen with the loading spinner and nothing else. Phone
restart and clearing the app cache did not help.

It is not GrapheneOS. It is ours, and it is shipped.

1.0.9 runs retention every 30 minutes at `keepRecent: 512` (`src/bare.js`), against
a core whose `retain()` swept the device's OWN local input core alongside remote
writers'. Those blocks are the only copies that phone has. Sweeping them stops the
base being self-sufficient, and the next cold start with no peer nearby waits on a
block nobody can serve. Init was unbounded in that core, so it waits forever.

Measured 2026-09-10, same script both sides, 200 items then `space:retain` with
`keepRecent: 20`, then a cold start with no peer:

| core | cleared | local block 0 | cold start |
| --- | --- | --- | --- |
| as shipped in 1.0.9 | 181 of 201 | gone | **init hung** |
| at HEAD | 0 | intact | opened, 200 items readable |

Core fixed it on 2026-09-09 (`8252844`), seven days after 1.0.9 went out on
2026-09-02. Its own commit message describes the same symptom reported by a
PearPetal partner-viewer on iOS: blank screen days after pairing, restart no help,
reinstall and re-pair the only way back. Two apps, one bug, reported twice before it
was understood once.

**This proposal is not about that bug.** Master already carries the fix and PR #184
already makes a dead engine say so. This is about the phones it has already
happened to, which the fix does nothing for.

## What a damaged phone does on the next version

Better, and still wrong. Init is bounded now, so the app opens instead of hanging.
Then:

- `spaces:list` reads `groups:joined:` straight out of localDb
  (`src/listMethods.js:978`), so the damaged space is still listed and still looks
  completely normal in the switcher.
- Every call that needs the base throws `unknown group: <id>`
  (`viewFor`, `src/listMethods.js:940`), because nothing ever mounted.
- `loadLists(gid)` at `src/ui/App.jsx:1653` has no `.catch`, so `lists` keeps its
  previous value - `[]` on a cold start - and the rejection goes unhandled in the
  WebView.

So the user sees **their space, with nothing in it**. That is the "my lists are
gone" screen PR #184 spent its whole effort avoiding, arriving through a different
door. And the obvious thing to do about an app showing an empty space is to clear
its storage, which is the one action that turns a recoverable space into a lost one.

## What core already gives us, and nobody is using

`grep -rn "unmounted\|mount:failed" src/ app/` returns exactly one line, and it is
a React comment about a component remounting. Nothing in this app reads either.

- `engine.unmounted` - a `Map` of `groupId -> reason a mount did not finish`
  (`peerloom-core/src/engine.js:107`), written when a bounded mount fails
  (`:432`) and cleared when one later succeeds (`:246`).
- `group:mount:failed` - emitted with `{ groupId, error }` at the same point.
- `joinGroup({ inviteKey, announce, namespace })` - `namespace` is persisted with
  the membership and re-applied on every later mount. A fresh one gives the group a
  new local writer and re-syncs it from the peer. Default is the groupId, so
  anything not passing it is unchanged (`e2cfce8`).

And the invite does not have to come from the other side: `spaces:list` already
re-encodes one from the stored membership record (`src/listMethods.js:982`), which
holds `groupKey`, `encryptionKey`, `bootstrap` and `name`. The damaged phone can
re-join itself with what it already has on disk.

## Goal

A phone whose space will not open says so, and offers to rebuild that space from a
housemate, rather than showing an empty space and inviting a wipe.

## Scope

**Changes:**

1. `spaces:list` marks each space with `available: false` and the mount failure
   reason, read from `engine.unmounted`. Additive field.
2. A new `space:repair` IPC method: re-encode the invite from the stored
   membership, call `joinGroup` with a freshly generated namespace, report whether
   the base came back writable.
3. The UI stops rendering an unavailable space as an empty one. It shows what
   happened, what it will do, and what it costs, with a Repair button.
4. `loadLists` gains a `.catch` so an unmountable space can never again present as
   an empty one by accident, whatever the cause.

**Does not change:** the wire format, the apply rules, any Hyperbee key, the invite
format, the admission rules, or what any other peer does. The namespace is
device-local and lives only in this device's membership record.

## The part that has to be said honestly

**Repair needs a peer who is a writer and awake.** A rebuilt namespace means a new
local writer key, and a new writer is admitted the ordinary way: an existing writer
appends `addWriter` over the pair channel. So repair works when a housemate (or your
own second phone) still has the space and is reachable. It cannot work when the
damaged device is the only writer the space ever had. For that person the lists are
gone, and the screen has to say so plainly instead of offering a button that will
sit at "waiting" forever.

**Repair abandons whatever the old local core held and no peer ever received.** The
old cores stay on disk as dead weight rather than being deleted, but nothing reads
them again. Anything written on that phone while it was alone, and never replicated,
does not come back. That is the trade and the copy has to name it.

**The 15-second mount timeout is not proof of damage.** `mountTimeout` defaults to
15s. A slow phone with a large store, or a cold start racing a first connection,
could time out on a perfectly healthy space and land on the same screen. Offering a
one-tap Repair there would throw away a good local writer for nothing. So:

- Repair is never automatic. It is a button, behind a confirm that names the cost.
- The screen offers "Try again" first, which re-attempts the mount without
  rebuilding anything.
- Repair should be reachable only after a retry has also failed.

## Compat

Old peers are unaffected: they see an ordinary join from a new writer key, which is
a flow they already run. A repaired device appears in the roster as a new device key
for the same person, so device-vs-person collapse
(`src/memberIdentity.js`) governs how it displays, and that is existing behaviour
rather than something this adds.

`available` is an additive field on `spaces:list`. An older UI ignoring it behaves
exactly as it does today.

No migration. Nothing on disk is rewritten; a repaired space gains a `namespace` on
its membership record, which core already persists and re-applies.

## Verify

1. **The damage, reproduced.** Build a store on the 1.0.9-era core, run
   `space:retain`, close, reopen. Init hangs. Already done 2026-09-10, and the
   harness is in this session's notes.
2. **Unavailable is reported, not empty.** Same damaged store on current core:
   `spaces:list` returns the space with `available: false` and a reason, and the UI
   renders the explanation rather than an empty overview.
3. **Repair with a peer present.** Two peers, one damaged. Repair re-joins in a
   fresh namespace, is re-admitted, and the lists come back. Then close and reopen
   with the peer gone: the repaired store opens alone. Core has a two-peer test of
   exactly this shape (`peerloom-core/test/two-peer.test.js`, added in `e2cfce8`);
   this needs the app-level equivalent.
4. **Repair with no peer.** The button explains rather than hanging.
5. **A healthy space is never offered a destructive repair.** Force a mount timeout
   on a healthy store and confirm Try again recovers it without a rebuild.
6. `npm run verify` green.

## Rollback

Revert the PR. `available` is additive and `space:repair` is a new method, so
nothing else reads either. A space already repaired stays repaired: its namespace is
in its own membership record and core applies it whether or not this app's UI knows
what a repair is.

## Open questions

1. **Do we tell people who cannot be repaired that their lists are gone, or keep
   the space listed and unavailable indefinitely?** Listing it forever is gentler
   and also dishonest. Leaning towards saying it plainly with an offer to remove the
   space from this phone.
2. **Should Repair be offered at all when the space has only ever had one writer?**
   We can tell from the stored membership whether this device is the founder. If it
   is, and no other writer was ever admitted, repair cannot succeed and the button
   should not appear.
3. **How many 1.0.9 phones are actually affected?** Anyone whose space churned past
   ~512 blocks and who then cold-started without a peer. Unknown, and unknowable
   without asking. It changes how much this is worth.
4. **Should the old cores be deleted after a successful repair?** Core leaves them
   deliberately. They are dead weight, and deleting them is the one step that cannot
   be undone if the repair turns out to be wrong.
5. **Does PearPetal need the same thing?** It hit this bug first, on iOS. If so this
   belongs in core or in a shared module, not three times in three apps.
