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
const { validateMnemonic, attestDeviceKey } = require('@peerloom/device-link/identity')
const b4a = require('b4a')
const { isProfileRecord, profileRecordOf } = require('./profileSync')

// The pair link's own scheme. NOT the invite path: pear://pearlist/join is a
// space invite, safe to forward to anyone, and this is the opposite - a link that
// hands over an identity. Different host so a mis-pasted one of either kind is
// rejected outright rather than half-understood.
const pairLinks = createPairLinks({ scheme: 'pear', host: 'pearlist-device' })
function parsePairLink (url) { return pairLinks.parse(url) }
function buildPairLink (parts) { return pairLinks.build(parts) }

// Diagnostic trace, wired to the same `mark()` the group pair channel uses
// (src/bare.js), so device-link's handshake shows up in logcat and in the
// pullable pair-trace file next to `[pair worklet+Nms]` lines. Without this the
// engine is silent: its events go to onEvent -> ctx.emit, i.e. shell events, and
// a failed pairing leaves nothing to read. That is exactly what stalled the
// 2026-07-28 hardware attempt - the handshake did not complete and there was no
// way to see which leg.
let _trace = () => {}
function setTrace (fn) { if (typeof fn === 'function') _trace = fn }

// REDACTED on purpose. A pair snapshot carries topicHex, handshakeHex and
// identityHex - together they ARE the link, and the link hands over an identity.
// This trace is console.warn'd and written to a file that gets pulled off the
// device, so full values must never reach it. Short prefixes are enough to
// correlate two devices' logs, which is the whole reason to log them.
const short = (v) => (typeof v === 'string' && v.length > 12) ? v.slice(0, 8) + '…' : v
function safeEventData (data) {
  if (!data || typeof data !== 'object') return data
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = /topic|handshake|identity|writerKey|pubkey|key/i.test(k) ? short(v) : v
  }
  return out
}

// OFF by default. Slice 1 ships dark: the engine is constructed and started only
// when this is on, so an ordinary build behaves exactly as it did before. Flip it
// to exercise the engine in a debug build; it does not become a user-facing
// setting until the pairing UI exists (slice 2).
const DEVICE_LINK_ENABLED = false

// Where the mnemonic lives: the SHELL's secure storage (Android Keystore / iOS
// Keychain), never localDb.
//
// Slice 1 followed PearPetal and kept it in localDb, which put a BIP39 seed
// phrase in PLAINTEXT ON DISK. A seed phrase is the whole identity, not a cache
// of it, so that was always a debt rather than a decision - written down at the
// time and paid here, before slice 3 ever shows a phrase to a user.
//
// THE AWKWARD PART, and why this looks indirect: the worklet cannot reach secure
// storage. It is a shell capability, and PearList's IPC only runs shell ->
// worklet - there is no worklet -> shell request path. Rather than invent one
// (a whole RPC direction, for one string), this uses the two directions that
// already exist:
//
//   shell -> worklet   `device:provisionMnemonic` at boot, handing in whatever
//                      secure storage held (or null on a fresh device).
//   worklet -> shell   a `deviceLink:mnemonic` EVENT when device-link mints a new
//                      one, which the shell writes to secure storage.
//
// So the phrase lives in memory here for the life of the worklet and on disk only
// inside the OS keystore. Nothing writes it to localDb.
let _mnemonic = null          // provisioned by the shell, or minted below
let _emitMnemonic = () => {}  // set when the engine ctx is available

function makeKeystore () {
  return {
    hasMnemonic: async () => !!_mnemonic,
    getMnemonic: async () => _mnemonic,
    setMnemonic: async (m) => {
      // device-link minted a fresh phrase. Hold it for this session and hand it
      // to the shell to persist - this is the ONLY path that writes it anywhere.
      _mnemonic = m
      _emitMnemonic(m)
    },
  }
}

// Called by the shell at boot through device:provisionMnemonic. `null` on a
// device that has never had one; device-link mints it on first enable and the
// event carries it back out.
//
// `storeReadable: false` means the shell could not READ secure storage - which is a
// completely different thing from "there is no phrase yet", and must not be treated
// as one. See the comment on loadStoredMnemonic in app/index.tsx.
let _keystoreUnreadable = false
function provisionMnemonic (m, storeReadable = true) {
  _mnemonic = (typeof m === 'string' && m.trim()) ? m.trim() : null
  _keystoreUnreadable = storeReadable === false && !_mnemonic
  return !!_mnemonic
}
function isKeystoreUnreadable () { return _keystoreUnreadable }

// A device that ran the slice-1 build has its phrase sitting in localDb, in
// plaintext. Adopt it, hand it to the shell to put in the keystore, and DELETE
// the row - otherwise fixing where new phrases go would leave the existing ones
// exactly where they should not be. Runs once; a no-op on every device that never
// enabled the flag, which is all of them outside testing.
const LEGACY_MNEMONIC_KEY = 'deviceLink:mnemonic'
async function migrateLegacyMnemonic (ctx) {
  try {
    const row = await ctx.localDb.get(LEGACY_MNEMONIC_KEY).catch(() => null)
    const legacy = row?.value?.mnemonic
    if (typeof legacy !== 'string' || !legacy.trim()) return false
    // VALIDATE before adopting. A corrupt row would otherwise be handed to
    // deriveIdentity, which throws "Invalid mnemonic" - and since this runs
    // inside getDeviceLink, that would take down device:status and everything
    // else with it. A phrase we cannot use is worse than none: drop it and let a
    // fresh one be minted.
    if (!validateMnemonic(legacy.trim())) {
      await ctx.localDb.del(LEGACY_MNEMONIC_KEY).catch(() => {})
      _trace('dl:legacy-mnemonic-invalid-dropped')
      return false
    }
    // The keystore copy wins if the shell already provisioned one; otherwise adopt.
    if (!_mnemonic) _mnemonic = legacy.trim()
    _emitMnemonic(_mnemonic)
    await ctx.localDb.del(LEGACY_MNEMONIC_KEY).catch(() => {})
    _trace('dl:migrated-mnemonic-off-disk')
    return true
  } catch { return false }
}
function hasMnemonicInMemory () { return !!_mnemonic }

// Personal-scope record types the personal base accepts and mirrors locally.
//
// `profile` is the first and, so far, only one: the display name and avatar
// reference belong to the PERSON, not to the phone that last published them - see
// src/profileSync.js and proposals/2026-07-29-profile-belongs-to-the-person.md.
//
// Still NOT here, and deliberately: lists and items belong to a SPACE, not to a
// person, so nothing existing moves. The remaining candidates are the device-local
// things that vanish with a phone - Learned Aisles, custom aisle names, saved
// lists - and moving them is a second migration and a separate decision (TODO).
//
// The linked-device roster does NOT need registering: device-link owns deviceMeta
// and listLinkedDevices natively.
function makeRecords () { return { profile: { validate: isProfileRecord } } }

// Where applied personal-base rows land locally.
//
// INVERTED, rather than requiring listMethods from here: listMethods already
// requires this module, so the handler is REGISTERED into us the way `setTrace`
// is. Applying a profile needs localDb, publishMember and emit, all of which live
// over there.
// The handler takes `ctx` as its first argument rather than reading a stashed one:
// makeMirror is built inside getDeviceLink, where the method ctx is already in
// scope, so the right one is passed in instead of a module-level "last ctx" that
// would be a guess about ordering.
let _profileMirror = null
function setProfileMirror (fn) { if (typeof fn === 'function') _profileMirror = fn }
function makeMirror (ctx) {
  return async (type, key, value) => {
    if (type !== 'profile' || !_profileMirror) return
    // Never let a mirror failure escape into device-link's apply: an unhandled
    // rejection there takes down the WHOLE worklet, and the app then dies on every
    // launch forever (see the guard in src/bare.js and the 2026-07-30 bricking).
    try { await _profileMirror(ctx, value) } catch (e) { _trace('dl:profileMirrorFailed', { err: (e && e.message) || String(e) }) }
  }
}

// Publish this person's profile to their own other devices. False - never a throw -
// when there is no personal base (an unlinked phone, the common case) or this
// device is not a writer on it yet, both of which are ordinary rather than errors.
//
// IT MUST NEVER BE THE THING THAT STARTS DEVICE LINKING. `getDeviceLink` is
// flag-agnostic by design, so calling it constructs and starts the engine whether
// or not the feature is on - and this is called from `member:getAll`, which runs
// on every roster refresh in every build. The first version had neither guard and
// turned linking on for everybody: four tests went red because member rows
// suddenly carried identity proofs and bases were being written mid-test. Caught
// by the suite, which is the only reason it is not in a release.
//
// So: the flag must be on, AND the engine must already have been constructed by
// something that legitimately wanted it. This never initiates, it only joins in.
async function putProfileRecord (ctx, profile) {
  if (!DEVICE_LINK_ENABLED || !isDeviceLinkStarted()) return false
  const record = profileRecordOf(profile)
  if (!record) return false
  try {
    const dl = await getDeviceLink(ctx)
    if (!dl || typeof dl.putRecord !== 'function') return false
    return await dl.putRecord('profile', 'profile', record)
  } catch { return false }
}

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
// Pending per-space writer grants, keyed groupId:writerKey. Deduped, because the
// deviceGroupWriter op is applied on every device and can replay.
const _pendingGrants = new Map()

// Perform a space-side addWriter OUTSIDE the personal base's apply. See the comment
// on grantGroupWriter for why it cannot be done inline.
//
// RETRIED, because the failure it exists for is timing-dependent: the space base may
// be mid-update when the first attempt lands. Backs off, gives up after a handful,
// and TRACES the outcome either way - the original bug was invisible precisely
// because a swallowed rejection looked identical to success.
function scheduleGroupWriterGrant (ctx, groupId, writerKey) {
  const key = groupId + ':' + writerKey
  if (_pendingGrants.has(key)) return
  _pendingGrants.set(key, 0)
  const attempt = async () => {
    const n = (_pendingGrants.get(key) || 0) + 1
    _pendingGrants.set(key, n)
    try {
      await ctx.append(groupId, { type: 'addWriter', pubkey: writerKey })
      _pendingGrants.delete(key)
      _trace('dl:grantGroupWriter', { gid: short(groupId), writer: short(writerKey), attempt: n })
    } catch (e) {
      _trace('dl:grantGroupWriter-failed', { gid: short(groupId), err: e?.message, attempt: n })
      if (n < 5) { const t = setTimeout(attempt, 400 * n); if (t && t.unref) t.unref() } else _pendingGrants.delete(key)
    }
  }
  const t = setTimeout(attempt, 0)
  if (t && t.unref) t.unref()
}

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
      _trace('dl:collectGroups', { spaces: out.length })
      return out
    },

    async seedGroups (groups) {
      _trace('dl:seedGroups', { spaces: (groups || []).length })
      let joined = 0
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
          joined++
        } catch (e) {
          // One bad space must not abort the rest of the fan-out: a device that
          // joins four of five spaces is far better than one that joins none.
          _trace('dl:seedGroups-failed', { gid: short(g.groupId), err: e?.message })
        }
      }
      _trace('dl:seedGroups-done', { joined })
    },

    // NOT AWAITED, AND NOT DONE HERE. This runs inside the PERSONAL base's apply,
    // and the append it needs goes to a DIFFERENT base - the space. Appending to one
    // base from inside another's apply asserts deep in Hyperbee:
    //
    //   ERR_ASSERTION: Invalid checkout 15 for batch, length is 0
    //
    // Caught on the TCL 2026-07-30 mid re-pair. It was swallowed by the .catch, so
    // it degraded to "the space grant silently did not happen" - and it did NOT
    // reproduce on the iPhone minutes earlier, so it is timing-dependent, which
    // makes it worse to rely on rather than better.
    //
    // So the grant is QUEUED and performed on a later turn, from an ordinary
    // context, with retries. The caller gets an immediate return, which is all
    // device-link's apply branch wants.
    grantGroupWriter (groupId, writerKey) {
      if (!groupId || !/^[0-9a-f]{64}$/i.test(String(writerKey || ''))) return
      scheduleGroupWriterGrant(ctx, groupId, String(writerKey))
    },
  }
}

// One engine per worklet, constructed lazily and cached, sharing the group
// engine's runtime via the method ctx. Flag-agnostic on purpose so a test can
// drive it directly without touching the constant.
let _dlPromise = null
// Has something already constructed it? Asked by callers that may only JOIN an
// active device-link session, never start one - see putProfileRecord.
function isDeviceLinkStarted () { return !!_dlPromise }
function getDeviceLink (ctx) {
  // REFUSE TO START WHEN THE KEYSTORE IS UNREADABLE, because starting is what mints.
  //
  // device-link has no "I do not know" state: `hasMnemonic()` returning false means
  // "fresh device", and it responds by minting a new identity. If the phrase is
  // actually sitting in a keystore we merely could not read this boot, that mint
  // REPLACES the person - they lose their place in every space and reappear to the
  // household as a stranger, silently.
  //
  // Refusing means linking is unavailable until the keystore works, and says so.
  // That is strictly better than becoming someone else: an unavailable feature is
  // recoverable on the next boot, a discarded identity is not.
  if (isKeystoreUnreadable()) {
    _trace('dl:keystore-unreadable-refusing-to-start')
    return Promise.reject(new Error('secure storage is unavailable, so device linking is off this session'))
  }
  if (_dlPromise) return _dlPromise
  _dlPromise = (async () => {
    // The shell persists it; see makeKeystore. Wired here because ctx.emit is
    // only available once a method has run.
    _emitMnemonic = (m) => { try { ctx.emit('deviceLink:mnemonic', { mnemonic: m }) } catch {} }
    await migrateLegacyMnemonic(ctx)
    const dl = createDeviceLink({
      store: ctx.store,
      swarm: ctx.swarm,
      localDb: ctx.localDb,
      keystore: makeKeystore(),
      records: makeRecords(),
      mirror: makeMirror(ctx),
      groupPlugin: makeGroupPlugin(ctx),
      platform: '',
      // This device's CORE identity key, recorded on its roster row so "remove this
      // phone" can find that phone in the shared spaces too. The roster is keyed by
      // personal-base writer key and space member rows are keyed by identity pubkey;
      // nothing else joins the two, so without this removal can only ever revoke on
      // the personal base. See proposals/2026-07-29-removing-a-phone-should-remove-it.md.
      //
      // A FUNCTION, not a value: device-link is constructed inside the first method
      // call, and reading ctx.identity eagerly here would capture whatever was ready
      // at that instant. Resolved at write time instead.
      appPubkey: () => {
        try { return ctx.identity?.publicKey ? b4a.toString(ctx.identity.publicKey, 'hex') : null } catch { return null }
      },
      onEvent: (event, data) => {
        _trace('dl:' + event, safeEventData(data))
        try { ctx.emit(event, data) } catch {}
      },
    })
    await dl.start()
    return dl
  })()
  return _dlPromise
}

function _resetForTest () { _dlPromise = null; _attestCache = null; _mnemonic = null; _keystoreUnreadable = false }
// The plugin is otherwise only reachable through device-link's internals; tests
// drive it directly because its three legs are PearList's code, not the engine's.
function _groupPluginForTest (ctx) { return makeGroupPlugin(ctx) }


// Attest this device's GROUP signing key (core's per-device key) with the
// identity behind the recovery phrase, so peers can tell two phones are one
// person. Returns hex, or null when there is no mnemonic yet.
//
// The mnemonic never leaves this module. listMethods.js needs a proof, not a
// phrase, and handing it the phrase so it could derive one itself would put the
// most sensitive value in the app into a second place for no gain.
//
// CACHED AGAINST THE MNEMONIC THAT PRODUCED IT, not merely "computed once". The
// first version memoised the proof in listMethods.js for the life of the worklet,
// reasoning that neither the mnemonic nor the device key changes while running.
// The mnemonic DOES change while running - that is precisely what pairing is. So
// a phone that linked mid-session kept publishing a proof attesting to the
// identity it had BEFORE it became you, and the members list showed two people.
// Caught on hardware 2026-07-29; see TODO.md.
//
// The cache lives here rather than in the caller because this is the only place
// that can see `_mnemonic` change.
let _attestCache = null // { mnemonic, pubkey, proofHex }
async function attestSelf (devicePubkeyHex) {
  if (!_mnemonic || !devicePubkeyHex) return null
  if (_attestCache && _attestCache.mnemonic === _mnemonic && _attestCache.pubkey === devicePubkeyHex) {
    return _attestCache.proofHex
  }
  const proof = await attestDeviceKey(_mnemonic, devicePubkeyHex)
  const proofHex = b4a.toString(proof, 'hex')
  _attestCache = { mnemonic: _mnemonic, pubkey: devicePubkeyHex, proofHex }
  return proofHex
}

module.exports = { setProfileMirror, putProfileRecord, isDeviceLinkStarted, isKeystoreUnreadable, attestSelf, getDeviceLink, DEVICE_LINK_ENABLED, provisionMnemonic, hasMnemonicInMemory, migrateLegacyMnemonic, LEGACY_MNEMONIC_KEY, parsePairLink, buildPairLink, setTrace, _trace: (n, d) => _trace(n, d), _safeEventData: safeEventData, _resetForTest, _groupPluginForTest }
