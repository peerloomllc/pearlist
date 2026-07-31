// Which roster row is ME, and which device keys are mine - for the UI.
//
// THE TRAP THIS EXISTS TO CLOSE. The members list shows PEOPLE: collapseMembers
// merges someone's phones into one row and that row's `pubkey` is whichever device
// wrote most recently (src/memberIdentity.js). So `m.pubkey === selfPubkey` - the
// obvious test, and the one written at four separate places in App.jsx - is wrong on
// any phone linked to another: your own row regularly carries your OTHER phone's key,
// and then the UI stops recognising you. It offered a Remove button on yourself, hid
// "(You)", and refused to delete a chore list you had created on your other phone.
//
// Pure and dependency-free so it unit-tests without React and without pulling the
// identity library into the WebView bundle. The proofs are verified in the worklet;
// by the time a row reaches the UI, `keys` is the answer it already computed.
//
// See proposals/2026-07-29-one-person-many-devices.md.

// Is this collapsed member row me?
function isMyRow (m, selfPubkey) {
  if (!m || !selfPubkey) return false
  if (m.pubkey === selfPubkey) return true
  return Array.isArray(m.keys) && m.keys.includes(selfPubkey)
}

// Every device key I sign with, from my own collapsed row.
//
// FALLS BACK TO JUST THIS DEVICE when the roster has not loaded yet, when my row
// carries no verified proof, or when I am not in the list at all. That is the same
// "an absence is never a match" rule the collapse follows: an unlinked phone must
// behave exactly as it did before, never as though it spoke for extra keys.
function myDeviceKeys (members, selfPubkey) {
  const mine = (Array.isArray(members) ? members : []).find((m) => isMyRow(m, selfPubkey))
  if (mine && Array.isArray(mine.keys) && mine.keys.length) return mine.keys
  return selfPubkey ? [selfPubkey] : []
}

// Was this row written by one of my phones? The question behind "did I create this
// list", where the stored value is a single device key.
function isMine (members, selfPubkey, pubkey) {
  if (!pubkey) return false
  return myDeviceKeys(members, selfPubkey).includes(pubkey)
}

module.exports = { isMyRow, myDeviceKeys, isMine }
