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
const LIST_RANGE = { gt: 'list:', lt: 'list:~' }
function itemRange (listId) { return { gt: 'item:' + listId + ':', lt: 'item:' + listId + ':~' } }

// Accept / reject decision for a list: or item: row. Pure: takes the incoming
// signed value and whatever (if anything) is already stored at that key.
//   'accept' -> caller should view.put(key, incoming)
//   'reject' -> drop the op
function rowApplyDecision (key, incoming, existing) {
  if (typeof key !== 'string' || (!key.startsWith('list:') && !key.startsWith('item:'))) return 'reject'
  if (!incoming || typeof incoming !== 'object') return 'reject'
  if (typeof incoming.pubkey !== 'string') return 'reject'
  if (typeof incoming.updatedAt !== 'number') return 'reject'
  if (incoming.updatedAt > Date.now() + FUTURE_TS_TOLERANCE_MS) return 'reject'
  if (!verifyValue(incoming)) return 'reject'

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
  if (!op || op.type !== 'put' || typeof op.key !== 'string') return
  if (!op.key.startsWith('list:') && !op.key.startsWith('item:')) return
  const existing = (await view.get(op.key))?.value
  if (rowApplyDecision(op.key, op.value, existing) === 'accept') {
    await view.put(op.key, op.value)
  }
}

module.exports = { applyListOp, rowApplyDecision, listKey, itemKey, LIST_RANGE, itemRange, FUTURE_TS_TOLERANCE_MS }
