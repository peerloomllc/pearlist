// PearList "tidy finished aisles" (GH #90): the pure decision behind auto-collapse.
//
// When the device-local setting is on, a grocery aisle (or a section on any other
// grouped list) folds itself away once every item in it is checked off, and comes
// back when something in it is unchecked.
//
// WHY THIS IS TRANSITION-BASED AND NOT A STANDING RULE. "Every finished group is
// collapsed" as a standing rule fights the user: hand-expand a finished aisle to
// look at what you already grabbed and the next render shuts it again. So the
// caller keeps the set of groups that were finished on the previous pass, and only
// a group that has just BECOME finished gets collapsed. `prevDone === null` marks
// the first pass for a list, which is the one time we act on the standing state -
// that is what makes a half-shopped list open with its done aisles already closed.
//
// `auto` is the subset of `collapsed` that this rule closed. Only those reopen on
// uncheck; a group the user collapsed by hand (or via collapse-all) is left as
// they left it, which is why the caller drops a group from `auto` whenever the
// user taps its header.
//
// Purely presentational and device-local, like the rest of the collapse/reorder
// state (see the 2026-07-11 hybrid decision): nothing here is synced.

const aisles = require('./aisles.js')

// The groups with at least one item and nothing left unchecked. An empty group
// never counts as finished (it renders nothing at all).
function finishedGroups (items) {
  const tally = new Map()
  for (const it of items || []) {
    const key = aisles.bucketOf(it.category)
    const g = tally.get(key) || { total: 0, open: 0 }
    g.total++
    if (!it.checked) g.open++
    tally.set(key, g)
  }
  return new Set([...tally].filter(([, g]) => g.total > 0 && g.open === 0).map(([k]) => k))
}

// items    - the open list's rows ({ category, checked })
// prevDone - Set of groups finished on the previous pass, or null for the first
//            pass on a list (acts on the standing state instead of a transition)
// collapsed, auto - the current device-local view state, as arrays
//
// Returns { done, collapsed, auto, changed }. `done` is the new baseline for the
// caller to keep; `changed` is false when there is nothing to write, so the caller
// can skip the state update entirely.
function nextCollapseState ({ items, prevDone, collapsed, auto }) {
  const done = finishedGroups(items)
  const nextCollapsed = new Set(collapsed || [])
  const nextAuto = new Set(auto || [])
  let changed = false

  for (const g of done) {
    if ((prevDone && prevDone.has(g)) || nextCollapsed.has(g)) continue // finished before this pass, or already closed
    nextCollapsed.add(g)
    nextAuto.add(g)
    changed = true
  }
  for (const g of prevDone || []) {
    if (done.has(g) || !nextAuto.has(g)) continue // still finished, or not ours to reopen
    nextCollapsed.delete(g)
    nextAuto.delete(g)
    changed = true
  }

  return { done, collapsed: [...nextCollapsed], auto: [...nextAuto], changed }
}

module.exports = { finishedGroups, nextCollapseState }
