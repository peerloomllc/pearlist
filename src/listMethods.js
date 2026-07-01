// PearList IPC method table. Each handler is (args, ctx) where ctx is the
// engine's method context: { identity, append, bases, emit, ... }. Handlers
// sign their writes with the device identity and append { type:'put', ... } ops;
// the engine's applyOps (applyListOp) does the merge. Reads pull from the
// linearized Hyperbee view.

const { signValue } = require('@peerloom/core/records')
const { newEntityId } = require('@peerloom/core/ids')
const { defaultEncodeInvite } = require('@peerloom/core/engine')
const b4a = require('b4a')

const { listKey, itemKey, LIST_RANGE, itemRange } = require('./listWire')

function pubkeyHex (ctx) { return b4a.toString(ctx.identity.publicKey, 'hex') }

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
  // --- household ----------------------------------------------------------
  // The first joined group is "the household". Lets the UI restore on launch
  // and re-show the invite without the creator having stashed it.
  'household:get': async (_args, ctx) => {
    for await (const { value } of ctx.localDb.createReadStream({ gt: 'groups:joined:', lt: 'groups:joined:~' })) {
      if (!value || !value.groupId) continue
      const inviteKey = defaultEncodeInvite({
        groupId: value.groupId, groupKey: value.groupKey, encryptionKey: value.encryptionKey,
        bootstrap: value.bootstrap, name: value.name,
      })
      return { groupId: value.groupId, name: value.name || 'Household', inviteKey }
    }
    return null
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
    if (profile.avatar && profile.avatar.length > 400000) throw new Error('avatar too large')
    await ctx.localDb.put('profile', profile)
    return profile
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
      id: listId, name: String(name ?? ''), createdBy: pubkeyHex(ctx), createdAt: Date.now(), deleted: false,
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

  'item:edit': async ({ groupId, listId, itemId, text, qty }, ctx) => {
    const base = viewFor(ctx, groupId)
    const existing = await readRow(base, itemKey(listId, itemId))
    if (!existing || existing.deleted) throw new Error('item not found')
    const patch = {}
    if (text !== undefined) patch.text = String(text)
    if (qty !== undefined && Number.isFinite(qty)) patch.qty = qty
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
