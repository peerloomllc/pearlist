// The PeerLoom blind relay - the off-LAN backstop when two phones cannot
// hole-punch each other. Adopted from PearTune, which built and deployed the
// relay node: see ../peartune/proposals/2026-07-23-blind-relay.md and this
// repo's proposals/2026-07-23-blind-relay-adoption.md.
//
// PearList is phone-to-phone, so BOTH ends can sit behind a carrier CGNAT - the
// hardest punch case there is, and one no retry budget rescues. The relay is a
// public node both ends can reach outbound; it forwards the still-Noise-encrypted
// UDX stream, so it carries ciphertext plus metadata (which two keys talk, how
// many bytes) and never a readable list. Transient encrypted transit, not storage.
//
// Nothing above the socket changes. Hyperswarm hands back the same stream and the
// same authenticated remotePublicKey a direct dial does, so Autobase replication,
// pairing and revocation are untouched. Only socket acquisition changes, and only
// on the fail path.

const z32 = require('z32')

// The deployed PeerLoom relay's public key (2026-07-23), shared suite-wide - a
// blind byte-forwarder cares nothing about which app is talking. Its private seed
// lives only on the relay box. Null here would mean "no relay configured", which
// the policy below treats as a hard off.
const RELAY_PUBLIC_KEY_Z = 'qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy'

const RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY_Z ? z32.decode(RELAY_PUBLIC_KEY_Z) : null

// localDb key holding the user's toggle. Device-local, never synced.
const PREF_KEY = 'relay'

// The direct-first relay policy - the decision Hyperswarm asks us to make on every
// outbound connect (it accepts `relayThrough` as a key or a `(force, swarm) => key|null`).
// Returns the relay key to route through, or null for a direct-only attempt.
//
//   force      - Hyperswarm sets forceRelaying=true on this peer after a
//                HOLEPUNCH_ABORTED / HOLEPUNCH_DOUBLE_RANDOMIZED_NATS /
//                REMOTE_NOT_HOLEPUNCHABLE. This is what makes us direct-FIRST:
//                null on the normal attempt, the key only after a punch failed.
//   randomized - our own NAT is double-randomized, i.e. a direct punch can never
//                land; relay from the first attempt (Hyperswarm's own default gate
//                is exactly `force || swarm.dht.randomized`).
//   useRelay   - the user's privacy toggle (Settings -> Connection, default on).
//                Off means pure device-to-device: never touch PeerLoom's relay, and
//                accept that an unpunchable network simply will not sync.
//   relayKey   - the baked relay key, or null when no relay is configured.
//
// Order matters: the toggle and the "is a relay even configured" check gate first,
// so a user who opted out never relays regardless of what the NAT is doing.
function relayThroughFor ({ force, randomized, useRelay, relayKey }) {
  if (!useRelay || !relayKey) return null
  return (force || randomized) ? relayKey : null
}

// The toggle, cached in memory because Hyperswarm calls the policy SYNCHRONOUSLY
// per dial and the stored value lives in an async Hyperbee. `hydrated` is the
// "do we know the user's choice yet" gate: until the read lands we relay nothing,
// so a device whose owner opted out can never leak a dial through the relay in the
// window between swarm construction and the read completing.
const prefs = { useRelay: true, hydrated: false }

function setUseRelay (on) {
  prefs.useRelay = on !== false
  prefs.hydrated = true
  return prefs.useRelay
}

function getUseRelay () { return prefs.useRelay }
function isHydrated () { return prefs.hydrated }

// Load the persisted toggle into the cache. Called once at swarm construction,
// which the engine does right after localDb is ready. A read failure must NOT
// silently disable the backstop, so it falls back to the default (on).
async function hydrate (localDb) {
  try {
    const row = await localDb.get(PREF_KEY)
    return setUseRelay(row?.value?.useRelay !== false)
  } catch {
    return setUseRelay(true)
  }
}

// The function handed to Hyperswarm as `relayThrough`. Reading the cache here,
// rather than baking a static key, is what lets the toggle apply live: the next
// dial after the user flips it already follows the new choice, with no reconnect.
function swarmRelayThrough (force, swarm) {
  if (!prefs.hydrated) return null
  return relayThroughFor({
    force,
    randomized: !!(swarm && swarm.dht && swarm.dht.randomized),
    useRelay: prefs.useRelay,
    relayKey: RELAY_PUBLIC_KEY,
  })
}

// Test-only: drop back to the pre-hydration state.
function _reset () { prefs.useRelay = true; prefs.hydrated = false }

module.exports = {
  RELAY_PUBLIC_KEY,
  RELAY_PUBLIC_KEY_Z,
  PREF_KEY,
  relayThroughFor,
  swarmRelayThrough,
  hydrate,
  setUseRelay,
  getUseRelay,
  isHydrated,
  _reset,
}
