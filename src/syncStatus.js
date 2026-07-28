// Why a space is showing nothing, in the user's terms.
//
// A device that joined but has not been admitted as a writer looks EXACTLY like a
// device that is simply new: a space with a name and nothing in it. The name
// rides the invite, so it proves only that the invite parsed - not that a single
// byte ever arrived. Until this existed the app said nothing about either state,
// which left the user with one available conclusion: the app is broken.
//
// Reported 2026-07-28 by a user who reinstalled, rejoined from a member's invite,
// and got a space name with no members and no lists. See space:status in
// listMethods.js for what the three states are and how they are read.
//
// Pure so the copy is unit-tested rather than eyeballed, same as digestText and
// nextCollapseState.

// ONLY fires when this device cannot write to the space, which is exactly when a
// joiner has not been admitted yet.
//
// Deliberately NOT tied to being offline. A household adds groceries with the
// other phone asleep all the time; that write lands locally and syncs later, so
// flagging it would put a warning on a space that is working perfectly. Being
// alone is normal. Being unable to write is not.
//
// The two cases differ only in the advice, because the remedy differs: with
// nothing arriving there is nobody to do the approving and the user has to go get
// the other phone; once the space's own data is landing, the approval is in flight
// and the answer is to wait.
//
// The discriminator is WHETHER THIS SPACE'S DATA HAS ARRIVED, not the connection
// count. `conns` is swarm-wide - Hyperswarm gives one connection per peer and every
// mounted group shares it - so a device sitting in one working space and one
// stalled space reports connections for both, and a rule built on it tells the
// stalled space to keep waiting for an approval that is never coming. Measured on
// the TCL 2026-07-28: exactly that, a fabricated invite to a space nobody hosts
// read as "waiting" because an unrelated peer was connected. A member row or a
// list, on the other hand, can only have come from a peer in THIS space.
function syncTrouble (status) {
  if (!status || status.writable) return null
  const arrived = (status.members || 0) > 0 || (status.lists || 0) > 0
  return arrived
    ? {
        title: 'Waiting to be let in',
        body: 'Someone already in this space has to approve this phone before it can add anything. Keep both phones open on PearList and it should happen on its own.',
      }
    : {
        title: 'Not connected yet',
        body: 'Nothing from this space has reached this phone. Open PearList on another member\'s phone, on the same wifi if you can, and leave both open for a minute.',
      }
}

module.exports = { syncTrouble }
