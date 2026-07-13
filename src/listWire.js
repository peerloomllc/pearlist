// PearList merge rules (the tripWire.js analog). Pure, so they unit-test
// without standing up a real Autobase. Plugged into the @peerloom/core engine
// as its applyOps.
//
// Data model (one household group, many lists):
//   list:{listId}            -> signed { id, name, kind?, assignee?, createdBy,
//                                        createdAt, updatedAt, pubkey, deleted }
//   item:{listId}:{itemId}   -> signed { id, listId, text, qty, checked,
//                                        assignee?, category?, catBy?, createdBy,
//                                        createdAt, updatedAt, pubkey, deleted }
//
// `category` is an optional grocery-aisle label (see aisles.js) written by the
// ai:categorize methods. Additive: it rides through applyOps like any other
// signed field, so old peers accept + ignore it and non-grocery lists never
// show it. No dedicated merge rule needed. `catBy` ('user' when set) marks a
// category the user chose by hand (drag or the item-detail aisle picker); the AI
// fallback skips catBy:'user' items, so a manual choice - including resting an
// item under 'Other' on purpose - is never re-sorted. Also additive.
//
// Items are keyed by a content id, NOT by author, so ANY household member can
// check / edit / delete ANY item (the shared-list UX). See pearlist
// DECISIONS.md 2026-06-30. `pubkey` records the LAST editor and the signature
// proves it; concurrent edits resolve last-writer-wins.
//
// MEMBERSHIP REMOVAL (proposals/2026-07-13-space-member-eviction.md). Two additive
// fields, deliberately NOT a new namespace: applyListOp drops keys outside
// NAMESPACES, so a new key would make an old peer skip the op while a new peer
// put()s it - divergent views, and Autobase indexers sign the view, so a released
// space would fork. Both rows below are stored verbatim by view.put and neither
// apply branch strips unknown fields, so old peers store byte-identical values
// and merely do not INTERPRET them (they keep showing the member; cosmetic).
//   space.evicted?: { [pubkey]: { at } }  - owner evicts. Rides the `space` row,
//     which is ALREADY owner-gated in applyListOp, so this needs no new trust gate.
//   member:{pubkey}.left?: true           - member leaves. Rides their own roster
//     row, which the owner-scoped rule already lets only them write.
// Both are REVOCABLE flags, never tombstones: `deleted` hits the no-resurrection
// rule below, which would make a re-invited member permanently unrosterable.
// Hiding is not revoking: an evicted device stays an admitted Autobase writer and
// can still read the space. Real writer removal is a separate T3.

const { verifyValue } = require('@peerloom/core/records')

const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

function listKey (listId) { return 'list:' + listId }
function itemKey (listId, itemId) { return 'item:' + listId + ':' + itemId }
function memberKey (pubkey) { return 'member:' + pubkey }
const LIST_RANGE = { gt: 'list:', lt: 'list:~' }
const MEMBER_RANGE = { gt: 'member:', lt: 'member:~' }
function itemRange (listId) { return { gt: 'item:' + listId + ':', lt: 'item:' + listId + ':~' } }

const NAMESPACES = ['list:', 'item:', 'member:']
const inNamespace = (key) => typeof key === 'string' && NAMESPACES.some((n) => key.startsWith(n))

// A list's category. Presentation now (icon + grouping on the Lists page) and
// the hook completion notifications key off later (chore lists). Optional and
// additive: old peers accept and ignore it, and a list without it defaults to
// the generic 'list'. Chosen from a UI selector, NEVER inferred from the name.
const LIST_KINDS = ['grocery', 'chore', 'todo', 'list']
function normalizeKind (k) { return LIST_KINDS.includes(k) ? k : 'list' }

// Completion-notification mode for a list (the return leg of the assign loop:
// when someone checks an item, notify the list's overseer = list.assignee).
//   'off'  - never
//   'each' - on every item completion
//   'done' - once, when the last open item is checked ("all done")
// Optional + additive on the list row. Absent -> derive a default: chore lists
// default to 'done', everything else to 'off'.
const NOTIFY_MODES = ['off', 'each', 'done']
function normalizeNotifyMode (m) { return NOTIFY_MODES.includes(m) ? m : null }
function effectiveNotifyMode (list) {
  if (!list) return 'off'
  return normalizeNotifyMode(list.notifyOnComplete) || (list.kind === 'chore' ? 'done' : 'off')
}

// Accept / reject decision for a list:, item:, or member: row. Pure: takes the
// incoming signed value and whatever (if anything) is already stored at that key.
//   'accept' -> caller should view.put(key, incoming)
//   'reject' -> drop the op
//
// list: and item: rows are shared (any admitted member may edit any of them).
// member:{pubkey} rows are owner-scoped: a member may only write their OWN
// row (the roster entry that carries their name + avatar), so nobody can spoof
// another member's identity.
function rowApplyDecision (key, incoming, existing) {
  if (!inNamespace(key)) return 'reject'
  if (!incoming || typeof incoming !== 'object') return 'reject'
  if (typeof incoming.pubkey !== 'string') return 'reject'
  if (typeof incoming.updatedAt !== 'number') return 'reject'
  if (incoming.updatedAt > Date.now() + FUTURE_TS_TOLERANCE_MS) return 'reject'
  if (!verifyValue(incoming)) return 'reject'
  if (key.startsWith('member:') && key.slice('member:'.length) !== incoming.pubkey) return 'reject'

  if (existing) {
    // No resurrection: once a key is a tombstone, reject every later write.
    if (existing.deleted === true) return 'reject'
    if (typeof existing.updatedAt === 'number') {
      if (incoming.updatedAt < existing.updatedAt) return 'reject'
      // Deterministic tie-break on equal timestamps: higher signature wins, so
      // every peer converges on the same value.
      if (incoming.updatedAt === existing.updatedAt && String(incoming.sig) <= String(existing.sig)) return 'reject'
    }
  }
  return 'accept'
}

// The Autobase writer core that actually appended this block, hex. Autobase hands
// apply `node.from` = the authoring writer's core (lib/apply-state.js). Unforgeable:
// nobody can append to another writer's core. This is the ONLY trustworthy source
// for the identity -> writer-core mapping that revocation needs.
function writerKeyOf (node) {
  try {
    const k = node && node.from && node.from.key
    if (!k) return null
    return typeof k === 'string' ? k : Buffer.from(k).toString('hex')
  } catch { return null }
}

// Is every member advertising revocation support? The capability gate. Revoking a
// writer is CONSENSUS state: a peer that does not understand the op keeps the
// revoked writer in its set, keeps accepting its blocks, and SILENTLY FORKS - see
// peerloom-core test/writer-revocation.test.js ("an old-code BYSTANDER silently
// forks the space"). Nothing throws, so nothing catches it for us.
//
// `except` is the eviction target: the device we are removing is precisely the one
// that will never advertise support (it is dead or on an old build), so requiring
// IT to advertise would mean the gate never opens and the feature is useless.
const REVOKE_CAP = 'revoke1'
function hasCap (row, cap) { return !!(row && Array.isArray(row.caps) && row.caps.includes(cap)) }
function allMembersSupportRevoke (memberRows, except = []) {
  const skip = new Set(except)
  const rows = memberRows.filter((r) => r && r.pubkey && !skip.has(r.pubkey) && r.deleted !== true && r.left !== true)
  if (!rows.length) return false
  return rows.every((r) => hasCap(r, REVOKE_CAP))
}

// engine applyOps: one op at a time, in linearized order. A delete is a put of
// a { deleted: true } tombstone (kept in the view so no-resurrection holds), so
// only 'put' ops exist.
async function applyListOp (op, ctx) {
  const { view, groupId, emit } = ctx
  if (!op || op.type !== 'put' || typeof op.key !== 'string') return

  // `space` singleton: the space's owner record + tombstone. Ownership is
  // explicit and signed (robust across remounts, unlike an Autobase-internal
  // key check). The FIRST signed write claims ownership (owner must equal the
  // signer); after that only the owner may update/delete it. On a fresh delete
  // we emit space:deleted so every member's UI can tear the space down.
  if (op.key === 'space') {
    const v = op.value
    if (!v || typeof v !== 'object' || typeof v.pubkey !== 'string' || typeof v.updatedAt !== 'number') return
    if (!verifyValue(v)) return
    const existing = (await view.get('space'))?.value
    if (!existing) {
      if (v.owner !== v.pubkey) return // the claimant must name themselves owner
      await view.put('space', v)
    } else {
      if (v.pubkey !== existing.owner) return // only the established owner
      if (typeof existing.updatedAt === 'number' && v.updatedAt <= existing.updatedAt) return
      await view.put('space', v)
      if (v.deleted && !existing.deleted && typeof emit === 'function') { try { emit('space:deleted', { groupId }) } catch {} }
    }
    return
  }

  if (!inNamespace(op.key)) return
  const existing = (await view.get(op.key))?.value
  if (rowApplyDecision(op.key, op.value, existing) === 'accept') {
    let value = op.value
    // WRITER BINDING (gated by space.revokeV1; see proposals/2026-07-13-writer-
    // revocation.md). Revoking a writer needs its Autobase WRITER CORE key, but the
    // roster is keyed by IDENTITY pubkey and nothing maps between them.
    //
    // The mapping must NOT be self-declared: a member could then claim a victim's
    // writer key and have the owner's revocation remove the VICTIM instead. The only
    // unforgeable source is which core actually appended this block - you cannot
    // append to someone else's writer core - so we take it from node.from.key and
    // ignore anything the row claims.
    //
    // Recording it CHANGES THE VIEW, so it is fork-inducing and stays dormant until
    // the owner arms revokeV1 (which they may only do once every member advertises
    // support). Re-derived on every write, so it survives a republish.
    if (op.key.startsWith('member:')) {
      const meta = (await view.get('space'))?.value
      if (meta && meta.revokeV1 === true) {
        const w = writerKeyOf(ctx.node)
        if (w) value = { ...op.value, _w: w }
      }
    }
    await view.put(op.key, value)
    try { await maybeNotify(ctx, op.key, op.value, existing) } catch {}
  }
}

// Local-notification signals (policy: assignment-only + join, opt-in, no push).
// Emitted from apply so they fire exactly when a peer's change is synced, and
// reach the RN shell even if the WebView is backgrounded. The shell decides
// whether to raise an OS notification (respecting the user's opt-in). A freshness
// window skips the burst of historical rows applied during an initial catch-up
// sync, so joining/reopening a space does not replay old assignments as alerts.
const NOTIFY_FRESH_MS = 60 * 1000
async function maybeNotify (ctx, key, value, existing) {
  const { emit, selfKey, view, groupId } = ctx
  if (typeof emit !== 'function' || !selfKey) return
  if (typeof value.updatedAt !== 'number' || value.updatedAt < Date.now() - NOTIFY_FRESH_MS) return
  if (value.pubkey === selfKey) return // our own change never notifies us
  if (value.deleted) return
  if (key.startsWith('member:')) {
    // A member row we have never seen before = someone joined the space.
    if (!existing) { try { emit('notify:joined', { name: String(value.displayName || 'Someone'), pubkey: value.pubkey, groupId }) } catch {} }
    return
  }
  // Someone assigned an item OR a whole list to me (and it was not already mine).
  // `kind` lets the shell/UI phrase item vs list differently; groupId + listId
  // let a notification tap deep-link straight to the related list.
  const isItem = key.startsWith('item:')
  const isList = key.startsWith('list:')
  if ((isItem || isList) && value.assignee === selfKey) {
    const wasMine = !!existing && existing.assignee === selfKey
    if (!wasMine) {
      const kind = isItem ? 'item' : 'list'
      const text = String((isItem ? value.text : value.name) || (isItem ? 'an item' : 'a list'))
      // item key = item:{listId}:{itemId}; list key = list:{listId}
      const listId = isItem ? key.split(':')[1] : key.slice('list:'.length)
      try { emit('notify:assigned', { kind, text, by: value.pubkey, groupId, listId }) } catch {}
    }
  }
  // Completion (the return leg): someone else just checked an item on a list I
  // created. The recipient is the list's CREATOR/owner (list.createdBy), NOT the
  // assignee: the assignee is who the list belongs to (e.g. a kid), while the
  // creator (e.g. a parent) is who wants to know it got done. Fires on my own
  // device when I apply their check, per the list's notify mode. `done` scans the
  // list and only fires once the last open item is checked; the just-checked item
  // is already in the view.
  if (isItem && value.checked === true && !(existing && existing.checked === true) && view) {
    const listId = key.split(':')[1]
    const list = (await view.get('list:' + listId))?.value
    if (list && !list.deleted && list.createdBy === selfKey) {
      const mode = effectiveNotifyMode(list)
      const base = { listName: String(list.name || 'a list'), kind: list.kind || 'list', by: value.pubkey, groupId, listId }
      if (mode === 'each') {
        try { emit('notify:completed', { ...base, allDone: false, item: String(value.text || 'an item') }) } catch {}
      } else if (mode === 'done') {
        let anyOpen = false
        for await (const { value: it } of view.createReadStream(itemRange(listId))) {
          if (it && !it.deleted && !it.checked) { anyOpen = true; break }
        }
        if (!anyOpen) { try { emit('notify:completed', { ...base, allDone: true }) } catch {} }
      }
    }
  }
}

// Roster visibility. Pure, so the filter is unit-testable without an Autobase:
// takes a member row and the `space` meta and says whether it belongs in the
// roster. Every membership surface (MembersBar, the member count, the assignee
// picker) reads member:getAll, so filtering here fixes all of them at once.
//   evicted - the owner listed this pubkey in space.evicted
//   left    - the member retired their own row
//   deleted - a tombstoned row (member:getAll never filtered these; latent bug)
function isEvicted (spaceMeta, pubkey) {
  const ev = spaceMeta && spaceMeta.evicted
  return !!(ev && typeof ev === 'object' && ev[pubkey])
}
function isMemberVisible (row, spaceMeta) {
  if (!row || typeof row.pubkey !== 'string') return false
  if (row.deleted === true || row.left === true) return false
  return !isEvicted(spaceMeta, row.pubkey)
}

module.exports = { applyListOp, rowApplyDecision, listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange, FUTURE_TS_TOLERANCE_MS, LIST_KINDS, normalizeKind, NOTIFY_MODES, normalizeNotifyMode, effectiveNotifyMode, isEvicted, isMemberVisible, writerKeyOf, REVOKE_CAP, hasCap, allMembersSupportRevoke }
