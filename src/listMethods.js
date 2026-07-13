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

const { listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange, normalizeKind, normalizeNotifyMode, isMemberVisible } = require('./listWire')
const { classifyAisle, normalizeAisle, sanitizeCustomAisle } = require('./aisles')

// Offline keyword aisle classifier for the worklet-side ai:categorize methods -
// the always-available baseline. `classifyItem` is the single seam a smarter
// classifier can swap into; the RN shell can also compute a category out-of-band
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
async function publishMember (ctx, onlyGroupId) {
  const prof = (await ctx.localDb.get('profile'))?.value
  const value = { displayName: prof?.displayName || 'Member' }
  if (prof?.avatarBlob) { value.avatarBlob = prof.avatarBlob; value.avatarHash = prof.avatarHash; value.avatarType = prof.avatarType || 'image/png' }
  else if (prof?.avatar) value.avatar = prof.avatar // legacy inline (pre-blob profiles)
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
  return { ok: true, evicted }
}

function viewFor (ctx, groupId) {
  const base = ctx.bases.get(groupId)
  if (!base) throw new Error('unknown group: ' + groupId)
  return base
}

// Linearize before reading so a mutate sees the latest committed state (e.g.
// an item:add that just replicated or was appended a moment ago).
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
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) {
      if (isMemberVisible(value, meta)) out.push({ pubkey: value.pubkey, displayName: value.displayName || 'Member', avatar: resolveAvatarCached(ctx, value) })
    }
    return out
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
  'space:leave': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const mine = await readRow(base, memberKey(pubkeyHex(ctx)))
    await putRow(ctx, groupId, memberKey(pubkeyHex(ctx)), { ...(mine || {}), left: true })
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    setTimeout(() => { ctx.destroyGroup(groupId).catch(() => {}) }, SPACE_DELETE_GRACE_MS)
    return { ok: true }
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

  // --- items --------------------------------------------------------------
  'item:add': async ({ groupId, listId, text, qty }, ctx) => {
    const itemId = newEntityId()
    await putRow(ctx, groupId, itemKey(listId, itemId), {
      id: itemId, listId, text: String(text ?? ''), qty: Number.isFinite(qty) ? qty : 1,
      checked: false, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
    })
    await recordRecent(ctx, text).catch(() => {}) // learn this item for suggestions
    return { itemId }
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
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, checked: !!checked })
    return { ok: true }
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

  'item:delete': async ({ groupId, listId, itemId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing) throw new Error('item not found')
    await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, deleted: true })
    return { ok: true }
  },

  'item:getAll': async ({ groupId, listId }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const out = []
    for await (const { value } of base.view.createReadStream(itemRange(listId))) {
      if (value && !value.deleted) out.push(value)
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

  // Persist a category computed elsewhere (the RN shell's QVAC worker) as a
  // normal signed op, so one capable device's classification syncs to every
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
