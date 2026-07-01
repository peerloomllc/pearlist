// PearList merge rules (the tripWire.js analog). Pure, so they unit-test
// without standing up a real Autobase. Plugged into the @peerloom/core engine
// as its applyOps.
//
// Data model (one household group, many lists):
//   list:{listId}            -> signed { id, name, createdBy, createdAt,
//                                        updatedAt, pubkey, deleted }
//   item:{listId}:{itemId}   -> signed { id, listId, text, qty, checked,
//                                        assignee?, createdBy, createdAt,
//                                        updatedAt, pubkey, deleted }
//
// Items are keyed by a content id, NOT by author, so ANY household member can
// check / edit / delete ANY item (the shared-list UX). See pearlist
// DECISIONS.md 2026-06-30. `pubkey` records the LAST editor and the signature
// proves it; concurrent edits resolve last-writer-wins.

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

// engine applyOps: one op at a time, in linearized order. A delete is a put of
// a { deleted: true } tombstone (kept in the view so no-resurrection holds), so
// only 'put' ops exist.
async function applyListOp (op, { view }) {
  if (!op || op.type !== 'put' || !inNamespace(op.key)) return
  const existing = (await view.get(op.key))?.value
  if (rowApplyDecision(op.key, op.value, existing) === 'accept') {
    await view.put(op.key, op.value)
  }
}

module.exports = { applyListOp, rowApplyDecision, listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange, FUTURE_TS_TOLERANCE_MS }
