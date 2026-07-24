# Adopting the PeerLoom blind relay - off-LAN sync for two phones that cannot punch

## Goal

Make two PearList phones sync **even when the hole-punch never lands**. When both ends sit
behind a carrier CGNAT or a symmetric NAT, the direct punch can be a flat 0%, and no retry
budget rescues it: the space simply never syncs off-LAN. Route those sessions through the
**PeerLoom blind relay** - one public node both ends can reach outbound, forwarding the
still-Noise-encrypted UDX stream.

## Tier

**T2.** No wire-protocol, pairing or data-model change; only how a socket is acquired, and
only on the fail path. The T3 work - designing the relay, standing up the node, the abuse
and metadata posture - was done and shipped by PearTune
(`../peartune/proposals/2026-07-23-blind-relay.md`, peartune DECISIONS 2026-07-23). This
proposal is the adoption record, and the relay node itself is unchanged and app-agnostic.

## Why PearList needs it more than PearTune does

PearTune is phone-to-host: one end is a box on a home LAN with a comparatively friendly NAT.
**PearList is phone-to-phone.** Both ends can be mobile, which is the hardest punch case there
is, and there is **no blind seeder for PearList** - nothing always-on sits in the middle to
bridge two phones that cannot reach each other. Verified 2026-07-23: no seeder exists in this
repo and core does not ship one (DECISIONS 2026-07-01 lists blind-seeder as a deliberately
un-ported, later module). So today, two members on bad cell networks have no path at all.

## Verified against the source before writing any code

- **Transport is Hyperswarm**, built in `@peerloom/core` `src/engine.js:330`, from the app's
  optional `createSwarm` seam if one is supplied.
- **hyperswarm 4.17.0** takes `relayThrough` (as a key or a `(force, swarm) => key|null`
  function), stores it, and passes `_maybeRelayConnection(peerInfo.forceRelaying)` into
  `dht.connect`. On a connect error it sets `forceRelaying = true` for exactly
  `HOLEPUNCH_ABORTED`, `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` and `REMOTE_NOT_HOLEPUNCHABLE`.
  So **direct-first, escalate-on-abort is already implemented upstream**; we supply a policy,
  not a mechanism.
- **hyperdht 6.32.0** honours a relay the *remote* asked for on both sides: `connect.js:518`
  (`payload.relayThrough || c.relayThrough`) and `server.js:401`. Peer A escalating is enough;
  peer B needs no configuration and no redeploy.
- **`blind-relay` is already in the tree** as a hyperdht dependency. Nothing to install.
- Hyperswarm passes the same policy function to its own `dht.createServer`, called with no
  `force`, so our accept side relays only when *our* NAT is double-randomized. It never
  blanket-relays.

## The change

Four small pieces, all in this repo (core is untouched - PearList supplies `createSwarm`):

1. **`src/relay.js`** - the baked relay public key plus `relayThroughFor`, the pure
   direct-first policy: `useRelay && relayKey && (force || randomized)`. Same key and same
   policy shape as PearTune, so the suite behaves identically.
2. **`src/bare.js`** - `createSwarm` builds the Hyperswarm with
   `relayThrough: relay.swarmRelayThrough`. A **function**, not a static key, so the toggle
   and the key are read live on each dial.
3. **`relay:get` / `relay:set`** in `src/listMethods.js`, persisting to `localDb` under
   `relay`. Device-local, never synced.
4. **Settings -> Connection -> "Connect Anywhere"**, default on, with an explainer that says
   plainly what the relay does and does not see.

**The hydration gate.** Hyperswarm calls the policy synchronously, but the stored toggle lives
in an async Hyperbee, so the value is cached in memory. Until that read lands the policy relays
**nothing** - a user who opted out cannot leak a dial through the relay in the startup window.
A failed read falls back to on, so a database hiccup cannot silently disable the backstop.

## What stays identical

Everything above the socket. A relayed connection hands back the same UDX stream and the same
Noise-authenticated `remotePublicKey`, so Autobase replication, the pairing channel, writer
admission and revocation are unchanged.

**Correction, checked against the version we ship (2026-07-23).** PearTune's proposal cites
`confirmDirectUpgrade` in `hyperdht/lib/relay-connection.js`, which tears the relay down if a
direct path later appears. **That file does not exist in hyperdht 6.32.0**, the version PearList
resolves (both directly and through hyperswarm); it arrives in 6.33. So here a relayed session
**stays relayed for its lifetime** - it does not silently upgrade itself when the network improves.
That is a performance ceiling, not a correctness problem: the connection works, and the next
reconnect tries direct first as always. Bumping hyperdht is tracked in TODO.md.

## Privacy posture, stated honestly

The relay carries ciphertext. It cannot read a list, and it holds nothing. It **does** see which
two device keys are talking and how many bytes passed. That is the standard relay disclosure and
the reason the toggle exists and the reason the explainer states it rather than implying
zero-knowledge.

## Rollback

Remove `relayThrough` from `createSwarm` and the app stops relaying. If the relay node goes down,
nothing routes through it and behaviour degrades exactly to today's: unpunchable pairs stay
unsynced, everyone else unaffected. No wire or data change to unwind.

## Verify

- `npm run verify` green (unit tests cover the policy matrix, the hydration gate, the
  read-failure fallback and the live toggle).
- **Hardware gate:** two phones on mobile data off any shared LAN. Success = an edit on one
  reaches the other when the direct punch never lands, and with the toggle OFF the same pair
  does not sync. Confirm a same-LAN pair still connects directly (the relay must not be in the
  path when a punch works).
