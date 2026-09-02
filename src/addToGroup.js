// PearList "add straight into a group": the pure decision behind the "+" that
// sits on every group header inside a list.
//
// Asked for by a user (2026-09-02): the composer at the bottom adds an item and
// then the app decides where it goes, so filing a thing under the group you were
// already looking at meant adding it, finding it wherever the keyword classifier
// put it, and dragging it back. The header "+" aims the composer at that group
// instead, and the item is filed as it is written.
//
// WHY THIS IS ITS OWN MODULE. Two of the three add paths in App.jsx are already
// deciding a category (the learned-override path behind the grocery quantity
// sheet is one of them), and the rules below are exactly where a "+" add differs
// from an ordinary one. Keeping the decision pure means it is stated once and
// tested directly, rather than living twice inside a 4000-line component.
//
// THE RULES:
//
// 1. A group the user just pointed at wins over anything the app inferred. The
//    learned override ("you always put oat milk in Fridge") is a good guess about
//    an item typed into the ordinary composer; it is not better information than
//    a tap on the Produce header a second ago.
// 2. 'Other' is a real, pinnable aisle on a grocery list, because the keyword
//    classifier would otherwise file the item somewhere else and the user would
//    have to drag it back. That is the whole point of catBy: 'user' in
//    ai:setCategory.
// 3. On any other kind of list there is no classifier and no built-in taxonomy,
//    so the fallback group is not a group at all - it is just "no section". A "+"
//    there adds an item with no category, and no override may re-file it, since
//    the user has said where it goes.

const { FALLBACK } = require('./aisles')

// The category a "+"-driven add writes, or null when the user aimed at a group
// that means "no category". `aisle` is the group whose header was tapped.
function pinnedCategory (aisle, isGrocery) {
  if (!aisle) return null
  return (aisle === FALLBACK && !isGrocery) ? null : aisle
}

// The category a new item should be filed under: the group its "+" came from,
// else the device's learned override for that text, else nothing (the keyword
// classifier will have its say on a grocery list, via ai:categorizeList).
function addCategory ({ aisle = null, isGrocery = false, override = null } = {}) {
  if (aisle) return pinnedCategory(aisle, isGrocery)
  return override || null
}

module.exports = { pinnedCategory, addCategory }
