// PearList "Checked items last" (GH #249): open items first, ticked ones after.
//
// Asked for by a daily shopper: on a long list the items still to get were
// scattered between ones already in the basket. With the setting on, each list
// (or each aisle or section of a grouped list) shows its open items in their
// usual order, then its ticked items in theirs.
//
// The partition is stable on both sides, so the device-local item order a drag
// writes still means the same thing with the setting on or off. The drag commit in
// App.jsx applies the same partition before it splices, because the drop index it
// gets is a position in what is on screen.
//
// Device-local and purely presentational, like autoCollapse: nothing is synced.

function checkedLast (rows) {
  const open = []
  const done = []
  for (const it of rows || []) (it.checked ? done : open).push(it)
  return open.concat(done)
}

module.exports = { checkedLast }
