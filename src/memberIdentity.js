// One person, many devices: proving it, and collapsing the members list.
//
// Implements proposals/2026-07-29-one-person-many-devices.md. Read the forcing
// function there before changing anything here - the point is NOT that the
// members list looks tidier. It is that `assignee` is a DEVICE key, so without
// this a chore assigned to someone with two phones notifies exactly one of them.
//
// WHY A PROOF AND NOT A HASH. The first draft of the proposal had each device
// publish a `personId` hash it derived itself. Anyone can copy a hash, so that
// would have let a device in the space claim to be someone else and start
// receiving their assignments. keet-identity-key - already a device-link
// dependency - attests a device key with the identity key derived from the
// recovery phrase, and any peer can verify the chain. Measured 2026-07-29: a
// forged proof (attacker's key, attacker's signature, against someone else's
// proof) does not verify.
//
// WHY EACH DEVICE ATTESTS ITSELF. Both phones hold the mnemonic after pairing, so
// each derives the identity and bootstraps its OWN device key - two independent
// 139-byte proofs that verify to the same root, with no coordination at pairing
// time and nothing to re-run if a device is added later.

// Via device-link, NOT keet-identity-key directly. Identity is that package's
// job, and a direct dependency here would put a SECOND copy of the library in the
// worklet bundle beside device-link's own - the same duplication that cost 1.4 MB
// elsewhere in this bundle (see TODO).
const { verifyDeviceProof } = require('@peerloom/device-link/identity')

// Verified proofs are stable for the life of a device key, and the members list
// is re-read on every space open, so re-verifying the same bytes is pure waste.
// Keyed by the proof hex; the value is the identity root hex, or null for
// "checked and it does not verify" - which must be cached too, or a malformed row
// costs a verification on every read forever.
const _cache = new Map()
const CACHE_MAX = 512

// Diagnostic trace for the collapse (2026-07-31). Wired from listMethods to the
// same channel as the pairing marks.
//
// WHY IT EXISTS: Tim joined a space as a housemate and saw TWO rows for one
// person - his two linked phones showing as two people, which is the exact thing
// this file exists to prevent. From outside, "the proofs did not verify" and "the
// proofs verify to DIFFERENT roots" look identical: both end as two unmerged
// rows. They need opposite fixes, so the log has to name which.
//
// EMITS ON CHANGE ONLY, not on every call. collapseMembers runs on every roster
// refresh - space open, every group:updated, every peer:connected and a 15s
// backstop - so an unconditional mark would flood the trace buffer that bare.js
// re-ships whole on each mark. One line per distinct outcome answers the question
// and then goes quiet.
let _trace = () => {}
let _lastCollapse = ''
function setTrace (fn) { if (typeof fn === 'function') _trace = fn }
function traceCollapse (summary) {
  const line = JSON.stringify(summary)
  if (line === _lastCollapse) return
  _lastCollapse = line
  try { _trace('collapse:members', summary) } catch {}
}

// Identity root this proof attests to, or null if it does not verify.
//
// NEVER THROWS. Every caller is handling a row written by another device, and a
// member whose proof is broken must stay visible as their own row rather than
// taking down the whole list.
async function identityRootOf (proofHex) {
  if (typeof proofHex !== 'string' || !proofHex) return null
  if (_cache.has(proofHex)) return _cache.get(proofHex)

  const info = await verifyDeviceProof(proofHex)
  const root = info ? info.identityPublicKey : null

  // Crude bound rather than an LRU: this only grows with distinct devices seen,
  // which is a handful, and an unbounded map in a long-lived worklet is a leak
  // waiting to be found the hard way.
  if (_cache.size >= CACHE_MAX) _cache.clear()
  _cache.set(proofHex, root)
  return root
}

// Collapse member rows belonging to the same person into one.
//
// Tim's call, 2026-07-29: the members list shows PEOPLE. No device count, no
// badge, no expandable row - if it would tell a housemate something about your
// hardware it does not belong here. So the returned rows deliberately carry no
// device information at all.
//
// Rows WITHOUT a verified proof are never merged - not with each other, and not
// into anyone. An absent proof is not evidence of anything, and treating two
// absences as a match would silently fuse two unrelated housemates into one
// person. That is the single way this feature could mislead someone, so it is the
// one rule with no exception.
async function collapseMembers (members) {
  const rows = Array.isArray(members) ? members : []
  const byRoot = new Map()
  const out = []
  // What each row resolved to, for the trace below. Short prefixes only: an
  // identity root is a public key, and this line reaches a log file that gets
  // pulled off the device. Enough to tell "same" from "different" and no more.
  const seenRoots = []

  for (const m of rows) {
    const root = await identityRootOf(m && m.identityProof)
    seenRoots.push({
      pk: (m && typeof m.pubkey === 'string') ? m.pubkey.slice(0, 8) : null,
      proof: !!(m && m.identityProof),
      root: root ? root.slice(0, 8) : null,
    })
    if (!root) { out.push(strip(m)); continue }

    const seen = byRoot.get(root)
    if (!seen) {
      const row = strip(m)
      // Every device key this person signs with. NOT for display - Tim's call is
      // that the members list shows people, never hardware - but an assignment
      // stores a DEVICE key, so without this a chore assigned to their other
      // phone cannot be resolved back to them and renders as "?".
      // Caught on hardware 2026-07-29, after collapse dropped the row whose
      // pubkey an existing assignment pointed at.
      row.keys = [m.pubkey]
      const entry = { row, at: stamp(m), index: out.length }
      byRoot.set(root, entry)
      out.push(row)
      continue
    }
    const keys = seen.row.keys
    if (m.pubkey && !keys.includes(m.pubkey)) keys.push(m.pubkey)
    // Same person, second device. Name and avatar come from the most recently
    // updated row, so renaming on your newer phone is what the household sees -
    // rather than whichever row happened to sort first.
    if (stamp(m) > seen.at) {
      seen.at = stamp(m)
      const row = strip(m)
      row.keys = keys // carry the accumulated set across the swap
      seen.row = row
      out[seen.index] = row
    }
  }
  // `in` vs `out` is the headline: equal means nothing merged. `rows` then says
  // WHY - a null root is a proof that did not verify (or was absent), and two
  // different roots mean the devices genuinely do not share an identity, which
  // would point at pairing rather than at this file.
  traceCollapse({ in: rows.length, out: out.length, rows: seenRoots })
  return out
}

// Device keys that belong to the same person as `selfKey`, including it. This is
// the routing half: `assignee` stays a device key on the wire, and a notification
// fires if the assignee is any of these rather than only this exact device.
async function sameIdentityKeys (members, selfKey) {
  const keys = new Set(selfKey ? [selfKey] : [])
  const rows = Array.isArray(members) ? members : []

  const mine = rows.find((m) => m && m.pubkey === selfKey)
  const myRoot = await identityRootOf(mine && mine.identityProof)
  // No proof of our own means no claim about anyone else. Falling back to "match
  // everything unproven" would route a housemate's assignments to us.
  if (!myRoot) return keys

  for (const m of rows) {
    if (!m || !m.pubkey || m.pubkey === selfKey) continue
    if (await identityRootOf(m.identityProof) === myRoot) keys.add(m.pubkey)
  }
  return keys
}

// The member row minus anything device-shaped. Keeping `identityProof` out of the
// UI's copy is not just tidiness: it is what stops a later change from rendering
// a device count that Tim explicitly decided against.
// Drops the proof (large, and nothing downstream should re-verify) and updatedAt
// (an ordering detail). `keys` is added by the caller where a row is a collapsed
// person - see the comment there for why it is not device information in the
// sense Tim ruled out.
function strip (m) {
  if (!m || typeof m !== 'object') return m
  const { identityProof, updatedAt, ...rest } = m
  return rest
}

function stamp (m) {
  return (m && typeof m.updatedAt === 'number') ? m.updatedAt : 0
}

module.exports = { identityRootOf, collapseMembers, sameIdentityKeys, setTrace, _cache }
