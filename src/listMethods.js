// PearList IPC method table. Each handler is (args, ctx) where ctx is the
// engine's method context: { identity, append, bases, emit, ... }. Handlers
// sign their writes with the device identity and append { type:'put', ... } ops;
// the engine's applyOps (applyListOp) does the merge. Reads pull from the
// linearized Hyperbee view.

const { signValue } = require('@peerloom/core/records')
const { newEntityId } = require('@peerloom/core/ids')
const { defaultEncodeInvite } = require('@peerloom/core/engine')
const b4a = require('b4a')

const { listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange } = require('./listWire')

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

// Publish this device's profile as its member:{pubkey} roster row to every group
// it can write to, so peers can resolve assignee pubkeys to a name + avatar.
async function publishMember (ctx, onlyGroupId) {
  const prof = (await ctx.localDb.get('profile'))?.value
  const value = { displayName: prof?.displayName || 'Member' }
  if (prof?.avatar) value.avatar = prof.avatar
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
  'space:delete': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    const meta = await readRow(base, 'space')
    if (!meta || meta.owner !== pubkeyHex(ctx)) throw new Error('only the owner can delete a space')
    await putRow(ctx, groupId, 'space', { ...meta, deleted: true, deletedAt: Date.now() })
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    return { ok: true }
  },

  // Forget a space locally (drop the membership record so it does not remount).
  // Called by a member's UI after it receives space:deleted.
  'space:forget': async ({ groupId }, ctx) => {
    await ctx.localDb.del('groups:joined:' + groupId).catch(() => {})
    return { ok: true }
  },

  // --- profile (device-local) --------------------------------------------
  // Stored in localDb, matching the suite: { displayName, avatar?, updatedAt, v }.
  // avatar is an inline base64 data URL. Kept local for now (member-name
  // broadcast to the group is a later enhancement).
  'profile:get': async (_args, ctx) => {
    const row = await ctx.localDb.get('profile')
    return row ? row.value : null
  },

  'profile:set': async (args = {}, ctx) => {
    const { displayName } = args
    if (typeof displayName !== 'string' || !displayName.trim()) throw new Error('displayName required')
    const existing = (await ctx.localDb.get('profile'))?.value || {}
    const profile = { displayName: displayName.trim().slice(0, 64), updatedAt: Date.now(), v: 1 }
    // avatar: key absent -> preserve; null -> clear; string -> set.
    if (Object.prototype.hasOwnProperty.call(args, 'avatar')) {
      if (args.avatar) profile.avatar = String(args.avatar)
    } else if (existing.avatar) {
      profile.avatar = existing.avatar
    }
    // ~2 MB raw file as a base64 data URL (gif/webp kept animated). Static photos
    // land far under this after downscaling in the UI.
    if (profile.avatar && profile.avatar.length > 3000000) throw new Error('avatar too large')
    await ctx.localDb.put('profile', profile)
    // Push the updated name/avatar to the household roster.
    await publishMember(ctx)
    return profile
  },

  // --- identity + members -------------------------------------------------
  'identity:get': async (_args, ctx) => ({ pubkey: pubkeyHex(ctx) }),

  // Publish our roster row to a group (call after join once writable; the UI
  // retries until it lands). Returns whether the base was writable.
  'member:publish': async ({ groupId }, ctx) => ({ published: await publishMember(ctx, groupId) }),

  'member:getAll': async ({ groupId }, ctx) => {
    const base = viewFor(ctx, groupId)
    await base.update()
    const out = []
    for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) {
      if (value && value.pubkey) out.push({ pubkey: value.pubkey, displayName: value.displayName || 'Member', avatar: value.avatar || null })
    }
    return out
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
  'list:create': async ({ groupId, name }, ctx) => {
    const listId = newEntityId()
    await putRow(ctx, groupId, listKey(listId), {
      id: listId, name: String(name ?? ''), assignee: null, createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
    })
    return { listId }
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
    return { itemId }
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
}

module.exports = methods
