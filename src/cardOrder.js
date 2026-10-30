// The order of cards on the Lists page, kept per space on this phone. Device-local
// like aisle and item order (DECISIONS.md 2026-07-11): dragging a card on one
// phone does not move it on anyone else's.
//
// `saved` is the list ids in the order this phone last left them. A list not in it
// (new, or from before any drag) comes first, in the default order, so a list just
// made is in view at the top.

function orderCards (lists, saved) {
  const at = new Map((saved || []).map((id, i) => [id, i]))
  const fresh = lists.filter((l) => !at.has(l.id))
  const known = lists.filter((l) => at.has(l.id)).sort((a, b) => at.get(a.id) - at.get(b.id))
  return fresh.concat(known)
}

// Drop `id` where `targetId` is: dragged forward it lands after the target,
// dragged back it lands before it.
function moveCard (ids, id, targetId) {
  if (id === targetId) return ids.slice()
  const to = ids.indexOf(targetId)
  if (to < 0 || !ids.includes(id)) return ids.slice()
  const out = ids.filter((x) => x !== id)
  out.splice(to, 0, id)
  return out
}

module.exports = { orderCards, moveCard }
