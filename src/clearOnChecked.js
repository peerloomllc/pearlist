// PearList "Clear when checked": the pure decision behind delete-on-check.
//
// Asked for by a user in Vienna (2026-08-06): a shopping list they run every week
// only ever grows, because a checked item keeps its row and its strike-through
// forever. With the setting on, ticking an item off removes it instead.
//
// WHY THIS IS ITS OWN MODULE, tiny as it is. The rule has three exceptions and one
// of them is destructive: this is the only place in the app where a plain tap
// deletes shared data. Keeping the decision pure means the exceptions are stated
// once, tested directly, and cannot drift as the caller in App.jsx grows.
//
// THE SETTING IS DEVICE-LOCAL, LIKE autoCollapse - BUT ITS EFFECT IS NOT. Deleting
// an item is a signed append with a no-resurrection tombstone (see listWire.js), so
// it lands on every phone in the space whether or not they turned this on. That
// asymmetry is deliberate and is spelled out in the setting's About text: a local
// preference about how YOUR list looks would be a hide, and a hide leaves everyone
// else's list growing, which is the complaint. The undo bar is the safety net.
//
// THE THREE EXCEPTIONS:
//
// 1. Unchecking never deletes. The rule fires on the transition INTO checked, not
//    on the standing state, so nothing already checked when you turn the setting on
//    is touched either - a settings change must never destroy data on its own.
// 2. Chore lists are left alone. They are recurring and parent-owned, and the list
//    screen offers Reset (uncheck everything) precisely so the same chores come
//    round again next week. Clearing them would mean retyping the chores every
//    time a child ticked them off. The listComplete sheet already carves chore
//    lists out for the same reason.
// 3. Nothing happens with the setting off, which is the default. An update must not
//    change how anyone's list behaves until they ask for it.

// on       - the device-local setting
// checked  - the state the item is moving TO (true when it is being ticked off)
// listKind - the open list's kind ('shopping', 'chore', 'note', ...)
function shouldClear ({ on, checked, listKind }) {
  if (!on) return false
  if (!checked) return false
  if (listKind === 'chore') return false
  return true
}

module.exports = { shouldClear }
