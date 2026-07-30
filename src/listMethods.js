// PearList IPC method table. Each handler is (args, ctx) where ctx is the
// engine's method context: { identity, append, bases, emit, ... }. Handlers
// sign their writes with the device identity and append { type:'put', ... } ops;
// the engine's applyOps (applyListOp) does the merge. Reads pull from the
// linearized Hyperbee view.

const { signValue } = require('@peerloom/core/records')
const { newEntityId } = require('@peerloom/core/ids')
const { defaultEncodeInvite } = require('@peerloom/core/engine')
const b4a = require('b4a')
const sodium = require('sodium-universal')

const { listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange, normalizeKind, normalizeNotifyMode, isMemberVisible, REVOKE_CAP, REVOKE_SELF_CAP, allMembersSupportRevoke, allMembersSupportSelfRevoke, isDigestCountable, sortDigestLists, digestText, isReminderPending, MAX_SCHEDULED_REMINDERS, normalizeRepeat, effectiveChecked, nextDueAt, reminderTargetOf } = require('./listWire')
const { classifyAisle, normalizeAisle, sanitizeCustomAisle } = require('./aisles')
const { planNoteSave } = require('./noteText')
const { buildBackup, parseBackup, backupFilename } = require('./spaceBackup')
const relay = require('./relay')
const { collapseMembers, sameIdentityKeys, identityRootOf } = require('./memberIdentity')
const { getDeviceLink, DEVICE_LINK_ENABLED, parsePairLink, buildPairLink, provisionMnemonic, attestSelf, _trace: _dlTrace } = require('./deviceLink')

// Offline keyword aisle classifier for the worklet-side ai:categorize methods.
// `classifyItem` is the single seam a smarter classifier would swap into; the RN
// shell can also compute a category out-of-band (its Learned Aisles overrides)
// and persist it via ai:setCategory below, so both paths write the same signed,
// synced `category` field.
async function classifyItem (_ctx, text) {
  return classifyAisle(text)
}

// Grace before the owner tears down a just-deleted space, so the `space`
// tombstone can replicate to connected members first.
const SPACE_DELETE_GRACE_MS = 5000

// --- avatars: stored in the content blob store, not inline in member rows -----
// A member row carries a tiny { avatarBlob:{key,id}, avatarHash, avatarType }
// reference instead of a multi-MB data URL, so the append-only log stays small
// and avatars are not re-appended on every name change. Resolved back to a data
// URL for the UI, cached by content hash so a poll does not refetch. Legacy rows
// with an inline `avatar` data URL are still honored.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const avatarCache = new Map()   // contentHash -> data URL
const avatarPending = new Set()  // contentHash currently being fetched

function blobHash (buf) { const out = b4a.alloc(32); sodium.crypto_generichash(out, buf); return b4a.toString(out, 'hex') }
function parseDataUrl (s) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(s))
  if (!m) return null
  return { mime: m[1] || 'application/octet-stream', base64: !!m[2], data: m[3] }
}
async function resolveAvatarAwait (ctx, row) {
  if (row?.avatar) return row.avatar // legacy inline data URL
  if (row?.avatarBlob && row?.avatarHash) {
    if (avatarCache.has(row.avatarHash)) return avatarCache.get(row.avatarHash)
    const bytes = await ctx.blobs.get(row.avatarBlob)
    if (!bytes) return null
    const url = `data:${row.avatarType || 'image/png'};base64,${b4a.toString(bytes, 'base64')}`
    avatarCache.set(row.avatarHash, url)
    return url
  }
  return null
}
// Non-blocking: returns the cached data URL or null, kicking off a background
// fetch so a remote avatar "pops in" on the next poll instead of stalling this one.
function resolveAvatarCached (ctx, row) {
  if (row?.avatar) return row.avatar
  if (row?.avatarBlob && row?.avatarHash) {
    if (avatarCache.has(row.avatarHash)) return avatarCache.get(row.avatarHash)
    if (!avatarPending.has(row.avatarHash)) {
      avatarPending.add(row.avatarHash)
      resolveAvatarAwait(ctx, row).catch(() => {}).finally(() => avatarPending.delete(row.avatarHash))
    }
    return null
  }
  return null
}

function pubkeyHex (ctx) { return b4a.toString(ctx.identity.publicKey, 'hex') }

// Sanitize a user-entered product link to a safe http(s) URL (or '' to clear).
// A bare domain like "kroger.com/p/123" is upgraded to https://. Anything that
// is not a plausible web link (javascript:, data:, etc.) is dropped.
function cleanUrl (u) {
  if (typeof u !== 'string') return ''
  const s = u.trim()
  if (!s) return ''
  if (/^https?:\/\/\S+$/i.test(s)) return s.slice(0, 2000)
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return ('https://' + s).slice(0, 2000)
  return ''
}

// The founder is the Autobase bootstrap writer: their own local writer core IS
// the base key. A joiner mounts with the founder's bootstrap, so their local key
// always differs. Used only to migrate legacy spaces (no signed `space` record);
// new spaces claim ownership explicitly at creation via space:init.
function isFounder (base) {
  try { return !!base.local && b4a.equals(base.local.key, base.key) } catch { return false }
}

// --- item suggestions (device-local, private) --------------------------------
// A small recents tally of item texts this device has added, used to suggest
// re-adds (groceries repeat). Kept in localDb, NOT synced, and independent of
// item history retention - so purging old items never weakens suggestions.
const RECENTS_CAP = 200
function recentScore (x, now) {
  const ageDays = (now - (x.lastAt || 0)) / 86400000
  return (x.count || 1) * Math.pow(0.5, ageDays / 30) // frequency, 30-day recency half-life
}
const recentMatches = (norm, p) => norm.startsWith(p) || norm.split(/\s+/).some((w) => w.startsWith(p))
// Saved list templates, device-local (see the template:* methods below).
const TEMPLATES_KEY = 'listTemplates'
const TEMPLATES_CAP = 30       // templates kept, newest first
const TEMPLATE_ITEMS_CAP = 200 // entries snapshotted from one list

async function readTemplates (ctx) {
  const doc = (await ctx.localDb.get(TEMPLATES_KEY))?.value
  return Array.isArray(doc?.templates) ? doc.templates : []
}

async function writeTemplates (ctx, templates) {
  await ctx.localDb.put(TEMPLATES_KEY, { templates })
}

async function recordRecent (ctx, text) {
  const t = String(text || '').trim(); if (!t) return
  const norm = t.toLowerCase()
  const doc = (await ctx.localDb.get('itemRecents'))?.value || { items: [] }
  const items = doc.items
  const now = Date.now()
  const ex = items.find((x) => x.norm === norm)
  if (ex) { ex.count = (ex.count || 1) + 1; ex.lastAt = now; ex.text = t }
  else items.push({ norm, text: t, count: 1, lastAt: now })
  items.sort((a, b) => recentScore(b, now) - recentScore(a, now))
  if (items.length > RECENTS_CAP) items.length = RECENTS_CAP
  await ctx.localDb.put('itemRecents', { items })
}

// Publish this device's profile as its member:{pubkey} roster row to every group
// it can write to, so peers can resolve assignee pubkeys to a name + avatar.
// This device's attestation proof, hex, or null if it has no mnemonic to derive
// one from (i.e. device-link is off, or on but never linked).
//
// NOT memoised here. `attestSelf` caches against the mnemonic that produced the
// proof, which is the only cache that stays correct across a pairing - see the
// comment there. A second memo at this level would reintroduce exactly the bug
// that comment describes, because this module cannot see the mnemonic change.
async function deviceIdentityProof (ctx) {
  try {
    const hex = await attestSelf(pubkeyHex(ctx))
    _dlTrace('dl:attest', { got: !!hex })
    return hex || null
  } catch {
    // Never fatal. A member row without a proof is the pre-existing behaviour,
    // and publishing the row matters far more than proving who owns it.
    return null
  }
}


// Republish our member row for ONE space when the proof on it is not the one this
// device would publish today - either because there is none, or because it is the
// WRONG one.
//
// WHY THIS HANGS OFF member:getAll RATHER THAN BOOT. publishMember does not run
// on launch for a row that already exists - only on a profile change or a first
// join - so a device that was already a member before this feature existed would
// never publish a proof, and the collapse would never happen for anyone already
// in a space. Which is everyone.
//
// WHY THE ONCE-PER-SESSION GUARD, which is the whole point of this function's
// shape. The first version re-checked the stored row each time and republished if
// it still lacked a proof. An append is not visible in `base.view` until apply
// catches up, and member:getAll runs on a refresh interval - so it republished
// every ~2.5s, forever. Measured on hardware 2026-07-29 before it was caught:
// eight appends in twenty seconds and still going. A self-healing check that
// re-fires on stale state is a write-amplification bug, not a fix.
//
// Trying once per session is sufficient: if the append lands, later sessions see
// the proof and skip. If it does not, the next launch tries again.
//
// WHY THE GUARD IS KEYED ON THE PROOF WE OBSERVED, not on the space alone. The
// first version skipped whenever ANY proof was present, which made a WRONG proof
// permanent: a phone that paired mid-session had already published one under its
// previous identity, so "a proof exists" read as "done" forever and the members
// list showed one person as two. Not even a restart cleared it. Keying on the
// observed proof gives exactly one attempt per distinct state - so a proof that
// changes underneath us (pairing, or our own correction landing) is re-checked
// once and then settles, while the every-2.5s amplification stays fixed.
const _proofBackfilled = new Set()
function backfillIdentityProof (ctx, groupId, publishedProof) {
  // Set synchronously, before any await: member:getAll runs on a refresh
  // interval and two overlapping passes must not both decide to publish.
  const seen = groupId + ':' + (publishedProof || '')
  if (_proofBackfilled.has(seen)) return
  _proofBackfilled.add(seen)
  deviceIdentityProof(ctx).then(async (proof) => {
    if (!proof) return
    if (publishedProof) {
      // Compare IDENTITY ROOTS, not proof bytes. Two proofs for the same person
      // need not be byte-identical, and it is the root that decides whether the
      // collapse will treat this row as us.
      const [mineRoot, publishedRoot] = await Promise.all([
        identityRootOf(proof), identityRootOf(publishedProof),
      ])
      if (mineRoot && publishedRoot && mineRoot === publishedRoot) return
    }
    return publishMember(ctx, groupId)
  }).catch(() => {})
}

// STOPGAP, and labelled as one. A phone you just linked should already be you -
// same name, same picture - because that is what "this is my other phone" means.
// The real fix is to store the profile on the PERSON, in device-link's personal
// base: see proposals/2026-07-29-profile-belongs-to-the-person.md, which rejects
// this copy as a *fix* precisely because it does not keep the two in step
// afterwards. It is here because Tim decided linking ships FIRST (2026-07-29), and
// without it every freshly paired phone keeps its own default name and the
// household sees the wrong one - turning a rare annoyance into the common case.
//
// WHAT MAKES IT SAFE TO COPY: we only ever adopt from a member row that PROVES the
// same identity root as ours, which is the same verified check the collapse uses.
// A row that merely claims a name is never a source. So the worst case is that we
// adopt nothing.
//
// ONLY OVER AN UNTOUCHED PROFILE. If this device has a real name of its own, the
// user chose it and we must not overwrite it - that is the ambiguous case the
// proposal says to ask about, and asking is not this stopgap's job.
const DEFAULT_DISPLAY_NAME = 'Member'
function isUntouchedProfile (prof) {
  if (!prof) return true
  const n = String(prof.displayName || '').trim()
  if (n && n !== DEFAULT_DISPLAY_NAME) return false
  return !prof.avatarBlob && !prof.avatar
}

// Guarded per session AND per source, the same shape as backfillIdentityProof: the
// source row's proof is stable, so a failed adoption retries on the next refresh
// tick only if what we are adopting from has changed. Without this, member:getAll
// runs every ~2.5 s and this would be a write loop - the bug dcdb22b fixed.
const _profileAdopted = new Set()
function adoptProfileFromMyOtherDevice (ctx, rows) {
  const self = pubkeyHex(ctx)
  const mine = rows.find((r) => r && r.pubkey === self)
  if (!mine || !mine.identityProof) return // no proof of our own = no claim about anyone
  const candidates = rows.filter((r) => r && r.pubkey !== self && r.identityProof && String(r.displayName || '').trim())
  if (!candidates.length) return

  ;(async () => {
    const myRoot = await identityRootOf(mine.identityProof)
    if (!myRoot) return
    // Newest first, so linking a third phone adopts the name you most recently set
    // rather than whichever row happens to sort first.
    candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    for (const row of candidates) {
      if (await identityRootOf(row.identityProof) !== myRoot) continue // not us
      const guard = self + ':' + row.identityProof
      if (_profileAdopted.has(guard)) return
      _profileAdopted.add(guard)

      const prof = (await ctx.localDb.get('profile'))?.value
      if (!isUntouchedProfile(prof)) return // the user named this phone; leave it

      const adopted = { displayName: String(row.displayName).slice(0, 64), updatedAt: Date.now(), v: 1 }
      // Carry the avatar REFERENCE, not bytes. The blob lives in a content store
      // and is fetched on render; the proposal's eager-fetch-at-pairing step is
      // separate work, so until it lands this may render initials until the bytes
      // arrive. Better than the wrong name.
      if (row.avatarBlob && row.avatarHash) {
        adopted.avatarBlob = row.avatarBlob
        adopted.avatarHash = row.avatarHash
        adopted.avatarType = row.avatarType || 'image/png'
      }
      await ctx.localDb.put('profile', adopted)

      // PULL THE IMAGE NOW, not on first render.
      //
      // Tim's point, 2026-07-29: the phone we are adopting from is online BY
      // CONSTRUCTION at this moment - it generated the pair link and held the
      // session open - so this is the one window where both devices are certainly
      // connected. `resolveAvatarCached` is lazy and would fetch whenever something
      // first renders a roster, which may be long after the other phone was
      // pocketed, closed or swiped away (the TCL reaps the worklet on swipe-away).
      // So the cheapest guaranteed opportunity is the one the lazy path skips.
      //
      // `ctx.blobs.get` downloads the blocks into this device's own copy, so once
      // this resolves the picture survives the other phone going away. It also
      // warms avatarCache, so the UI shows it immediately rather than a beat later.
      //
      // NOT fatal if it fails: the lazy path still runs on every roster render, so
      // a missed fetch heals the next time both devices are connected. The name is
      // the part that matters most and it is already saved above.
      let gotAvatar = false
      if (adopted.avatarBlob) {
        try {
          gotAvatar = !!(await resolveAvatarAwait(ctx, adopted))
          // Record the content hash the way profile:set does, so if this person
          // later re-saves the same image it dedupes instead of appending it again.
          if (gotAvatar) {
            await ctx.localDb.put('blobref:' + adopted.avatarHash,
              { key: adopted.avatarBlob.key, id: adopted.avatarBlob.id, type: adopted.avatarType }).catch(() => {})
          }
        } catch { gotAvatar = false }
      }
      _dlTrace('dl:adoptedProfile', { from: row.pubkey.slice(0, 8), avatar: !!adopted.avatarBlob, gotBytes: gotAvatar })
      await publishMember(ctx) // every space, so the household stops seeing two names
      try { ctx.emit('profile:changed', { displayName: adopted.displayName }) } catch {}
      return
    }
  })().catch(() => {})
}

async function publishMember (ctx, onlyGroupId) {
  const prof = (await ctx.localDb.get('profile'))?.value
  // `caps` advertises what this build understands. It is the capability gate for
  // writer revocation: the owner may only ARM revocation once every other member
  // advertises REVOKE_CAP, because a peer that does not understand a revokeWriter op
  // keeps accepting the revoked writer's blocks and SILENTLY forks the space.
  // Additive field -> old peers store it verbatim and ignore it. No fork.
  // REVOKE_SELF_CAP is advertised alongside it for the same reason one step later:
  // honouring a SAME-IDENTITY revocation is a rule an old peer decides differently,
  // so the owner may only arm revokeV2 once everyone advertises revoke2. Advertising
  // it is free and additive; it does nothing until a space is armed.
  const value = { displayName: prof?.displayName || 'Member', caps: [REVOKE_CAP, REVOKE_SELF_CAP] }
  if (prof?.avatarBlob) { value.avatarBlob = prof.avatarBlob; value.avatarHash = prof.avatarHash; value.avatarType = prof.avatarType || 'image/png' }
  else if (prof?.avatar) value.avatar = prof.avatar // legacy inline (pre-blob profiles)

  // `identityProof` proves this device key belongs to a person, so two phones can
  // be shown as one member and an assignment can reach both. Additive optional
  // field, exactly like `caps`: an old peer stores it verbatim, ignores it, shows
  // two rows and routes to one device - i.e. today's behaviour, which is the right
  // degradation. See proposals/2026-07-29-one-person-many-devices.md.
  //
  // Only present once this device has a mnemonic, which means only after linking.
  // A phone that never links publishes nothing here and is unaffected - and
  // src/memberIdentity.js will not merge it with anything, because an ABSENT proof
  // is not evidence that two people are the same person.
  const proof = await deviceIdentityProof(ctx)
  if (proof) value.identityProof = proof
  _dlTrace('dl:publishMember', { proof: !!proof })

  const key = memberKey(pubkeyHex(ctx))
  let published = false
  for (const [groupId, base] of ctx.bases) {
    if (onlyGroupId && groupId !== onlyGroupId) continue
    if (!base.writable) continue
    try { await ctx.append(groupId, { type: 'put', key, value: signRow(ctx, value) }); published = true } catch {}
  }
  return published
}

// Stamp authorship + a fresh updatedAt, then sign. Every write records the
// CURRENT editor as pubkey (proves who made this edit; createdBy is preserved
// by the caller spreading the existing row).
function signRow (ctx, value) {
  return signValue({ ...value, pubkey: pubkeyHex(ctx), updatedAt: Date.now() }, ctx.identity.secretKey)
}

async function putRow (ctx, groupId, key, value) {
  await ctx.append(groupId, { type: 'put', key, value: signRow(ctx, value) })
}

// Owner-only edit of the `space` row's `evicted` map (read-modify-write, so it
// preserves owner/name/createdAt). Refuses to evict the owner: that would hide
// the one account that can un-hide anyone, and it is not how an owner exits (they
// delete the space, or - later - hand ownership off).
//
// Two owner devices evicting concurrently both RMW this row and resolve LWW, so
// one eviction can be lost. Rare (a single owner), and re-doing it just works.
const HEX_64 = /^[0-9a-f]{64}$/i
async function setEvicted (ctx, groupId, pubkey, evicted) {
  if (typeof pubkey !== 'string' || !HEX_64.test(pubkey)) throw new Error('invalid pubkey')
  const base = viewFor(ctx, groupId)
  const meta = await readRow(base, 'space')
  if (!meta || meta.owner !== pubkeyHex(ctx)) throw new Error('only the owner can remove a member')
  if (pubkey === meta.owner) throw new Error('the owner cannot be removed')
  const next = { ...(meta.evicted || {}) }
  if (evicted) next[pubkey] = { at: Date.now() }
  else delete next[pubkey]
  await putRow(ctx, groupId, 'space', { ...meta, evicted: next })

  // HARD REVOCATION (proposals/2026-07-13-writer-revocation.md). Hiding a member
  // does not stop their device WRITING. If the space is armed, also revoke their
  // Autobase writer core, so an evicted device can no longer write at all.
  //
  // The writer key comes from `_w`, which apply derived from the block's AUTHORING
  // core (listWire.writerKeyOf) - never from anything the member declared, or a
  // member could name a victim's writer key and have us revoke the VICTIM.
  //
  // Best-effort: no `_w` (member never wrote a row while armed) = nothing to revoke,
  // and they stay hidden-only. Restoring a member does NOT re-add their writer; they
  // rejoin via a fresh invite, which admits them again.
  let revoked = false
  if (evicted && meta.revokeV1 === true) {
    const row = await readRow(base, memberKey(pubkey))
    const writerKey = row && typeof row._w === 'string' ? row._w : null
    if (writerKey) {
      await ctx.append(groupId, signValue({
        type: 'revokeWriter', pubkey: writerKey, by: pubkeyHex(ctx), groupId,
      }, ctx.identity.secretKey))
      revoked = true
    }
  }
  return { ok: true, evicted, revoked }
}

// Revoke ONE OF MY OWN DEVICES from every space it can write to.
//
// This is the space half of "remove this phone": device-link revokes it on the
// personal base, and this cuts it off from the shared lists, which is the part a
// person actually cares about after losing a phone.
//
// `appPubkey` is the removed device's CORE identity key, carried on its roster row
// precisely so this lookup is possible - see the comment in device-meta.js for why
// self-attesting it is safe.
//
// WE DO NOT NEED TO OWN THE SPACE. authorizeRevoke accepts a revocation from a device
// that proves the same identity root as the target, which is exactly this case - my
// phone revoking my other phone. That is what makes removal work in a housemate's
// space at all. See proposals/2026-07-29-removing-a-phone-should-remove-it.md.
//
// BEST-EFFORT PER SPACE, and it reports which ones it could not do rather than
// pretending. A space is skipped when:
//   - it is not armed for revokeV2 (an old member has not updated, so honouring a
//     same-identity revocation would fork it)
//   - the device has no `_w` binding, i.e. it never wrote while the space was armed,
//     so there is nothing to name
//   - this device cannot write to that space
// The caller surfaces `blocked` so the UI can say "3 of 4 spaces" instead of implying
// a clean sweep.
async function revokeDeviceFromSpaces (ctx, appPubkey) {
  const out = { revoked: 0, blocked: [] }
  if (typeof appPubkey !== 'string' || !appPubkey) return out
  const me = pubkeyHex(ctx)
  if (appPubkey === me) return out // never revoke the phone we are holding

  for (const [groupId, base] of ctx.bases) {
    try {
      if (!base.writable) { out.blocked.push({ groupId, why: 'not-writable' }); continue }
      const meta = await readRow(base, 'space')
      if (!(meta && meta.revokeV1 === true && meta.revokeV2 === true)) {
        out.blocked.push({ groupId, why: 'not-armed' }); continue
      }
      const row = await readRow(base, memberKey(appPubkey))
      const writerKey = row && typeof row._w === 'string' ? row._w : null
      if (!writerKey) { out.blocked.push({ groupId, why: 'no-writer-binding' }); continue }

      await ctx.append(groupId, signValue({
        type: 'revokeWriter', pubkey: writerKey, by: me, groupId,
      }, ctx.identity.secretKey))
      out.revoked++
      _dlTrace('dl:revokedFromSpace', { gid: String(groupId).slice(0, 8), writer: writerKey.slice(0, 8) })
    } catch (e) {
      // One bad space must not stop the others - the same reasoning as the backup
      // fan-out. A phone cut off from three of four spaces is far better than none.
      out.blocked.push({ groupId, why: 'error' })
    }
  }
  return out
}

// Arm hard revocation for a space. Owner only, and ONE WAY - it changes how every
// peer applies writer ops, so there is no un-arming without re-forking.
//
// The gate: every member EXCEPT any already-evicted one must advertise REVOKE_CAP.
// A peer that does not understand a revokeWriter op keeps accepting a revoked
// writer's blocks and SILENTLY forks the space (peerloom-core
// test/writer-revocation.test.js). The already-evicted are excluded on purpose: the
// stale device we want gone is exactly the one that will never advertise support, so
// requiring it would mean the gate never opens.
// ALSO ARMS revokeV2 when everyone advertises revoke2, so that "remove my lost
// phone" works without a second trip through this gate. They are separate flags
// because they are separate rules an old peer decides differently, but there is no
// reason to make the owner arm twice: if the space can honour a same-identity
// revocation it should, and if it cannot, revokeV1 alone still arms.
async function armRevocation (ctx, groupId) {
  const base = viewFor(ctx, groupId)
  const meta = await readRow(base, 'space')
  if (!meta || meta.owner !== pubkeyHex(ctx)) throw new Error('only the owner can arm revocation')
  const rows = []
  for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) if (value) rows.push(value)
  const evicted = Object.keys(meta.evicted || {})
  const selfOk = allMembersSupportSelfRevoke(rows, evicted)

  // Already armed for v1: still worth a pass to add v2 if everyone has since updated.
  if (meta.revokeV1 === true) {
    if (meta.revokeV2 === true || !selfOk) {
      return { ok: true, armed: true, already: true, selfRevoke: meta.revokeV2 === true }
    }
    await putRow(ctx, groupId, 'space', { ...meta, revokeV2: true })
    return { ok: true, armed: true, already: true, selfRevoke: true }
  }

  if (!allMembersSupportRevoke(rows, evicted)) {
    const missing = rows
      .filter((r) => r.pubkey && !evicted.includes(r.pubkey) && r.deleted !== true && r.left !== true)
      .filter((r) => !(Array.isArray(r.caps) && r.caps.includes(REVOKE_CAP)))
      .map((r) => r.displayName || 'Member')
    throw new Error('every member must update first. Still on an old version: ' + (missing.join(', ') || 'unknown'))
  }
  const next = { ...meta, revokeV1: true }
  if (selfOk) next.revokeV2 = true
  await putRow(ctx, groupId, 'space', next)
  return { ok: true, armed: true, selfRevoke: !!selfOk }
}

function viewFor (ctx, groupId) {
  const base = ctx.bases.get(groupId)
  if (!base) throw new Error('unknown group: ' + groupId)
  return base
}

// Linearize before reading so a mutate sees the latest committed state (e.g.
// an item:add that just replicated or was appended a moment ago).
// Is this list a free-text note? Used to keep note-only behaviour out of the
// checklist paths (today: the autosuggest corpus). Failure is non-fatal and
// answers "no", so a read hiccup can never block an add.
async function isNoteList (ctx, groupId, listId) {
  try { return (await readRow(viewFor(ctx, groupId), listKey(listId)))?.kind === 'note' } catch { return false }
}

async function readRow (base, key) {
  await base.update()
  const node = await base.view.get(key)
  return node?.value ?? null
}

const methods = {
  // --- spaces -------------------------------------------------------------
  // Each joined group is a "space": its own members, lists, and invite, kept
  // cryptographically separate (own encryption key + swarm topic). A device can
  // be in many. The engine already tracks them in groups:joined; this lists them
  // (re-encoding each invite so the UI can re-share without stashing it).
  'spaces:list': async (_args, ctx) => {
    const out = []
    for await (const { value } of ctx.localDb.createReadStream({ gt: 'groups:joined:', lt: 'groups:joined:~' })) {
      if (!value || !value.groupId) continue
      const inviteKey = defaultEncodeInvite({
        groupId: value.groupId, groupKey: value.groupKey, encryptionKey: value.encryptionKey,
        bootstrap: value.bootstrap, name: value.name,
      })
      let owner = false
      const base = ctx.bases.get(value.groupId)
      if (base) {
        try {
          await base.update()
          let meta = (await base.view.get('space'))?.value
          // Migrate spaces created before the signed `space` owner record existed:
          // the founder (bootstrap writer) claims ownership once, on first list.
          if (!meta && base.writable && isFounder(base)) {
            await putRow(ctx, value.groupId, 'space', { owner: pubkeyHex(ctx), name: String(value.name || ''), createdAt: value.joinedAt || Date.now() })
            await base.update()
            meta = (await base.view.get('space'))?.value
          }
          owner = meta?.owner === pubkeyHex(ctx)
        } catch {}
      }
      out.push({ groupId: value.groupId, name: value.name || 'Space', inviteKey, joinedAt: value.joinedAt || 0, owner })
    }
    out.sort((a, b) => a.joinedAt - b.joinedAt)
    return out
  },

  // Why a space is showing nothing. Three states that look IDENTICAL in the UI
  // today - an empty space - and need completely different things from the user:
  //
  //   no connection    nothing can arrive. The other member's phone is asleep, or
  //                    the two are on networks that cannot reach each other.
  //   not writable     we joined and replicated, but no existing writer has
  //                    admitted this device yet, so our writes go nowhere and our
  //                    roster row is never published (publishMember skips it).
  //   writable         normal.
  //
  // Reported 2026-07-28: a user who reinstalled and rejoined saw the space NAME
  // and nothing else - no members, no lists - with no way to tell which of these
  // it was. The name rides the invite, so it proves only that the invite parsed.
  //
  // `conns` is swarm-wide, not per-group: Hyperswarm gives one connection per peer
  // and every mounted group shares it, so a group cannot count its own. It answers
  // "is this device talking to anyone at all", which is the question that matters
  // when the answer is zero.
  'space:status': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    try { await base.update() } catch {}
    let members = 0
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) if (value) members++
    let lists = 0
    for await (const { value } of base.view.createReadStream(LIST_RANGE)) if (value) lists++
    return {
      writable: !!base.writable,
      conns: (ctx.swarm && ctx.swarm.connections && ctx.swarm.connections.size) || 0,
      members,
      lists,
    }
  },

  // Establish ownership of a freshly created space: the founder writes the signed
  // `space` owner record before anyone else can join (first-writer claims owner).
  // Idempotent: a no-op if a `space` record already exists.
  'space:init': async ({ groupId, name }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, 'space')
    if (existing) return { ok: true, owner: existing.owner }
    await putRow(ctx, groupId, 'space', { owner: pubkeyHex(ctx), name: String(name || ''), createdAt: Date.now() })
    return { ok: true, owner: pubkeyHex(ctx) }
  },

  // Delete a whole space. Owner only. Writes a `space` tombstone (only the owner's
  // signed update is accepted) that replicates to members (their apply emits
  // space:deleted so their UI tears the space down), then forgets it locally.
  // The base is kept a short grace period so the tombstone can propagate to
  // connected members, then torn down to free RAM/CPU/connections this session.
  'space:delete': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const meta = await readRow(base, 'space')
    if (!meta || meta.owner !== pubkeyHex(ctx)) throw new Error('only the owner can delete a space')
    await putRow(ctx, groupId, 'space', { ...meta, deleted: true, deletedAt: Date.now() })
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    setTimeout(() => { ctx.destroyGroup(groupId).catch(() => {}) }, SPACE_DELETE_GRACE_MS)
    return { ok: true }
  },

  // Forget a space locally (drop the membership record so it does not remount)
  // and tear it down now to stop replicating a space we have left. Called by a
  // member's UI after it receives space:deleted (it already has the tombstone,
  // so no propagation grace is needed).
  'space:forget': async ({ groupId }, ctx) => {
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    await ctx.destroyGroup(groupId).catch(() => {})
    return { ok: true }
  },

  // Retention (roadmap #4, P1): prune old already-applied input blocks to bound
  // append-only growth. Background maintenance - the UI calls it, throttled, for
  // the active space. keepRecent is generous so small spaces are untouched and
  // only long-churned ones shrink. Safe: the view is persisted and lagging/new
  // peers re-download or fast-forward (see @peerloom/core engine.retain).
  'space:retain': async ({ groupId, keepRecent }, ctx) => {
    return ctx.retain(groupId, { keepRecent: Number.isFinite(keepRecent) ? keepRecent : 512 })
  },

  // --- profile (device-local) --------------------------------------------
  // Stored in localDb as { displayName, avatarBlob?, avatarHash?, avatarType?,
  // updatedAt, v }. The avatar bytes live in the content blob store (not inline);
  // get/set resolve them back to a data URL so the UI is unchanged.
  'profile:get': async (_args, ctx) => {
    const row = await ctx.localDb.get('profile')
    if (!row) return null
    const p = row.value
    const out = { displayName: p.displayName, updatedAt: p.updatedAt, v: p.v }
    const avatar = await resolveAvatarAwait(ctx, p) // own blob is local -> fast
    if (avatar) out.avatar = avatar
    return out
  },

  'profile:set': async (args = {}, ctx) => {
    const { displayName } = args
    if (typeof displayName !== 'string' || !displayName.trim()) throw new Error('displayName required')
    const existing = (await ctx.localDb.get('profile'))?.value || {}
    const profile = { displayName: displayName.trim().slice(0, 64), updatedAt: Date.now(), v: 1 }
    // avatar: key absent -> preserve; null -> clear; data URL -> store in the
    // blob store (deduped by content hash so re-saving the same image, or a
    // name-only edit, does not append new bytes).
    if (Object.prototype.hasOwnProperty.call(args, 'avatar')) {
      if (args.avatar) {
        const parsed = parseDataUrl(args.avatar)
        if (!parsed || !parsed.base64) throw new Error('avatar must be a base64 data URL')
        const bytes = b4a.from(parsed.data, 'base64')
        if (bytes.length > AVATAR_MAX_BYTES) throw new Error('avatar too large')
        const hash = blobHash(bytes)
        let ref = (await ctx.localDb.get('blobref:' + hash))?.value
        if (!ref) { const put = await ctx.blobs.put(bytes); ref = { key: put.key, id: put.id, type: parsed.mime }; await ctx.localDb.put('blobref:' + hash, ref) }
        profile.avatarBlob = { key: ref.key, id: ref.id }; profile.avatarHash = hash; profile.avatarType = ref.type
        avatarCache.set(hash, String(args.avatar)) // warm cache with the exact bytes we were handed
      }
      // else (avatar null): leave the avatar fields off -> cleared.
    } else if (existing.avatarBlob) {
      profile.avatarBlob = existing.avatarBlob; profile.avatarHash = existing.avatarHash; profile.avatarType = existing.avatarType
    } else if (existing.avatar) {
      profile.avatar = existing.avatar // legacy inline passthrough
    }
    await ctx.localDb.put('profile', profile)
    await publishMember(ctx) // push updated name/avatar-ref to the roster
    const out = { displayName: profile.displayName, updatedAt: profile.updatedAt, v: 1 }
    const avatar = await resolveAvatarAwait(ctx, profile)
    if (avatar) out.avatar = avatar
    return out
  },

  // --- identity + members -------------------------------------------------
  'identity:get': async (_args, ctx) => ({ pubkey: pubkeyHex(ctx) }),

  // Publish our roster row to a group (call after join once writable; the UI
  // retries until it lands). Returns whether the base was writable.
  'member:publish': async ({ groupId }, ctx) => ({ published: await publishMember(ctx, groupId) }),

  // The roster, minus anyone the owner evicted (space.evicted), anyone who left
  // (row.left) and any tombstoned row. See listWire.isMemberVisible.
  'member:getAll': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const meta = await readRow(base, 'space')
    const out = []
    const self = pubkeyHex(ctx)
    // The proof currently published on OUR row, if any. Kept as the value rather
    // than a boolean: "is there a proof" cannot tell a correct one from one this
    // device published under a previous identity, before it was paired.
    let minePublishedProof = null
    // Raw rows for adoptProfileFromMyOtherDevice: it needs the avatar REFERENCE
    // fields, and `out` carries a resolved data URL instead. Cheap - same pass.
    const raw = []
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) {
      if (value && value.pubkey === self && value.identityProof) minePublishedProof = value.identityProof
      if (!isMemberVisible(value, meta)) continue
      raw.push(value)
      // identityProof + updatedAt are carried only so collapseMembers can verify
      // and order; it strips both before the UI sees the row. Tim's call: the
      // members list shows people, never hardware.
      out.push({
        pubkey: value.pubkey,
        displayName: value.displayName || 'Member',
        avatar: resolveAvatarCached(ctx, value),
        identityProof: value.identityProof,
        updatedAt: value.updatedAt,
      })
    }
    // If our own row predates this feature it carries no proof, and nothing else
    // would ever add one - and if it carries one from before this phone was paired,
    // that is worse than none. Cheap because the stream above already told us.
    backfillIdentityProof(ctx, groupId, minePublishedProof)
    // A phone you just linked should already be you. STOPGAP until the profile
    // moves to personal scope - see the comment on the function.
    adoptProfileFromMyOtherDevice(ctx, raw)
    // Two phones of one person become one row. Rows with no verified proof are
    // never merged - see src/memberIdentity.js for why that rule has no exception.
    return await collapseMembers(out)
  },

  // Remove a member from the space, or put one back. Owner only, and enforced
  // TWICE: here for a clear error, and deterministically in apply, where the
  // existing `space` rule accepts an update only from the established owner - so
  // a forged eviction from a non-owner is dropped identically on every peer.
  //
  // `evicted` is a revocable map, never a tombstone (a tombstone would trip the
  // no-resurrection rule and make a re-invited member permanently unrosterable),
  // which is what makes member:restore possible at all.
  //
  // This HIDES a member; it does not revoke them. The device stays an admitted
  // Autobase writer and can still read the space. Real revocation is a separate
  // T3 (proposals/2026-07-13-space-member-eviction.md, open question 2).
  'member:remove': async ({ groupId, pubkey }, ctx) => setEvicted(ctx, groupId, pubkey, true),
  'member:restore': async ({ groupId, pubkey }, ctx) => setEvicted(ctx, groupId, pubkey, false),

  // Arm hard revocation (owner only, one way). Until this is called, removal only
  // HIDES a member; after it, removal also cuts the device off from writing.
  'space:armRevocation': async ({ groupId }, ctx) => armRevocation(ctx, groupId),

  // Can this space be armed yet, and if not, who is holding it up? Drives the UI so
  // the owner sees "3 of 4 members have updated" rather than a bare error.
  //
  // ALSO SELF-HEALS THE WRITER BINDING. apply only stamps `_w` (the authoring writer
  // core) onto a member row while the space is ARMED, so every row written BEFORE
  // arming has no binding - and a removal then silently degrades to hide-only, with
  // nothing to revoke. (Found exactly that way on-device: armed a space whose member
  // had joined earlier, removed them, and their writes still landed.) So once armed,
  // each device re-publishes its OWN row until it carries a binding. Same shape as
  // the existing "republish until it lands" retry in the UI.
  'space:revocationStatus': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const meta = await readRow(base, 'space')
    const rows = []
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) if (value) rows.push(value)
    const evicted = Object.keys(meta?.evicted || {})
    const active = rows.filter((r) => r.pubkey && !evicted.includes(r.pubkey) && r.deleted !== true && r.left !== true)
    const missing = active.filter((r) => !(Array.isArray(r.caps) && r.caps.includes(REVOKE_CAP)))
    const armed = meta?.revokeV1 === true

    const me = pubkeyHex(ctx)
    const mine = rows.find((r) => r.pubkey === me)
    const bound = !!(mine && typeof mine._w === 'string')
    if (armed && mine && !bound) publishMember(ctx, groupId).catch(() => {})

    return {
      armed,
      isOwner: meta?.owner === me,
      canArm: allMembersSupportRevoke(rows, evicted),
      total: active.length,
      ready: active.length - missing.length,
      waitingOn: missing.map((r) => r.displayName || 'Member'),
      // Who can actually be hard-revoked yet. A member that has not been online since
      // arming has no binding, so removing them only HIDES them - the UI should not
      // promise more than that.
      unbound: active.filter((r) => typeof r._w !== 'string').map((r) => r.displayName || 'Member'),
    }
  },

  // The removed members, so the owner can put one back. Restore has to be reachable
  // from the UI: an evicted pubkey stays evicted even if that device re-joins with a
  // fresh invite (only the owner can write the `space` row, so the joiner cannot
  // clear its own eviction). Without this the removal would be one-way in practice,
  // whatever the data model allows.
  'member:getRemoved': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const meta = await readRow(base, 'space')
    const ev = (meta && meta.evicted) || {}
    if (!Object.keys(ev).length) return []
    const out = []
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) {
      if (value && value.pubkey && ev[value.pubkey]) out.push({ pubkey: value.pubkey, displayName: value.displayName || 'Member', avatar: resolveAvatarCached(ctx, value), at: ev[value.pubkey].at || 0 })
    }
    return out
  },

  // Leave a space. Self only: retires our OWN roster row with an additive `left`
  // flag, which the owner-scoped member rule already permits (and which nobody
  // else could write for us), then drops the space locally. Revocable: rejoining
  // republishes the row without `left`.
  //
  // Best-effort ordering: the flag has to replicate to a peer BEFORE we tear the
  // group down, else we vanish locally while staying in everyone else's roster.
  // Same grace the owner's space:delete uses for its tombstone.
  // A device that was never admitted CANNOT append, so the retract throws
  // `Not writable` and, before this, the whole method threw with it - leaving the
  // user trapped in a dead space they could not remove. Found on the TCL
  // 2026-07-28 trying to leave a space joined from an invite nobody hosts, which
  // is the exact state the 2026-07-28 user report describes.
  //
  // There is nothing to retract in that case: an unadmitted device never published
  // a roster row, so no peer has ever seen it as a member. Dropping it locally IS
  // the complete departure. `retracted` says which of the two happened.
  'space:leave': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    let retracted = false
    if (base.writable) {
      const mine = await readRow(base, memberKey(pubkeyHex(ctx)))
      await putRow(ctx, groupId, memberKey(pubkeyHex(ctx)), { ...(mine || {}), left: true })
      retracted = true
    }
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    setTimeout(() => { ctx.destroyGroup(groupId).catch(() => {}) }, SPACE_DELETE_GRACE_MS)
    return { ok: true, retracted }
  },

  // --- device linking (SLICE 1, dark) --------------------------------------
  // The only device-link surface for now: does the engine come up, and what
  // identity does it derive. Read-only, and returns `{ enabled: false }` on an
  // ordinary build so the UI can ask without caring whether the flag is on.
  //
  // Everything user-facing - pairing, the roster, the recovery phrase - is slices
  // 2 and 3. See proposals/2026-07-28-device-linking.md.
  'device:status': async (_args, ctx) => {
    if (!DEVICE_LINK_ENABLED) return { enabled: false }
    try {
      const dl = await getDeviceLink(ctx)
      return {
        enabled: true,
        identityPublicKey: dl.identityPublicKeyHex,
        personalBaseOpen: dl.isEnabled,
        // The roster is device-link's own; empty until a second device pairs.
        devices: await dl.listLinkedDevices().catch(() => []),
      }
    } catch (e) {
      // Never throw from a diagnostic: a broken device-link must not be able to
      // take down a method table the rest of the app depends on.
      return { enabled: true, error: e?.message ?? String(e) }
    }
  },

  // Hand the worklet the mnemonic the SHELL holds in secure storage (Keystore /
  // Keychain). Called once at boot, before anything touches device-link.
  //
  // The phrase never goes to localDb: the worklet keeps it in memory and the shell
  // owns the only copy at rest. `null` on a device that has never had one - the
  // engine mints it on first enable and the deviceLink:mnemonic event carries it
  // back to the shell to store.
  'device:provisionMnemonic': async ({ mnemonic }, _ctx) => {
    const had = provisionMnemonic(mnemonic)
    _dlTrace('dl:provisioned', { had })
    return { had }
  },

  // Start pairing on the device that ALREADY has the identity (the "primary").
  // Returns a link to show as a QR / copy. Short-lived by design - device-link
  // expires the session - and `enable()` first, because a personal base has to
  // exist before another device can be admitted to it.
  'device:startPairing': async (_args, ctx) => {
    const dl = await getDeviceLink(ctx)
    if (!dl.isEnabled) await dl.enable()
    _dlTrace('dl:startPairing:called')
    const invite = await dl.startPairing()
    // Build the link OURSELVES from the session snapshot rather than using
    // device-link's `invite.url`. Its default is `peerloom://pair?...`, which is
    // not a scheme this app is registered for and not what our parser accepts -
    // so a link built there could be shown and never open anything.
    return {
      url: buildPairLink({
        topic: invite.topicHex,
        handshake: invite.handshakeHex,
        identity: invite.identityHex,
        expiresMs: invite.expiresAt,
      }),
      expiresAt: invite.expiresAt,
    }
  },

  'device:cancelPairing': async (_args, ctx) => {
    const dl = await getDeviceLink(ctx)
    dl.cancelPairing()
    return { ok: true }
  },

  // The NEW device consumes the link. On success it holds the same identity, is a
  // writer on the personal base, and - via the group plugin - has been seeded
  // with every space the primary is in and granted write on them.
  //
  // Deliberately NOT wrapped in a timeout here: device-link expires its own
  // session, and a UI timeout on top would report failure while the handshake was
  // still in flight.
  'device:consumePairLink': async ({ url }, ctx) => {
    const dl = await getDeviceLink(ctx)
    const parsed = parsePairLink(String(url || ''))
    _dlTrace('dl:consumePairLink:parsed', { ok: parsed.ok, error: parsed.error })
    if (!parsed.ok) throw new Error('that does not look like a PearList device link')
    try {
      await dl.consumePairLink(parsed)
    } catch (e) {
      // The failure mode that stalled 2026-07-28 was a consume that never
      // resolved OR rejected quietly. Trace both outcomes.
      _dlTrace('dl:consumePairLink:failed', { err: e?.message })
      throw e
    }
    _dlTrace('dl:consumePairLink:ok')
    return { ok: true, identityPublicKey: dl.identityPublicKeyHex }
  },

  'device:list': async (_args, ctx) => {
    const dl = await getDeviceLink(ctx)
    return await dl.listLinkedDevices()
  },

  // Renames THIS device, and only this device. Not a limitation of the IPC - it
  // is what deviceMeta is: a self-attested row, so `decideDeviceMetaPut` checks
  // the op's author against the row's writerKey and drops anything else. A phone
  // naming another phone is rejected by the merge rule, so offering it would be a
  // button that silently does nothing.
  //
  // TOOK A writerKey UNTIL 2026-07-29 and passed it as the FIRST argument to
  // `setDeviceNickname(nickname)`, which takes one. So the nickname was set to
  // the writer key - a 64-char hex string - and the real nickname was dropped.
  // Nothing caught it because no UI could reach this method (see the roster sheet
  // in App.jsx, added the same day).
  // `ok` is now the REAL result, not a constant. It used to hard-code true, which
  // became a lie once revocation existed: a device removed from the account is no
  // longer writable, so the rename was refused while the UI closed as if it had
  // worked. Seen on hardware 2026-07-29 from the revoked side. `writable` lets the
  // UI say WHY rather than just failing quietly.
  'device:setNickname': async ({ nickname }, ctx) => {
    const dl = await getDeviceLink(ctx)
    const saved = await dl.setDeviceNickname(String(nickname || ''))
    const writable = typeof dl.isWritable === 'function' ? dl.isWritable() : true
    return { ok: !!saved, writable }
  },

  // Takes a device off the roster AND revokes its writer key on the personal base.
  // Read what this does and does not do before writing copy for it, because the
  // obvious reading is still too generous:
  //
  //   it does     drop the deviceMeta row and leave a `deviceMetaHidden:`
  //               tombstone, so the device stops appearing on every device that
  //               applies the op
  //   it does     revoke the device's writer key on the PERSONAL base, as of
  //               peerloom-device-link PR #6, so it can no longer write there and
  //               cannot be silently re-admitted by a replayed addWriter
  //   it does NOT touch the SHARED SPACES. The removed phone keeps the per-space
  //               writer keys it was granted at pairing (grantGroupWriter) and can
  //               still edit those lists. That is the space-side half of
  //               proposals/2026-07-29-removing-a-phone-should-remove-it.md, which
  //               needs a same-identity authorisation change in core behind a
  //               `revoke2` gate, and is NOT built yet.
  //   it does NOT stop the device READING. Core replicates to anyone holding the
  //               topic and key, and the removed phone has both on disk. Cutting
  //               reads off means a new space (DECISIONS.md 2026-07-28).
  //   it does NOT un-know the recovery phrase.
  //
  // So the honest promise today is "off your device list, and it can no longer
  // write to your own account - but it can still change shared lists until the
  // space-side half ships". Do not let the copy round that up. Telling someone a
  // lost phone has been shut out when it has not is the worst possible thing to be
  // wrong about on this screen.
  //
  // Returns device-link's own { hidden, revoked, self? } verbatim rather than a flat
  // ok:true, because those can differ - a revocation that would leave no indexer is
  // skipped, and removing the phone you are holding is refused - and the UI needs to
  // be able to say which happened.
  'device:remove': async ({ writerKey }, ctx) => {
    const dl = await getDeviceLink(ctx)
    const res = await dl.removeDevice(String(writerKey || ''))
    const spaces = res?.appPubkey ? await revokeDeviceFromSpaces(ctx, res.appPubkey) : { revoked: 0, blocked: [] }
    _dlTrace('dl:removeDevice', {
      hidden: !!res?.hidden, revoked: !!res?.revoked, self: !!res?.self,
      mapped: !!res?.appPubkey, spacesRevoked: spaces.revoked, spacesBlocked: spaces.blocked.length,
    })
    return { ok: !!(res && (res.hidden || res.revoked)), ...res, spaces }
  },

  // --- backup export / import ----------------------------------------------
  // A file is the one way out that needs no peer. See src/spaceBackup.js for the
  // format and for why it is deliberately unsigned.

  // EVERY space on this device, as one JSON document. Not just the one on screen:
  // "back up my lists" means the phone, and a one-space file silently leaves the
  // others unprotected (Tim, 2026-07-28).
  //
  // Reads only; appends nothing, so a space this device cannot WRITE to is still
  // exported - which is exactly the space someone most needs to get lists out of.
  // One failing space must not take the whole backup down with it either: a
  // half-mounted or unreadable space is skipped, and the rest still saves.
  //
  // `learnedAisles` and `customAisles` come IN from the UI: they live in the
  // WebView's localStorage (a personal shopping habit, not household data), which
  // the worklet cannot read. Saved templates DO live in localDb, so they are read
  // here. All three are device-local and were lost silently by a wipe until now.
  'backup:export': async ({ learnedAisles, customAisles } = {}, ctx) => {
    const byGroup = (customAisles && typeof customAisles === 'object') ? customAisles : {}
    const spaces = []
    for await (const { value } of ctx.localDb.createReadStream({ gt: 'groups:joined:', lt: 'groups:joined:~' })) {
      if (!value || !value.groupId) continue
      const base = ctx.bases.get(value.groupId)
      if (!base) continue
      try {
        await base.update()
        const meta = await readRow(base, 'space')
        // The signed `space` row is the household's name for it; groups:joined is
        // what the invite said. Prefer the shared one, fall back to the local one -
        // an unadmitted device has only ever seen the second.
        const name = (meta && meta.name) || value.name || 'Space'
        const lists = []
        for await (const { value: l } of base.view.createReadStream(LIST_RANGE)) {
          if (!l || l.deleted) continue
          const items = []
          for await (const { value: it } of base.view.createReadStream(itemRange(l.id))) {
            if (it && !it.deleted) items.push(it)
          }
          lists.push({ name: l.name, kind: l.kind, notifyOnComplete: l.notifyOnComplete, items })
        }
        spaces.push({ name, customAisles: byGroup[value.groupId], lists })
      } catch { continue }
    }

    const at = Date.now()
    const doc = buildBackup({ spaces, templates: await readTemplates(ctx), learnedAisles, exportedAt: at })
    const lists = doc.spaces.reduce((n, sp) => n + sp.lists.length, 0)
    const items = doc.spaces.reduce((n, sp) => n + sp.lists.reduce((m, l) => m + l.items.length, 0), 0)
    // Pretty-printed on purpose: the file is meant to be openable, and readable,
    // by the person whose groceries are in it.
    return {
      json: JSON.stringify(doc, null, 2),
      filename: backupFilename(at),
      counts: {
        spaces: doc.spaces.length,
        lists,
        items,
        templates: (doc.templates || []).length,
        learnedAisles: Object.keys(doc.learnedAisles || {}).length,
      },
    }
  },

  // Import into BRAND NEW spaces that this device founds, never into existing
  // ones. That is a deliberate limit, not an oversight: merging a file into a live
  // shared space is a sync problem (which rows are the same row?), and getting it
  // wrong would duplicate a household's whole list rather than fail visibly. New
  // spaces are always safe, and re-inviting the household is two taps.
  'backup:import': async ({ jsonString }, ctx) => {
    const parsed = parseBackup(jsonString) // throws a human-readable reason
    const created = []
    for (const sp of parsed.spaces) {
      const { groupId } = await ctx.createGroup({ name: sp.name })
      // Claim ownership immediately, same as the UI does after group:create: the
      // first signed `space` write wins, and this device is the only one here.
      await putRow(ctx, groupId, 'space', { owner: pubkeyHex(ctx), name: sp.name, createdAt: Date.now() })

      for (const l of sp.lists) {
        const listId = newEntityId()
        await putRow(ctx, groupId, listKey(listId), {
          id: listId, name: l.name, kind: normalizeKind(l.kind), assignee: null,
          createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
          // A user's own setting for this list, so it is restored. Normalized
          // here because the file may have been hand-edited.
          ...(normalizeNotifyMode(l.notifyOnComplete) ? { notifyOnComplete: normalizeNotifyMode(l.notifyOnComplete) } : {}),
        })
        for (const e of l.items) {
          const itemId = newEntityId()
          const repeat = normalizeRepeat(e.repeat)
          await putRow(ctx, groupId, itemKey(listId, itemId), {
            id: itemId, listId, text: String(e.text ?? ''), qty: Number.isFinite(e.qty) ? e.qty : 1,
            checked: e.checked === true, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
            ...(e.category ? { category: e.category, ...(e.catBy ? { catBy: String(e.catBy) } : {}) } : {}),
            ...(e.ord ? { ord: e.ord } : {}),
            ...(e.note ? { note: e.note } : {}),
            ...(e.url ? { url: e.url } : {}),
            // normalizeRepeat is the one gate on an unknown value from the file,
            // and it returns null rather than throwing. lastDoneAt only means
            // anything alongside a repeat, and that is the only case that reads
            // it: effectiveChecked derives a recurring item's done-state from it,
            // ignoring `checked` entirely.
            ...(repeat ? { repeat } : {}),
            ...(repeat && Number.isFinite(e.lastDoneAt) ? { lastDoneAt: e.lastDoneAt } : {}),
          })
        }
      }
      // The space's own hand-made aisle names ride back out with the id they now
      // belong to: the UI writes them to localStorage keyed by groupId, and the
      // NEW id is only known here. Matching them up by index in the caller would
      // break the moment an empty space is skipped.
      created.push({ groupId, name: sp.name, customAisles: sp.customAisles || [] })
    }

    // Saved lists are device-local (localDb), so they are restored here. MERGE,
    // never overwrite: a name that already exists on this device keeps what is
    // already there. An import must not be able to quietly rewrite a template the
    // user has since changed - and on the main case, a fresh phone, there is
    // nothing to collide with.
    let templatesAdded = 0
    if (parsed.templates.length) {
      const existing = await readTemplates(ctx)
      const taken = new Set(existing.map((t) => String(t.name || '').toLowerCase()))
      const next = existing.slice()
      for (const t of parsed.templates) {
        if (next.length >= TEMPLATES_CAP) break
        const norm = String(t.name || '').toLowerCase()
        if (taken.has(norm)) continue
        taken.add(norm)
        next.push({ id: newEntityId(), name: t.name, kind: normalizeKind(t.kind), entries: t.entries, savedAt: Date.now(), updatedAt: Date.now() })
        templatesAdded++
      }
      if (templatesAdded) await writeTemplates(ctx, next)
    }
    // Deliberately NOT recordRecent'd, for the same reason template:apply is not:
    // the autosuggest corpus learns what you TYPE, and an import would dump a
    // whole household's history into it at once.
    // learnedAisles goes back to the UI to write: it lives in the WebView's
    // localStorage, which the worklet cannot touch.
    return { spaces: created, learnedAisles: parsed.learnedAisles, counts: { ...parsed.counts, templates: templatesAdded } }
  },

  // --- donation reminder (device-local) ----------------------------------
  // Suite pattern: nudge once after 2 weeks of use. Tracks first use + whether
  // shown. The UI additionally gates this off on iOS (App Store 3.1.1).
  'donation:status': async (_args, ctx) => {
    let row = (await ctx.localDb.get('donateReminder'))?.value
    if (!row) { row = { firstUseAt: Date.now(), shown: false }; await ctx.localDb.put('donateReminder', row) }
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000
    return { due: !row.shown && (Date.now() - row.firstUseAt >= FOURTEEN_DAYS), shown: !!row.shown, firstUseAt: row.firstUseAt }
  },
  'donation:dismiss': async (_args, ctx) => {
    const row = (await ctx.localDb.get('donateReminder'))?.value || { firstUseAt: Date.now() }
    row.shown = true
    await ctx.localDb.put('donateReminder', row)
    return { ok: true }
  },

  // --- connection ---------------------------------------------------------

  // The off-LAN relay toggle ("Connect Anywhere"), device-local and never synced.
  // The swarm's relayThrough function reads the cached value live on every dial,
  // so flipping it applies to the next connection with no reconnect. See
  // proposals/2026-07-23-blind-relay-adoption.md.
  'relay:get': async () => ({ useRelay: relay.getUseRelay(), configured: !!relay.RELAY_PUBLIC_KEY }),
  // Whether the relay is actually doing anything, which is otherwise invisible:
  // a relayed connection looks exactly like a direct one from up here. NOTE the
  // counters live on hyperdht's SERVER side (lib/server.js), so they climb on the
  // peer that ACCEPTED a relayed connection, not on the one that asked for it.
  // In a two-device test, read both phones.
  'relay:stats': async (_args, ctx) => {
    const dht = ctx.swarm && ctx.swarm.dht
    const stats = (dht && dht.stats) || {}
    return {
      useRelay: relay.getUseRelay(),
      relaying: { attempts: 0, successes: 0, aborts: 0, ...(stats.relaying || {}) },
      punches: { consistent: 0, random: 0, open: 0, ...(stats.punches || {}) },
      connections: (ctx.swarm && ctx.swarm.connections && ctx.swarm.connections.size) || 0,
      randomized: !!(dht && dht.randomized),
    }
  },
  'relay:set': async ({ on }, ctx) => {
    const useRelay = relay.setUseRelay(on)
    await ctx.localDb.put(relay.PREF_KEY, { useRelay })
    return { useRelay }
  },

  // --- saved list templates (device-local) ---------------------------------
  //
  // A template is a snapshot of a list's items kept on THIS phone, the same shape
  // of thing as the item:suggest recents: local, private, never synced. See
  // proposals/2026-07-23-saved-list-templates.md for why local rather than shared.
  //
  // What is snapshotted is the list's SHAPE, not its state: text, qty, aisle and
  // note-line order, never `checked`, never assignees, never who created it. So
  // starting a list from a template gives a fresh, all-unchecked list.

  'template:save': async ({ groupId, listId, name }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const list = await readRow(base, listKey(listId))
    if (!list || list.deleted) throw new Error('list not found')

    const entries = []
    for await (const { value } of base.view.createReadStream(itemRange(listId))) {
      if (!value || value.deleted) continue
      entries.push({
        text: String(value.text ?? ''),
        qty: Number.isFinite(value.qty) ? value.qty : 1,
        ...(value.category ? { category: value.category, catBy: value.catBy } : {}),
        ...(typeof value.ord === 'string' && value.ord ? { ord: value.ord } : {}),
      })
      if (entries.length >= TEMPLATE_ITEMS_CAP) break
    }
    if (!entries.length) throw new Error('nothing to save: the list is empty')

    const title = String(name ?? list.name ?? '').trim() || 'Saved list'
    const templates = await readTemplates(ctx)
    // Re-saving under a name already used REPLACES it, so refreshing a template
    // after adding an item is one tap and does not leave two near-identical
    // entries behind. Matching is case-insensitive for the same reason.
    const norm = title.toLowerCase()
    const existing = templates.find((t) => String(t.name || '').toLowerCase() === norm)
    const row = {
      id: existing ? existing.id : newEntityId(),
      name: title,
      kind: normalizeKind(list.kind),
      entries,
      savedAt: existing?.savedAt || Date.now(),
      updatedAt: Date.now(),
    }
    const next = templates.filter((t) => t.id !== row.id)
    next.unshift(row)
    if (next.length > TEMPLATES_CAP) next.length = TEMPLATES_CAP
    await writeTemplates(ctx, next)
    return { id: row.id, name: row.name, count: entries.length, replaced: !!existing }
  },

  // Summaries only - the UI never needs every entry to render the picker, and a
  // 30 x 200 payload over IPC on every open would be silly.
  'template:list': async (_args, ctx) => {
    const templates = await readTemplates(ctx)
    return templates.map((t) => ({
      id: t.id, name: t.name, kind: t.kind, count: (t.entries || []).length, updatedAt: t.updatedAt,
    }))
  },

  'template:delete': async ({ id }, ctx) => {
    const templates = await readTemplates(ctx)
    const next = templates.filter((t) => t.id !== id)
    await writeTemplates(ctx, next)
    return { deleted: next.length !== templates.length }
  },

  // Create a NEW list from a template. Everything it writes is ordinary signed
  // list:/item: rows, so peers see a normal list appear - there is nothing about
  // it a peer could fail to understand, which is the whole point of keeping
  // templates device-local.
  'template:apply': async ({ groupId, id, name }, ctx) => {
    const templates = await readTemplates(ctx)
    const t = templates.find((x) => x.id === id)
    if (!t) throw new Error('template not found')

    const listId = newEntityId()
    await putRow(ctx, groupId, listKey(listId), {
      id: listId, name: String(name ?? t.name ?? '').trim() || t.name, kind: normalizeKind(t.kind),
      assignee: null, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
    })
    for (const e of (t.entries || [])) {
      const itemId = newEntityId()
      await putRow(ctx, groupId, itemKey(listId, itemId), {
        id: itemId, listId, text: String(e.text ?? ''), qty: Number.isFinite(e.qty) ? e.qty : 1,
        checked: false, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
        ...(e.category ? { category: e.category, ...(e.catBy ? { catBy: e.catBy } : {}) } : {}),
        ...(e.ord ? { ord: e.ord } : {}),
      })
    }
    // Deliberately NOT recordRecent'd: the autosuggest corpus is meant to learn
    // what you TYPE, and one template application would otherwise dump 20 items
    // into it at once and skew the ranking.
    return { listId, added: (t.entries || []).length }
  },

  // --- lists --------------------------------------------------------------
  'list:create': async ({ groupId, name, kind }, ctx) => {
    const listId = newEntityId()
    await putRow(ctx, groupId, listKey(listId), {
      id: listId, name: String(name ?? ''), kind: normalizeKind(kind), assignee: null, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
    })
    return { listId }
  },

  // Set (or change) a list's category. Presentation for now; a chore kind is the
  // hook completion notifications will key off later. Normalized to a known kind.
  'list:setKind': async ({ groupId, listId, kind }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, listKey(listId))
    if (!existing || existing.deleted) throw new Error('list not found')
    await putRow(ctx, groupId, listKey(listId), { ...existing, kind: normalizeKind(kind) })
    return { ok: true }
  },

  // Set a list's completion-notification mode ('off' | 'each' | 'done'). When
  // set, it overrides the kind-derived default (chore -> 'done'). Notifies the
  // list's overseer (list.assignee) when someone else checks items; see
  // listWire maybeNotify. Junk normalizes to 'off'.
  'list:setNotifyOnComplete': async ({ groupId, listId, mode }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, listKey(listId))
    if (!existing || existing.deleted) throw new Error('list not found')
    await putRow(ctx, groupId, listKey(listId), { ...existing, notifyOnComplete: normalizeNotifyMode(mode) || 'off' })
    return { ok: true }
  },

  'list:rename': async ({ groupId, listId, name }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, listKey(listId))
    if (!existing || existing.deleted) throw new Error('list not found')
    await putRow(ctx, groupId, listKey(listId), { ...existing, name: String(name ?? '') })
    return { ok: true }
  },

  // Assign a whole list to a member (a "responsible person") by pubkey, or null.
  'list:assign': async ({ groupId, listId, assignee }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, listKey(listId))
    if (!existing || existing.deleted) throw new Error('list not found')
    await putRow(ctx, groupId, listKey(listId), { ...existing, assignee: assignee ? String(assignee) : null })
    return { ok: true }
  },

  'list:delete': async ({ groupId, listId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, listKey(listId))
    if (!existing) throw new Error('list not found')
    await putRow(ctx, groupId, listKey(listId), { ...existing, deleted: true })
    return { ok: true }
  },

  'list:getAll': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const out = []
    for await (const { value } of base.view.createReadStream(LIST_RANGE)) {
      if (value && !value.deleted) out.push(value)
    }
    return out
  },

  // What is still open, across every joined space. Read-only, appends nothing.
  // Chores, to-dos and untyped lists count; shopping lists and notes never do -
  // see isDigestCountable for why.
  //
  // Feeds the daily reminder (P1 of proposals/2026-07-27-reminder-notifications.md):
  // the shell calls this, gets ready-made copy back in `digest` and schedules it,
  // so the wording lives here where it is unit-tested instead of in the shell
  // where it is not. `digest` is null when nothing is open, which the shell reads
  // as "cancel", never as "schedule an empty nudge".
  //
  // Spans spaces on purpose: the reminder is one notification for the whole
  // phone, not one per household.
  'list:openSummary': async (_args, ctx) => {
    const lists = []
    const now = Date.now()
    let total = 0
    for (const [groupId, base] of ctx.bases) {
      // One bad base must not silently zero the whole digest, so failures are
      // per-space and the rest still counts.
      try {
        await base.update()
        const rows = []
        for await (const { value } of base.view.createReadStream(LIST_RANGE)) {
          if (isDigestCountable(value)) rows.push(value)
        }
        for (const list of rows) {
          let open = 0
          for await (const { value: it } of base.view.createReadStream(itemRange(list.id))) {
            // effectiveChecked: a weekly chore already done this week is not open
            // work and must not inflate the nudge.
            if (it && !it.deleted && !effectiveChecked(it, now)) open++
          }
          if (open > 0) {
            lists.push({ groupId, listId: list.id, name: String(list.name || ''), kind: list.kind || 'list', open })
            total += open
          }
        }
      } catch { continue }
    }
    const sorted = sortDigestLists(lists)
    return { total, lists: sorted, digest: digestText(sorted) }
  },

  // --- items --------------------------------------------------------------
  'item:add': async ({ groupId, listId, text, qty, ord }, ctx) => {
    const itemId = newEntityId()
    await putRow(ctx, groupId, itemKey(listId, itemId), {
      id: itemId, listId, text: String(text ?? ''), qty: Number.isFinite(qty) ? qty : 1,
      checked: false, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
      ...(typeof ord === 'string' && ord ? { ord } : {}),
    })
    // Learn this item for the add-item autosuggest - but NOT on a note list. A
    // note's rows are lines of prose, and feeding them to the recents corpus
    // would have sentences turning up as suggestions on the shopping list.
    if (!(await isNoteList(ctx, groupId, listId))) await recordRecent(ctx, text).catch(() => {})
    return { itemId }
  },

  // Save a note (kind 'note') as a three-way merge, NOT an overwrite. The editor
  // sends the rows as it LOADED them (`baseline`) plus what the user has now
  // typed (`lines`); we re-read the note's rows here and derive the operations
  // from baseline -> lines, applying them to what is actually stored.
  //
  // The consequence that matters: a line a peer added while the user was typing
  // is not in the baseline, so nothing in the plan refers to it and this save
  // cannot tombstone it. See planNoteSave in noteText.js.
  'note:save': async ({ groupId, listId, baseline, lines }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const list = await readRow(base, listKey(listId))
    if (!list || list.deleted) throw new Error('list not found')

    const rows = []
    for await (const { value } of base.view.createReadStream(itemRange(listId))) {
      if (value && !value.deleted) rows.push(value)
    }
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    const plan = planNoteSave(baseline, lines, rows)

    // Read-modify-write each row so a concurrent edit to another FIELD is not
    // clobbered, the same shape as item:edit.
    for (const u of plan.updates) {
      const existing = byId.get(String(u.id))
      if (!existing) continue
      await putRow(ctx, groupId, itemKey(listId, u.id), { ...existing, text: u.text })
    }
    for (const id of plan.deletes) {
      const existing = byId.get(String(id))
      if (!existing) continue
      await putRow(ctx, groupId, itemKey(listId, id), { ...existing, deleted: true })
    }
    for (const ins of plan.inserts) {
      const itemId = newEntityId()
      await putRow(ctx, groupId, itemKey(listId, itemId), {
        id: itemId, listId, text: ins.text, qty: 1, checked: false, ord: ins.ord,
        createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
      })
    }
    return { updated: plan.updates.length, deleted: plan.deletes.length, inserted: plan.inserts.length }
  },

  // Suggest previously-added item texts for the add-item composer. Device-local
  // and private; ranked by frequency + recency, matched on any word prefix.
  'item:suggest': async ({ prefix, limit } = {}, ctx) => {
    const doc = (await ctx.localDb.get('itemRecents'))?.value
    if (!doc || !Array.isArray(doc.items)) return []
    const p = String(prefix || '').trim().toLowerCase()
    const now = Date.now()
    let items = doc.items
    if (p) items = items.filter((x) => x.norm !== p && recentMatches(x.norm, p))
    return items.slice().sort((a, b) => recentScore(b, now) - recentScore(a, now))
      .slice(0, Math.max(1, Math.min(limit || 5, 10))).map((x) => x.text)
  },

  'item:toggle': async ({ groupId, listId, itemId, checked }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    const patch = { checked: !!checked }
    // Recurring chores: checking one records WHEN it was done, which is the only
    // write the whole feature needs - open-ness is derived from it at read time,
    // so nothing ever writes a reset (proposals/2026-07-27-recurring-chores.md).
    // Unchecking clears the stamp, which is what "I ticked that by mistake" means.
    if (normalizeRepeat(existing.repeat)) patch.lastDoneAt = checked ? Date.now() : null
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, ...patch })
    return { ok: true }
  },

  // Make an item recur, or stop it recurring. Signed read-modify-write like
  // item:assign. Setting a repeat leaves lastDoneAt alone: an item checked off
  // BEFORE it was ever recurring has no stamp, so it reads as open immediately,
  // which is the right default when you are declaring it a chore going forward.
  'item:setRepeat': async ({ groupId, listId, itemId, repeat }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    const next = normalizeRepeat(repeat)
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, repeat: next })
    return { repeat: next }
  },

  'item:edit': async ({ groupId, listId, itemId, text, qty, note, url }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    const patch = {}
    if (text !== undefined) patch.text = String(text)
    if (qty !== undefined && Number.isFinite(qty)) patch.qty = qty
    // note: free-text, capped. url: sanitized to a safe http(s) link (or ''). An
    // explicit undefined leaves the field untouched; '' clears it.
    if (note !== undefined) patch.note = note ? String(note).slice(0, 2000) : ''
    if (url !== undefined) patch.url = cleanUrl(url)
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, ...patch })
    return { ok: true }
  },

  'item:assign': async ({ groupId, listId, itemId, assignee }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, assignee: assignee ? String(assignee) : null })
    return { ok: true }
  },

  // Set or clear a reminder on one item (P2 of the reminders proposal). A signed
  // read-modify-write exactly like item:assign, so the whole row survives and old
  // builds keep the field. `remindAt` is epoch ms; null / undefined clears it.
  //
  // Refuses a time in the past. Scheduling one would be a silent no-op (the OS
  // fires nothing) and it would then sit on the row looking set forever, which is
  // worse than an error the UI can show.
  'item:setReminder': async ({ groupId, listId, itemId, remindAt }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    let next = null
    if (remindAt !== null && remindAt !== undefined) {
      const t = Number(remindAt)
      if (!Number.isFinite(t)) throw new Error('remindAt must be a timestamp')
      if (t <= Date.now()) throw new Error('that time has already passed')
      next = Math.trunc(t)
    }
    // Record WHO asked. reminderTargetOf uses it so the reminder rings on the
    // device that set it, rather than falling through to the list's creator -
    // which is a DEVICE identity and sent it to the wrong phone.
    const remindBy = next === null ? null : pubkeyHex(ctx)
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, remindAt: next, remindBy })
    return { remindAt: next, remindBy }
  },

  // Every reminder THIS device should have scheduled, across every joined space.
  // Read-only. The shell reconciles the OS's pending set against this, so the
  // decision of who rings lives here (pure + unit-tested) and not in the shell.
  //
  // Capped at MAX_SCHEDULED_REMINDERS because iOS silently drops past 64 pending
  // local notifications. `dropped` is returned rather than swallowed: a cap that
  // hides what it discarded reads as "everything is scheduled" when it is not.
  'reminder:pending': async (_args, ctx) => {
    const selfKey = pubkeyHex(ctx)
    const now = Date.now()
    const out = []
    let elsewhere = 0
    for (const [groupId, base] of ctx.bases) {
      try {
        await base.update()
        const lists = new Map()
        for await (const { value } of base.view.createReadStream(LIST_RANGE)) {
          if (value && value.id) lists.set(value.id, value)
        }
        for (const [listId, list] of lists) {
          for await (const { value: it } of base.view.createReadStream(itemRange(listId))) {
            if (!isReminderPending(it, list, selfKey, now)) {
              // Would have been pending for SOMEONE, just not us.
              if (it && !it.deleted && !effectiveChecked(it, now) && typeof it.remindAt === 'number' && it.remindAt > now && reminderTargetOf(it, list)) elsewhere++
              continue
            }
            out.push({
              key: itemKey(listId, it.id), groupId, listId, itemId: it.id,
              text: String(it.text || 'an item'), listName: String(list.name || 'a list'),
              kind: list.kind || 'list', remindAt: it.remindAt,
            })
          }
        }
      } catch { continue }
    }
    out.sort((a, b) => a.remindAt - b.remindAt) // soonest first, so the cap keeps the urgent ones
    // `elsewhere` is a diagnostic, not a feature: future reminders that resolve to
    // a DIFFERENT member. Some is normal (a parent setting one for a kid), but it
    // is also exactly what a targeting bug looks like from this side - "nothing to
    // schedule" and "nothing exists" are indistinguishable without it.
    return {
      reminders: out.slice(0, MAX_SCHEDULED_REMINDERS),
      dropped: Math.max(0, out.length - MAX_SCHEDULED_REMINDERS),
      elsewhere,
    }
  },

  'item:delete': async ({ groupId, listId, itemId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing) throw new Error('item not found')
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, deleted: true })
    return { ok: true }
  },

  // THE SEAM (proposals/2026-07-27-recurring-chores.md). `checked` returned here
  // is the EFFECTIVE one: for a recurring chore that means "done in the current
  // period", not "was ever ticked". Deriving it at this single point is what keeps
  // the UI, the strike-through and the auto-collapse right without each of them
  // having to know about recurrence. `nextDueAt` rides along so a closed chore can
  // say when it comes back.
  'item:getAll': async ({ groupId, listId }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const now = Date.now()
    const out = []
    for await (const { value } of base.view.createReadStream(itemRange(listId))) {
      if (!value || value.deleted) continue
      out.push(normalizeRepeat(value.repeat)
        ? { ...value, checked: effectiveChecked(value, now), nextDueAt: nextDueAt(value, now) }
        : value)
    }
    return out
  },

  // --- ai: on-device categorization --------------------------------------
  // Classify one item into a grocery aisle and write it onto the item row as a
  // normal signed op, so the category replicates to every peer (only ONE
  // capable device need run the classifier). `category` is additive: old peers
  // and non-grocery lists just ignore it. Re-reads before writing so a
  // concurrent edit is not clobbered.
  'ai:categorize': async ({ groupId, listId, itemId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    const category = normalizeAisle(await classifyItem(ctx, existing.text)) || 'Other'
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, category })
    return { category }
  },

  // Persist a category decided elsewhere (a user drag, or the shell's Learned
  // Aisles override) as a normal signed op, so one device's filing syncs to every
  // peer. The category is validated against the known aisles; an unknown value
  // is dropped rather than written. Re-reads to avoid clobbering a concurrent edit.
  'ai:setCategory': async ({ groupId, listId, itemId, category, by }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    // User cleared the category (pulled the item out of its aisle/section): drop
    // both the label and the manual-pin marker so it groups as un-filed again.
    if (by === 'user' && (category == null || category === '')) {
      const { category: _c, catBy: _b, ...rest } = existing
      await putRow(ctx, groupId, itemKey(listId, itemId), rest)
      return { category: null }
    }
    // A built-in aisle, or - only when the user chose it by hand - a sanitized
    // custom aisle/section name. The classifier (by omitted) stays locked to built-ins.
    const aisle = normalizeAisle(category) || (by === 'user' ? sanitizeCustomAisle(category) : null)
    if (!aisle) throw new Error('unknown aisle: ' + category)
    // A user-chosen aisle (drag or the item-detail picker) is pinned via catBy so
    // the AI fallback never re-sorts it - notably so an item can rest under 'Other'
    // on purpose. The AI path omits `by`, leaving any existing pin (and its value)
    // untouched. catBy is additive + synced, so the pin holds across every peer.
    const next = { ...existing, category: aisle }
    if (by === 'user') next.catBy = 'user'
    await putRow(ctx, groupId, itemKey(listId, itemId), next)
    return { category: aisle, catBy: next.catBy }
  },

  // Categorize every item in a list that lacks a category (or all of them when
  // `force`). Returns how many rows were written. This is the call the UI fires
  // in the background when a grocery list opens; it is a no-op once everything
  // is categorized, so it is safe to call on every load.
  'ai:categorizeList': async ({ groupId, listId, force }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const todo = []
    for await (const { value } of base.view.createReadStream(itemRange(listId))) {
      if (value && !value.deleted && (force || !value.category)) todo.push(value)
    }
    let categorized = 0
    for (const it of todo) {
      const category = normalizeAisle(await classifyItem(ctx, it.text)) || 'Other'
      const cur = await readRow(base, itemKey(listId, it.id)) // re-read: skip if edited/deleted meanwhile
      if (!cur || cur.deleted) continue
      await putRow(ctx, groupId, itemKey(listId, it.id), { ...cur, category })
      categorized++
    }
    return { categorized }
  },
}

module.exports = methods
// Exported for tests only. isUntouchedProfile decides whether the linked-device
// profile copy is allowed to overwrite - i.e. whether the user has named this phone
// themselves - so it is the part worth pinning down.
module.exports._isUntouchedProfile = isUntouchedProfile
