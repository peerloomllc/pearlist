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
const { defaultEncodeInvite } = require('@peerloom/core/engine')
const { createPairLinks } = require('@peerloom/device-link/pair-link')

// The pair link's own scheme. NOT the invite path: pear://pearlist/join is a
// space invite, safe to forward to anyone, and this is the opposite - a link that
// hands over an identity. Different host so a mis-pasted one of either kind is
// rejected outright rather than half-understood.
const pairLinks = createPairLinks({ scheme: 'pear', host: 'pearlist-device' })
function parsePairLink (url) { return pairLinks.parse(url) }
function buildPairLink (parts) { return pairLinks.build(parts) }

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

// The group plugin: what makes a linked device useful in PearList, and the piece
// PearPetal does NOT have (partner sharing stays on core there, so it injects
// none). Here the spaces ARE the product - a device that links and then cannot
// write to any of them has gained nothing.
//
// Three legs, called by device-link during and after pairing:
//   collectGroups()  primary: which spaces am I in? Carries everything joinGroup
//                    needs, INCLUDING the encryption key and bootstrap. Those are
//                    secrets, and they ride the authenticated pair channel - the
//                    same channel that already carries the mnemonic, so this adds
//                    no new trust assumption.
//   seedGroups(gs)   secondary: join each of them. Idempotent: a space this device
//                    is already in is skipped rather than re-joined.
//   grantGroupWriter primary: admit the new device's per-group writer key, the
//                    same addWriter op the normal pair channel appends.
function makeGroupPlugin (ctx) {
  return {
    async collectGroups () {
      const out = []
      for await (const { value } of ctx.localDb.createReadStream({ gt: 'groups:joined:', lt: 'groups:joined:~' })) {
        if (!value || !value.groupId || !value.groupKey) continue
        out.push({
          groupId: value.groupId,
          groupKey: value.groupKey,
          encryptionKey: value.encryptionKey,
          bootstrap: value.bootstrap,
          name: value.name || '',
        })
      }
      return out
    },

    async seedGroups (groups) {
      for (const g of (groups || [])) {
        if (!g || !g.groupId || !g.groupKey) continue
        // Already in it (the common case for a re-pair): leave it alone. Joining
        // twice would mount a second base for the same space.
        const existing = await ctx.localDb.get('groups:joined:' + g.groupId).catch(() => null)
        if (existing?.value) continue
        try {
          await ctx.joinGroup({
            inviteKey: defaultEncodeInvite({
              groupId: g.groupId,
              groupKey: g.groupKey,
              encryptionKey: g.encryptionKey,
              bootstrap: g.bootstrap,
              name: g.name,
            }),
          })
        } catch {
          // One bad space must not abort the rest of the fan-out: a device that
          // joins four of five spaces is far better than one that joins none.
        }
      }
    },

    async grantGroupWriter (groupId, writerKey) {
      if (!groupId || !/^[0-9a-f]{64}$/i.test(String(writerKey || ''))) return
      // Exactly what the group pair channel appends when it admits a joiner; the
      // apply branch is shared, so nothing new has to understand this op.
      await ctx.append(groupId, { type: 'addWriter', pubkey: String(writerKey) }).catch(() => {})
    },
  }
}

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
      groupPlugin: makeGroupPlugin(ctx),
      platform: '',
      onEvent: (event, data) => { try { ctx.emit(event, data) } catch {} },
    })
    await dl.start()
    return dl
  })()
  return _dlPromise
}

function _resetForTest () { _dlPromise = null }
// The plugin is otherwise only reachable through device-link's internals; tests
// drive it directly because its three legs are PearList's code, not the engine's.
function _groupPluginForTest (ctx) { return makeGroupPlugin(ctx) }

module.exports = { getDeviceLink, DEVICE_LINK_ENABLED, MNEMONIC_KEY, parsePairLink, buildPairLink, _resetForTest, _groupPluginForTest }
