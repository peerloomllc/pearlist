# Review - Reused-connection pairing fix (@peerloom/core)

**Date:** 2026-07-01
**Tier:** T3
**Proposal:** proposals/2026-07-01-pairing-reused-connection.md (VALIDATED/SHIPPED)
**Signed off:** Tim (on-device validation)

## What shipped

`@peerloom/core` `feature/pairing-trace-hook`, commit aa83311: a per-connection
Protomux `mux.pair` listener (`setupPairListener` in `src/pairing.js`, wired in
`engine.js` `onConnection`) so a peer lazily opens its matching pair channel when
the remote initiates one for an already-mounted group. This makes writer-admission
pairing order-independent and fixes the case where joining a 2nd+ shared space over
an already-established Hyperswarm connection left the joiner stuck read-only until
an unrelated reconnect.

No wire-format change. The `peerloom/pair/1` hello and the `addWriter` Autobase op
are unchanged; only the timing of when each side opens its local channel changes.

## Verification

- Core gate 38/38, including a new two-peer regression (join a 2nd space over an
  existing connection -> writable, no new connection) that fails pre-fix.
- On-device re-trace (all three devices redeployed): iPhone joined TraceTest2
  (`4-_t6dJN`) over the reused Pixel connection; `pair:remote-open -> onopen ->
  hello-sent -> became-writable` in ~5s, single `peer:connected`, no third-peer
  dependency. Trace via `scripts/pull-pair-trace.sh`.

## Not addressed

Slow first-connection latency (147s, then 112s; foreground; DHT discovery, not
Local Network - LN was granted for the 112s trace). Tracked in TODO.md as its own
investigation.
