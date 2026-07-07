# 2026-06-30 - PearList scaffold + PeerLoom core extraction

**Goal**

Stand up PearList (shared household lists) as the deliberate vehicle for
extracting a reusable P2P core package (`@peerloom/core`) out of the
copy-forked apps, so future apps (PearCare next) inherit a proven engine.

**Tier**

T3. New app, new wire protocol, new pairing surface. No deployed PearList peers
exist yet, so there is no backwards-compat burden, but the extraction sets
suite-wide architecture precedent, which warrants the full gate.

**Scope**

In scope:
- New repo `pearlist/` built on the three-layer architecture (RN shell +
  WebView UI + Bare worklet), copying the boilerplate configs verbatim from
  PearCircle (`babel.config.js`, `metro.config.js`, `tsconfig.json`, `app.json`
  shape, `index.js` headless-task entry).
- New repo `peerloom-core/` (`@peerloom/core`), consumed by PearList via a
  `file:../peerloom-core` dependency.
- PearList wire protocol (the `list:` / `item:` Hyperbee namespaces below).

Out of scope (explicitly NOT touched in this change):
- PearCal, PearGuard, PearCircle stay on copy-fork. We do NOT migrate the three
  shipped apps onto `@peerloom/core` in this proposal. Migration is a separate
  future proposal once the package has proven itself under PearList. This keeps
  the change contained and keeps three shipped apps off the risk surface.
- The Tier-3 optional modules (blind-seeder, device-link, invite-kit) are
  designed for but not extracted yet. PearList v1 ships without a seeder.

**The extraction (donor: PearCircle, per the mapping)**

`@peerloom/core` exports three layers:

Tier 1 - lifted near-verbatim from PearCircle:
- `identity` - Ed25519 keypair load/persist/sign/verify (`src/identity.js`).
- `records` - canonical-JSON signing (`src/lib/sign.js`:
  `canonicalize`/`signValue`/`verifyValue`).
- `swarm` - `topicForKey(key)` = `blake2b(key)` plus domain-separated
  rendezvous (`src/swarm.js`). Standardized on PearCircle's hashed split, NOT
  PearCal's key=topic. This is the encryption-model decision.
- `ids` - random group id / keypair / encryption-key generators
  (`src/circle.js`, renamed `ids.js`).
- `pairing` - `setupPairChannel` writer-admission Protomux channel
  (`src/pair.js`). The single best reusable artifact.
- reliability helpers - `appendTimeout.js`, `storeFlush.js`, `rewindGuard.js`,
  `conflictSeatbelt.js`, `fanOut.js`, `backendBootstrap.js`.

Tier 2 - the parameterized engine `createGroupEngine(opts)`:
Owns Corestore + local Hyperbee bootstrap, identity persistence, the per-group
Autobase create/join + `_bases` registry, Hyperswarm connect/replicate/muxer +
join/leave/flush/network-change, and the IPC framing loop + dispatcher.
The app supplies `openView`, `applyOps`, the IPC `methods` table, and its key
schema. The IPC envelope is standardized on PearCircle's object-args handler-map
with `{ id, result }` responses. PearCal's reverse-RPC `nativeRequest` channel
is imported as an optional opt-in (`enableNativeRequests`), since PearList does
not need it but PearCare/PearGuard might.

API surface (frozen for v1):
```
const engine = createGroupEngine({
  dataDir,
  appId: 'pearlist',          // domain separation + build-flavor isolation
  buildFlavor,                // 'release' | 'debug' - swarm isolation
  openView,                   // (store) => Hyperbee
  applyOps,                   // (nodes, view, base, ctx) => Promise<void>
  methods,                    // { name: (args, ctx) => result }
  onEvent,                    // (event, data) => void
})
await engine.start(ipc)
engine.identity                       // { publicKey, secretKey }
await engine.createGroup({ name })    // owner -> { groupId, inviteKey }
await engine.joinGroup({ inviteKey }) // joiner
await engine.append(groupId, op)      // timeout-wrapped base.append
```

**PearList wire protocol**

One Autobase per household group. Group == household, holding many lists.

```
Hyperbee view keys
  list:{listId}                      -> signed { id, name, createdBy, createdAt,
                                                 updatedAt, pubkey, deleted? }
  item:{listId}:{pubkey}:{seqPad}    -> signed { id, listId, text, qty, checked,
                                                 assignee?, updatedAt, pubkey,
                                                 deleted? }
localDb (never replicates)
  identity                           -> { publicKey, secretKey }
```

`seqPad` is `String(seq).padStart(13,'0')` so each writer's items prefix-scan in
insert order, matching PearCircle's `trip:{pubkey}:{startTsPadded}` convention.

Apply rules (`applyOps`, the `tripWire.js` analog as `src/listWire.js`):
1. Signature verifies, else reject.
2. The key's `{pubkey}` segment must equal `value.pubkey` (a peer only writes
   its own item rows).
3. Last-writer-wins on `checked` / `text` / `assignee` by `updatedAt`, ties
   broken by lexicographically higher pubkey.
4. Tombstone `{ deleted: true }`. No resurrection: once a key is a tombstone,
   reject all further writes to it.
5. `list:{listId}` rows: any group writer may create or rename a list;
   last-writer-wins by `updatedAt`. Deleting a list tombstones the row (items
   are swept lazily by retention).

The `assignee` field makes this a chore board for free. No separate app.

**Compat**

No existing PearList peers, so no migration. The three shipped apps are
untouched, so their wire protocols and deployed peers are unaffected. The only
new shared surface is `@peerloom/core`, which nothing depends on yet except
PearList.

**Verify**

PearList gets a canonical `npm run verify` matching PearCircle's gate:
`npm test && npm run build:bare && npm run build:bare:ios && npm run build:ui`.
`@peerloom/core` gets its own `npm test` (unit tests on the pure helpers:
`records`, `swarm.topicForKey`, `ids`, and the `listWire` apply decisions,
exercised without standing up a real Autobase, exactly as PearCircle tests
`tripWire.js`). Do not merge red.

**Rollback**

The change is two brand-new directories plus nothing else. Rollback is deleting
`pearlist/` and `peerloom-core/`. No shipped app, no deployed peer, no shared
config is modified, so there is no blast radius beyond the new dirs.

**Open questions**

- Package shape: single `@peerloom/core` with subpath exports, vs split
  packages (`@peerloom/core`, `@peerloom/seeder`, `@peerloom/device-link`).
  Leaning single package with internal folders for v1, split later.
  RESOLVED 2026-07-07: stays a single package with subpath exports; split closed
  (the optional modules it targeted were never built, and the base substrate is
  interdependent). See DECISIONS 2026-07-07. Reopen only when an optional module
  is actually built that an app wants without the engine.
- Whether to bind the Hyperswarm to the identity keypair (PearCircle does) or
  use a default swarm (PearCal does). Leaning PearCircle's bound keypair.
- PearList group model: one household group with many lists (chosen) vs one
  Autobase per list. Many-lists-per-group chosen to match PearCircle's
  one-circle-many-places shape and to keep pairing a once-per-household action.
