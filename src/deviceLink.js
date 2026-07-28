// SLICE 1 of proposals/2026-07-28-device-linking.md: construct @peerloom/device-link
// beside the group engine, DARK. Nothing here is reachable from the UI yet - the
// only method exposed is a diagnostic (`device:status`), and the whole thing is
// gated off by default.
//
// device-link is the suite's multi-device layer, extracted from PearCal and
// already adopted by PearPetal (pearpetal/proposals/2026-07-12-adopt-device-link.md).
// It owns the mnemonic identity, a personal Autobase shared across ONE person's
// devices, and the pairing handshake. It shares this worklet's runtime - the same
// Corestore, Hyperswarm and localDb the group engine uses - and namespaces its own
// base, so the two engines coexist without either owning the other.
//
// WHAT THIS SLICE DELIBERATELY DOES NOT DO. It does not change how a single row is
// signed. PearList's spaces are core groups signed by core's per-device keypair,
// and that is untouched: this is the "coexist" shape PearPetal decided on
// (2026-07-12 decision 2). Which means - stated plainly because it is easy to
// assume otherwise - after this slice two of your phones are STILL two members of
// a space, and a reinstall is STILL a new person. Only the mnemonic-root slice
// changes that, and it is deliberately last.

const { createDeviceLink } = require('@peerloom/device-link/personal')

// OFF by default. Slice 1 ships dark: the engine is constructed and started only
// when this is on, so an ordinary build behaves exactly as it did before. Flip it
// to exercise the engine in a debug build; it does not become a user-facing
// setting until the pairing UI exists (slice 2).
const DEVICE_LINK_ENABLED = false

// Where the mnemonic lives, and the one judgement call in this slice.
//
// PearPetal keeps it in localDb, and this follows that for now so the suite does
// not grow two answers before either is proven. But localDb is a Hyperbee in the
// app's Corestore - a BIP39 seed phrase sits there in PLAINTEXT ON DISK, and a
// seed phrase is the whole identity, not a cache of it. The Android Keystore /
// iOS Keychain is where this belongs.
//
// Why not fix it here: the worklet cannot reach secure storage. It is a shell
// capability, and PearList's IPC only runs shell -> worklet; there is no
// worklet -> shell request path to build on (PearCal has one, `nativeRequest`).
// Adding that direction is real plumbing and does not belong in a slice whose job
// is "does the engine start".
//
// Why it is safe to defer: nothing generates a mnemonic unless the flag is on,
// and no user is ever SHOWN a phrase until slice 3. The hardening has to land
// before that slice, not before this one. Tracked in TODO.
const MNEMONIC_KEY = 'deviceLink:mnemonic'
function makeKeystore (localDb) {
  return {
    hasMnemonic: async () => !!((await localDb.get(MNEMONIC_KEY).catch(() => null))?.value?.mnemonic),
    getMnemonic: async () => (await localDb.get(MNEMONIC_KEY).catch(() => null))?.value?.mnemonic ?? null,
    setMnemonic: async (m) => { await localDb.put(MNEMONIC_KEY, { mnemonic: m, createdAt: Date.now() }) },
  }
}

// Personal-scope record types the personal base accepts and mirrors locally.
// EMPTY on purpose: PearList has no personal-scope data today. Lists and items
// belong to a SPACE (a shared group), not to a person, so nothing existing moves
// here. The obvious future candidates are the device-local things that used to
// vanish with a phone - Learned Aisles, custom aisle names, saved lists - but
// moving them is a second migration and a separate decision (TODO).
//
// The linked-device roster does NOT need registering: device-link owns deviceMeta
// and listLinkedDevices natively.
function makeRecords () { return {} }

// Where applied personal-base rows land locally. A no-op while `records` is
// empty, and the seam to fill when personal-scope data arrives.
function makeMirror () { return async () => {} }

// One engine per worklet, constructed lazily and cached, sharing the group
// engine's runtime via the method ctx. Flag-agnostic on purpose so a test can
// drive it directly without touching the constant.
let _dlPromise = null
function getDeviceLink (ctx) {
  if (_dlPromise) return _dlPromise
  _dlPromise = (async () => {
    const dl = createDeviceLink({
      store: ctx.store,
      swarm: ctx.swarm,
      localDb: ctx.localDb,
      keystore: makeKeystore(ctx.localDb),
      records: makeRecords(),
      mirror: makeMirror(),
      platform: '',
      onEvent: (event, data) => { try { ctx.emit(event, data) } catch {} },
    })
    await dl.start()
    return dl
  })()
  return _dlPromise
}

function _resetForTest () { _dlPromise = null }

module.exports = { getDeviceLink, DEVICE_LINK_ENABLED, MNEMONIC_KEY, _resetForTest }
