# 2026-07-01 - Reliable pair-channel establishment on reused connections (@peerloom/core)

**Status:** IMPLEMENTED (core) - pending multi-platform redeploy + on-device
re-trace. peerloom-core `feature/pairing-trace-hook`: trace hook e421046, fix
aa83311. The `mux.pair` lazy-open (design item 1) landed and a two-peer
regression that fails pre-fix now passes (full gate 38/38). Design item 2
(per-(conn,group) tracking + re-open-on-close) was deliberately NOT implemented:
`createChannel({ unique: true })` already prevents duplicate channels, and the
listener re-pairs on any later mount/reconnect, so the reproduced bug is fully
resolved without it. Revisit only if a spurious mid-session channel close (paired
then dropped while still non-writable) shows up in a trace.

**Goal**

Make writer admission work the first time a device joins any space, including a
2nd+ space shared with a peer it is already connected to. Today the joiner is
reliably admitted only when a *fresh* Hyperswarm connection forms, so joining a
second shared space leaves the device stuck read-only (edits revert, it never
appears in the member roster) until an unrelated reconnect happens. Land the fix
in `@peerloom/core` so every app benefits.

**Tier**

T3. Touches the shared engine's writer-admission pairing - the mechanism that
turns a joiner into an Autobase writer. A correctness bug here means peers that
can never write. Full verify gate + this proposal + a two-peer test + a
three-peer test + an on-device re-trace.

---

## Problem

Confirmed on-device 2026-07-01 with the new pairing trace (peerloom-core commit
e421046, pearlist commit b4dad69; pull with `scripts/pull-pair-trace.sh`). The
iPhone joined a new space "TraceTest" (`aoGplCDQ`) while already connected to the
Pixel from earlier spaces. Trace excerpt (ms from worklet boot):

```
+146965  peer:connected {pk:673a5107, bases:2, conns:1}      # Pixel connection
+146976  pair:onopen 3LDFrofZ / mZYjf-_O  (existing spaces)  # these paired fine
+161867  group:mounted aoGplCDQ {conns:1}  + pair:channel-opened
+161871  group:join    aoGplCDQ {writable:false}
+161969  pair:onclose  aoGplCDQ            # <-- opened, NEVER got onopen, died ~100ms later
   ...    (silent for 2.5 min - no hello, retry timer stopped on close)
+323966  peer:connected {pk:49939746, bases:3, conns:2}      # TCL joins = NEW connection
+323975  pair:onopen   aoGplCDQ {writable:false}             # now it pairs
+323976  pair:hello-sent aoGplCDQ                            # hello finally goes out
+328979  pair:became-writable aoGplCDQ                       # admitted ~5s later
```

The pair channel the joiner opened for the new space over the **existing** Pixel
connection got **no `pair:onopen`** (the two sides never matched) and closed
~100ms later. `core/pairing.js` `onclose` then stops the hello-retry timer, so
the joiner went **silent** for that group. Admission only completed at +324s when
a **third peer (the TCL) connected** - a fresh connection fires `onConnection`,
which opens pair channels for *all* mounted groups on both ends at once, so they
finally pair. This is exactly why "the iPhone showed joined a second or two after
the TCL joined."

Reads work throughout because `onConnection` calls `store.replicate(conn)` for
**all** cores, independent of the pair channel - so the joiner replicates the
space but cannot write it. `member:publish` is gated on `base.writable`
(`pearlist/src/listMethods.js:119`), so the joiner is also absent from the roster
until it flips writable.

---

## Findings (Protomux + current flow)

1. **Pairing relies on both ends opening the same channel in the same window.**
   `setupPairChannel` does `Protomux.from(conn).createChannel({ protocol, id:
   groupId })` then `channel.open()`. A channel gets `onopen` only when the remote
   has *also* created+opened a channel for the same `(protocol, id)`. There is no
   handler for an **incoming** open of an unknown channel, so an open that arrives
   before the local side has created its matching channel is dropped/closed.

2. **Channels are only opened at two moments** (`engine.js`): `onConnection` (for
   every mounted group) and `mountBase`/`createGroup` (for every active conn).
   Hyperswarm keeps **one connection per peer** shared across all space topics, and
   `onConnection` does **not** re-fire for an already-connected peer. So when a
   group is mounted after the connection to that peer already exists, only the
   mounting side opens a channel; the other side has no trigger to open its side.

3. **`onclose` stops the hello retry.** Once the unpaired channel closes, the
   joiner sends no further hellos for that group until a brand-new connection
   rebuilds channels on both ends. Hence the multi-minute stall and the
   "heals only on a fresh connection / a new peer" behavior.

4. **No wire-format dependency.** The `peerloom/pair/1` message (a single
   `{ writerKey }` hello) and the `addWriter` Autobase op are unchanged by this
   fix. Only the *orchestration of when each side opens its local channel* changes.
   Protomux `mux.pair` is a transport-level affordance, not a protocol change.

---

## Design

Two changes in `@peerloom/core`, both additive:

**1. Lazy, order-independent channel opening (the fix).** Register a Protomux
pairing handler once per connection so an **incoming** pair-channel open for a
group we have mounted makes us open our matching side:

```
// per connection, in onConnection (Protomux.from(conn) is idempotent):
mux.pair({ protocol: PAIR_PROTOCOL }, (id) => {
  const groupId = b4a.toString(id)
  if (bases.has(groupId)) openPairChannel(conn, groupId, bases.get(groupId))
})
```

Now whoever opens first (the joiner mounting a new space, or the founder creating
one) triggers the other end to open its channel, so they pair regardless of order
or of connection reuse. This lives behind a small helper in `pairing.js`
(`setupPairListener`) so `engine.js` stays declarative.

**2. Per-(conn, group) channel tracking + close-resilience (hardening).** Track
open pair channels per `(conn, groupId)` (mirrors the donor's
`_memberAdmissionChannels`) so the explicit open and the lazy handler cannot
create duplicate channels. On `onclose`, if the base is still non-writable, we are
still a member, and the connection is still alive, re-open the channel after a
short bounded backoff instead of going silent. This closes the residual race where
our channel opened and died microseconds before the remote's handler opened.

The 5s hello retry is unchanged once a channel is paired.

---

## Alternatives considered

- **Re-open on close with backoff, no `mux.pair`.** Insufficient alone: if the
  remote never has a matching channel, re-opening from one side still never pairs.
  Kept only as the hardening layer on top of `mux.pair`.
- **One pair channel per connection, group ids multiplexed inside messages.**
  Removes per-group channels entirely but is a larger refactor and a wire change.
  Deferred; `mux.pair` fixes the bug with no protocol change.
- **Force a fresh connection when mounting a new group (drop + reconnect).** Hacky,
  disrupts the other spaces sharing that connection, and races. Rejected.

---

## Test plan (T3 gate)

1. **Unit (peerloom-core, brittle):** two engines over a connected in-memory
   duplex-stream pair (no real network). Create group1 on A, connect, B joins
   group1 (baseline). Then create group2 on A and have B join group2 **over the
   same connection** - assert B's group2 base flips `writable` within a bounded
   time **without** any new connection. This is the regression guard; it fails on
   today's code and passes with the fix.
2. **Two-peer integration (real swarm, two processes/devices):** A creates space1,
   B joins (fresh connection - works today). Then A creates space2 and B joins
   space2 over the **existing** connection - assert B is admitted within seconds
   and can write, reproducing the exact field failure end to end.
3. **Three-peer:** A + B + C; assert no duplicate channels / channel storms and
   that a third peer joining does not disturb existing pairings.
4. **On-device re-trace:** repeat the iPhone TraceTest scenario and pull the
   trace - expect `pair:onopen` -> `pair:hello-sent` -> `pair:became-writable`
   within seconds of the join, with **no** dependence on a third peer connecting.
5. **Full `npm run verify`** green in both repos. No merge red (Constitution §5).

---

## Rollout / consequences

- **Both ends must run the fix.** Order-independent pairing requires the
  `mux.pair` handler on the side that needs to lazily open. A fixed joiner talking
  to an un-fixed host (or vice versa) can still stall. So PearList must redeploy
  **all** platforms - iPhone (iOS) and the Pixel + TCL (Android) - not just the
  device under test. Note the mixed-version caveat in the release.
- **No wire-format change**, so this is interoperable at the message level and
  safe to ship incrementally per platform; only the local channel-open timing
  changes.
- **Cost:** modest per-(conn, group) bookkeeping and occasional channel re-open on
  close. Bounded; no per-op work.
- Fixes multi-space writer admission (the core reason a joiner appeared stuck
  read-only) and removes the "heals only when another peer connects" behavior.
- Does **not** address the separate ~147s first-connection latency seen in the
  same trace (foreground, so not background suspend; unconfirmed, possibly iOS
  Local Network permission / DHT cold-start). Tracked separately in TODO.md.
