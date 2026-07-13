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

// Revocation is DORMANT until the owner arms it (space.revokeV1), which they may
// only do once every other member advertises support. Before that, and for any
// space that never arms it, behaviour is exactly as before.
function armed (meta) {
  return !!(meta && meta.revokeV1 === true && typeof meta.owner === 'string')
}

// APPLY side: honour a revokeWriter op only if the OWNER signed it, for THIS group,
// on an ARMED space. Every peer runs the same check over the same replicated view,
// so a forged revocation is dropped identically everywhere.
async function authorizeRevoke (op, { view, groupId }) {
  let meta = null
  try { meta = (await view.get('space'))?.value } catch {}
  if (!armed(meta)) return false // not armed -> revocation is off entirely
  return !!(op &&
    typeof op.pubkey === 'string' &&      // the target's WRITER CORE key
    op.by === meta.owner &&               // signed by the established owner
    op.groupId === groupId &&             // bound to this group (no replay elsewhere)
    verifyValueWithSigner(op, 'by'))
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

module.exports = { authorizeRevoke, admitWriter, armed }
