// Writer-revocation policy. Plugged into the @peerloom/core engine as its
// authorizeRevoke (apply side) + admitWriter (apply side) hooks.
// See proposals/2026-07-13-writer-revocation.md.
//
// Both hooks are DETERMINISTIC - they decide only from replicated view state (the
// signed `space` row), so every peer reaches the same answer at the same point in
// the log. That is not a nicety: writer membership is consensus state, and a peer
// that disagrees silently forks the space (peerloom-core
// test/writer-revocation.test.js).

const { verifyValueWithSigner } = require('@peerloom/core/records')
const { MEMBER_RANGE } = require('./listWire')
const { identityRootOf } = require('./memberIdentity')

// Revocation is DORMANT until the owner arms it (space.revokeV1), which they may
// only do once every other member advertises support. Before that, and for any
// space that never arms it, behaviour is exactly as before.
function armed (meta) {
  return !!(meta && meta.revokeV1 === true && typeof meta.owner === 'string')
}
// Self-revocation is armed SEPARATELY (space.revokeV2), because honouring a
// same-identity revocation is a different rule that an old peer would decide
// differently - and disagreement about the writer set forks the space rather than
// erroring. revokeV2 implies revokeV1: there is no sane space that accepts a
// same-identity revocation but not an owner's.
function armedSelf (meta) {
  return !!(armed(meta) && meta.revokeV2 === true)
}

// Does `signerPubkey` prove it is the SAME PERSON as the device whose writer core is
// `targetWriterKey`? The self-revocation rule: you may evict your own phone.
//
// DETERMINISTIC, which is the requirement that shapes all of it. Every input comes
// from the replicated view - member rows, their `identityProof`, and the `_w` writer
// binding that apply derived from the authoring core. `identityRootOf` is pure crypto
// over those bytes. So every peer reaches the same verdict at the same point in the
// log, which is what keeps this from forking.
//
// TWO KEY SPACES MEET HERE and conflating them would be a security bug: member rows
// are keyed by IDENTITY pubkey, while a revocation names the target's WRITER CORE key
// (`_w`). So the target is found by matching `_w`, never by trusting anything the op
// claims about who it is.
async function provesSamePerson (view, signerPubkey, targetWriterKey) {
  if (typeof signerPubkey !== 'string' || typeof targetWriterKey !== 'string') return false
  let signerProof = null
  let targetProof = null
  try {
    for await (const { value } of view.createReadStream(MEMBER_RANGE)) {
      if (!value || typeof value.pubkey !== 'string') continue
      if (value.pubkey === signerPubkey) signerProof = value.identityProof
      if (value._w === targetWriterKey) targetProof = value.identityProof
    }
  } catch { return false }

  // No proof on either side means nothing is proven. Absence is never a match - the
  // same rule the members collapse follows, and for the same reason: treating two
  // absences as equal would let any member revoke any other.
  if (!signerProof || !targetProof) return false
  const [signerRoot, targetRoot] = await Promise.all([
    identityRootOf(signerProof), identityRootOf(targetProof),
  ])
  return !!(signerRoot && targetRoot && signerRoot === targetRoot)
}

// APPLY side: honour a revokeWriter op if it is signed, bound to THIS group, on an
// ARMED space, and authored by EITHER
//   - the established owner (the original rule, unchanged), or
//   - a device that PROVES it is the same person as the target, on a space that has
//     additionally armed revokeV2.
// Every peer runs the same check over the same replicated view, so a forged
// revocation is dropped identically everywhere.
async function authorizeRevoke (op, { view, groupId }) {
  let meta = null
  try { meta = (await view.get('space'))?.value } catch {}
  if (!armed(meta)) return false // not armed -> revocation is off entirely

  // Shape + signature first, so an unsigned or cross-group op never reaches the
  // more expensive identity check.
  if (!(op &&
    typeof op.pubkey === 'string' &&      // the target's WRITER CORE key
    typeof op.by === 'string' &&
    op.groupId === groupId &&             // bound to this group (no replay elsewhere)
    verifyValueWithSigner(op, 'by'))) return false

  if (op.by === meta.owner) return true   // the owner, exactly as before

  if (!armedSelf(meta)) return false      // self-revocation not armed on this space
  // You may revoke your own device. You may not revoke a housemate's.
  return await provesSamePerson(view, op.by, op.pubkey)
}

// APPLY side: once a space is armed, new writers are admitted as NON-indexers - they
// can still write, they just do not sign the view, so revoking one never touches the
// indexer set. Before arming (and for spaces that never arm), admit as an indexer:
// that is the legacy behaviour, and changing it for an un-armed space would itself
// fork old peers.
async function admitWriter (op, { view }) {
  let meta = null
  try { meta = (await view.get('space'))?.value } catch {}
  return armed(meta) ? { indexer: false } : { indexer: true }
}

module.exports = { authorizeRevoke, admitWriter, armed, armedSelf, provesSamePerson }
