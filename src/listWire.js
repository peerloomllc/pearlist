// PearList merge rules (the tripWire.js analog). Pure, so they unit-test
// without standing up a real Autobase. Plugged into the @peerloom/core engine
// as its applyOps.
//
// Data model (one household group, many lists):
//   list:{listId}            -> signed { id, name, kind?, assignee?, createdBy,
//                                        createdAt, updatedAt, pubkey, deleted }
//   item:{listId}:{itemId}   -> signed { id, listId, text, qty, checked,
//                                        assignee?, category?, catBy?, ord?,
//                                        createdBy, createdAt, updatedAt,
//                                        pubkey, deleted }
//
// `ord` is an optional fractional index used only by note lists (kind 'note'),
// where a line's position must be the SAME on every device - unlike itemOrder,
// which is a device-local preference. Additive like `category`: it rides through
// applyOps as a plain signed field, old peers ignore it and keep sorting by
// createdAt, and no merge rule is needed. See noteText.js.
//
// `category` is an optional grocery-aisle label (see aisles.js) written by the
// ai:categorize methods. Additive: it rides through applyOps like any other
// signed field, so old peers accept + ignore it and non-grocery lists never
// show it. No dedicated merge rule needed. `catBy` ('user' when set) marks a
// category the user chose by hand (drag or the item-detail aisle picker); the AI
// fallback skips catBy:'user' items, so a manual choice - including resting an
// item under 'Other' on purpose - is never re-sorted. Also additive.
//
// Items are keyed by a content id, NOT by author, so ANY household member can
// check / edit / delete ANY item (the shared-list UX). See pearlist
// DECISIONS.md 2026-06-30. `pubkey` records the LAST editor and the signature
// proves it; concurrent edits resolve last-writer-wins.
//
// MEMBERSHIP REMOVAL (proposals/2026-07-13-space-member-eviction.md). Two additive
// fields, deliberately NOT a new namespace: applyListOp drops keys outside
// NAMESPACES, so a new key would make an old peer skip the op while a new peer
// put()s it - divergent views, and Autobase indexers sign the view, so a released
// space would fork. Both rows below are stored verbatim by view.put and neither
// apply branch strips unknown fields, so old peers store byte-identical values
// and merely do not INTERPRET them (they keep showing the member; cosmetic).
//   space.evicted?: { [pubkey]: { at } }  - owner evicts. Rides the `space` row,
//     which is ALREADY owner-gated in applyListOp, so this needs no new trust gate.
//   member:{pubkey}.left?: true           - member leaves. Rides their own roster
//     row, which the owner-scoped rule already lets only them write.
// Both are REVOCABLE flags, never tombstones: `deleted` hits the no-resurrection
// rule below, which would make a re-invited member permanently unrosterable.
// Hiding is not revoking: an evicted device stays an admitted Autobase writer and
// can still read the space. Real writer removal is a separate T3.

const b4a = require('b4a')
const { verifyValue } = require('@peerloom/core/records')

const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

function listKey (listId) { return 'list:' + listId }
function itemKey (listId, itemId) { return 'item:' + listId + ':' + itemId }
function memberKey (pubkey) { return 'member:' + pubkey }
const LIST_RANGE = { gt: 'list:', lt: 'list:~' }
const MEMBER_RANGE = { gt: 'member:', lt: 'member:~' }
const { sameIdentityKeys, identityRootOf } = require('./memberIdentity')

// Does `candidate` prove the same identity root as `ownerPubkey`? The gate on the
// same-identity ownership transfer in the `space` branch, and - since 2026-07-31 -
// the gate the CLIENT reuses to decide whether the owner's other phone may manage
// the space at all (canActAsOwner in listMethods.js).
//
// EXPORTED SO THE TWO CANNOT DRIFT. The client must accept exactly what apply
// accepts and no more: a write apply drops is not a refusal the user sees, it is a
// success the UI reports and every peer discards.
//
// DETERMINISTIC: both proofs come from replicated member rows and identityRootOf is
// pure crypto over those bytes, so every peer reaches the same answer. An ABSENT
// proof on either side is never a match - the same rule the members collapse follows,
// because treating two absences as equal would let any member take the space.
async function sameIdentityAsOwner (view, candidate, ownerPubkey) {
  if (typeof candidate !== 'string' || typeof ownerPubkey !== 'string') return false
  if (candidate === ownerPubkey) return true
  let candProof = null
  let ownerProof = null
  try {
    for await (const { value } of view.createReadStream(MEMBER_RANGE)) {
      if (!value || typeof value.pubkey !== 'string') continue
      if (value.pubkey === candidate) candProof = value.identityProof
      if (value.pubkey === ownerPubkey) ownerProof = value.identityProof
    }
  } catch { return false }
  if (!candProof || !ownerProof) return false
  const [a, b] = await Promise.all([identityRootOf(candProof), identityRootOf(ownerProof)])
  return !!(a && b && a === b)
}
function itemRange (listId) { return { gt: 'item:' + listId + ':', lt: 'item:' + listId + ':~' } }

const NAMESPACES = ['list:', 'item:', 'member:']
const inNamespace = (key) => typeof key === 'string' && NAMESPACES.some((n) => key.startsWith(n))

// A list's category. Presentation now (icon + grouping on the Lists page) and
// the hook completion notifications key off later (chore lists). Optional and
// additive: old peers accept and ignore it, and a list without it defaults to
// the generic 'list'. Chosen from a UI selector, NEVER inferred from the name.
//
// 'note' is a free-text note rather than a checklist (proposals/2026-07-20-note-
// lists.md). Its body is stored as one ordinary item: row per LINE, carrying the
// optional `ord` fractional index below; see noteText.js for why lines and not
// one blob. Compat: normalizeKind runs ONLY on the local write path (list:create,
// list:setKind), never on apply, and applyListOp stores rows verbatim, so an old
// peer accepts a kind:'note' row byte-identically and merely renders it as a
// generic list. No divergence, no fork.
const LIST_KINDS = ['grocery', 'chore', 'todo', 'note', 'list']
function normalizeKind (k) { return LIST_KINDS.includes(k) ? k : 'list' }

// Completion-notification mode for a list (the return leg of the assign loop:
// when someone checks an item, notify the list's overseer = list.assignee).
//   'off'  - never
//   'each' - on every item completion
//   'done' - once, when the last open item is checked ("all done")
// Optional + additive on the list row. Absent -> derive a default: chore lists
// default to 'done', everything else to 'off'.
const NOTIFY_MODES = ['off', 'each', 'done']
function normalizeNotifyMode (m) { return NOTIFY_MODES.includes(m) ? m : null }
function effectiveNotifyMode (list) {
  if (!list) return 'off'
  return normalizeNotifyMode(list.notifyOnComplete) || (list.kind === 'chore' ? 'done' : 'off')
}

// Accept / reject decision for a list:, item:, or member: row. Pure: takes the
// incoming signed value and whatever (if anything) is already stored at that key.
//   'accept' -> caller should view.put(key, incoming)
//   'reject' -> drop the op
//
// list: and item: rows are shared (any admitted member may edit any of them).
// member:{pubkey} rows are owner-scoped: a member may only write their OWN
// row (the roster entry that carries their name + avatar), so nobody can spoof
// another member's identity.
function rowApplyDecision (key, incoming, existing) {
  if (!inNamespace(key)) return 'reject'
  if (!incoming || typeof incoming !== 'object') return 'reject'
  if (typeof incoming.pubkey !== 'string') return 'reject'
  if (typeof incoming.updatedAt !== 'number') return 'reject'
  if (incoming.updatedAt > Date.now() + FUTURE_TS_TOLERANCE_MS) return 'reject'
  if (!verifyValue(incoming)) return 'reject'
  if (key.startsWith('member:') && key.slice('member:'.length) !== incoming.pubkey) return 'reject'

  if (existing) {
    // No resurrection: once a key is a tombstone, reject every later write.
    if (existing.deleted === true) return 'reject'
    if (typeof existing.updatedAt === 'number') {
      if (incoming.updatedAt < existing.updatedAt) return 'reject'
      // Deterministic tie-break on equal timestamps: higher signature wins, so
      // every peer converges on the same value.
      if (incoming.updatedAt === existing.updatedAt && String(incoming.sig) <= String(existing.sig)) return 'reject'
    }
  }
  return 'accept'
}

// The Autobase writer core that actually appended this block, hex. Autobase hands
// apply `node.from` = the authoring writer's core (lib/apply-state.js). Unforgeable:
// nobody can append to another writer's core. This is the ONLY trustworthy source
// for the identity -> writer-core mapping that revocation needs.
function writerKeyOf (node) {
  try {
    const k = node && node.from && node.from.key
    if (!k) return null
    return typeof k === 'string' ? k : Buffer.from(k).toString('hex')
  } catch { return null }
}

// Is every member advertising revocation support? The capability gate. Revoking a
// writer is CONSENSUS state: a peer that does not understand the op keeps the
// revoked writer in its set, keeps accepting its blocks, and SILENTLY FORKS - see
// peerloom-core test/writer-revocation.test.js ("an old-code BYSTANDER silently
// forks the space"). Nothing throws, so nothing catches it for us.
//
// `except` is the eviction target: the device we are removing is precisely the one
// that will never advertise support (it is dead or on an old build), so requiring
// IT to advertise would mean the gate never opens and the feature is useless.
const REVOKE_CAP = 'revoke1'

// SELF-REVOCATION support: a device may revoke ANOTHER OF ITS OWN, proven by the
// identity attestation on the member rows rather than by being the space owner.
// See proposals/2026-07-29-removing-a-phone-should-remove-it.md.
//
// A SEPARATE capability from revoke1, and it has to be. An old peer that
// understands revoke1 accepts an owner-signed revocation but would REJECT a
// same-identity one, so the two compute different writer sets and the space forks -
// exactly what the capability system exists to prevent. Widening revoke1 in place
// would have been the silent-fork bug, not a shortcut.
const REVOKE_SELF_CAP = 'revoke2'

// PROMOTING YOUR OWN OTHER PHONE TO AN INDEXER. A THIRD capability, and it has to
// be, for the same reason as the first two: a peer that does not do it computes a
// different INDEXER SET from the same log, and the indexer set decides who signs
// the view. That is consensus divergence, i.e. a fork.
//
// WHY IT EXISTS. Autobase refuses to remove the last indexer, and `admitWriter`
// admits every post-arming writer as a non-indexer - deliberately, so revoking a
// housemate never touches the indexer set. The consequence nobody wrote down: the
// device that CREATED a space is its only indexer, forever, so it can never be cut
// off. That is the worst phone for it to be, because the phone that made the
// household space is usually the person's main one - the one whose loss sends
// someone looking for "remove this device". Found on hardware 2026-07-30: a removal
// reported success while the removed phone kept editing.
// See proposals/2026-07-30-the-space-creator-cannot-be-removed.md.
//
// DELIBERATELY NARROW: only the OWNER'S OWN devices are promoted, proven by the
// identity attestation. A housemate stays a non-indexer, which keeps the property
// the non-indexer rule was chosen for. So a person's phones can always cover for
// each other, and a housemate's revocation still never disturbs signing.
const PROMOTE_CAP = 'promote1'

function hasCap (row, cap) { return !!(row && Array.isArray(row.caps) && row.caps.includes(cap)) }

// Do all members (bar the eviction target) advertise `cap`?
//
// `except` is the eviction target: the device being removed is precisely the one
// that will never advertise support (it is dead or on an old build), so requiring IT
// to advertise would mean the gate never opens and the feature is useless.
function allMembersSupportCap (memberRows, cap, except = []) {
  const skip = new Set(except)
  const rows = memberRows.filter((r) => r && r.pubkey && !skip.has(r.pubkey) && r.deleted !== true && r.left !== true)
  if (!rows.length) return false
  return rows.every((r) => hasCap(r, cap))
}
// Kept as-is so every existing caller and test is untouched.
function allMembersSupportRevoke (memberRows, except = []) {
  return allMembersSupportCap(memberRows, REVOKE_CAP, except)
}
function allMembersSupportSelfRevoke (memberRows, except = []) {
  return allMembersSupportCap(memberRows, REVOKE_SELF_CAP, except)
}
function allMembersSupportPromote (memberRows, except = []) {
  return allMembersSupportCap(memberRows, PROMOTE_CAP, except)
}

// Diagnostic trace for the promotion gate. `ctx.mark` is threaded in from the
// worklet (src/bare.js) and lands in the same pair-trace buffer as the pairing
// marks, so one pulled log shows the pairing and what the promotion made of it.
// Absent in tests and anywhere else that calls applyListOp directly, hence the
// typeof guard rather than a required ctx field.
//
// RATE LIMITED, not deduplicated. This runs on every member write and a catch-up
// sync applies a burst of them, while bare.js re-ships the WHOLE trace buffer on
// each mark - so an unconditional mark is quadratic in a way the existing one-shot
// marks are not. Marking the 1st, 2nd, 5th, 10th, 20th... occurrence of each
// (reason, device) pair keeps that logarithmic while still showing whether a branch
// bailed once or keeps bailing, which is exactly the open question.
const _promoteMarks = new Map()
function promoteMark (ctx, reason, extra) {
  if (typeof ctx?.mark !== 'function') return
  const key = reason + '|' + ((extra && extra.pk) || '')
  const n = (_promoteMarks.get(key) || 0) + 1
  _promoteMarks.set(key, n)
  const decade = Math.pow(10, Math.floor(Math.log10(n)))
  if (n !== decade && n !== decade * 2 && n !== decade * 5) return
  try { ctx.mark('promote:' + reason, { n, ...extra }) } catch {}
}

// Promote a member's writer core to an INDEXER when it is one of the OWNER'S own
// phones. Called from apply, on the member write, once promoteV1 is armed.
//
// WHAT IT FIXES: Autobase will not remove the last indexer, so a space whose only
// indexer is its creator can never have that creator cut off. Giving the owner's
// second phone a signature makes the pair cover for each other, so either can be
// removed. Measured before it was written: promoting a non-indexer via addWriter
// with `indexer: true` makes the former sole indexer removeable, its revocation then
// takes effect, and the promoted device keeps writing.
//
// NARROW ON PURPOSE. A housemate is NOT promoted: keeping them a non-indexer is
// exactly why post-arming writers are admitted that way, so that revoking one never
// disturbs who signs the view. This only ever adds the owner's own devices.
//
// IDEMPOTENT. addWriter for a key that is already an indexer is a no-op, and this
// runs on every member write, so a row republished a hundred times promotes once in
// effect. Deliberate: there is no "is it already an indexer" read that is safe to
// branch on inside apply, because indexed state LAGS and two peers could read it
// differently - which would be the very fork this is gated to avoid.
//
// EVERY EXIT IS TRACED (2026-07-31). This ran on hardware with linking on, with
// every precondition apparently satisfied, and promoted nothing in 15 minutes -
// and the log could not say why, because each early return below was silent. That
// is the house pattern: the bug is something failing quietly. `promote:*` marks
// now name the branch that bailed, so the next run answers it. See TODO.
async function maybePromoteOwnDevice (ctx, view, row) {
  const { base } = ctx
  if (!base || typeof base.addWriter !== 'function') { promoteMark(ctx, 'no-base'); return }
  if (!row || typeof row.pubkey !== 'string') { promoteMark(ctx, 'no-pubkey'); return }
  const pk = row.pubkey.slice(0, 8)
  promoteMark(ctx, 'enter', { pk })
  // Split out from the pubkey check so the log distinguishes them: no `_w` means the
  // writer binding was never recorded, i.e. the space is not revokeV1-armed or this
  // row predates arming - a completely different fix from a failing identity proof.
  if (typeof row._w !== 'string') { promoteMark(ctx, 'no-writer-key', { pk }); return }

  const meta = (await view.get('space'))?.value
  if (!meta) { promoteMark(ctx, 'no-space-row', { pk }); return }
  if (meta.promoteV1 !== true) { promoteMark(ctx, 'not-armed', { pk, revokeV1: meta.revokeV1 === true }); return }
  if (typeof meta.owner !== 'string') { promoteMark(ctx, 'no-owner', { pk }); return }
  if (row.pubkey === meta.owner) { promoteMark(ctx, 'is-owner', { pk }); return }        // already the indexer we have
  if (isEvicted(meta, row.pubkey)) { promoteMark(ctx, 'evicted', { pk }); return }       // not a device we want signing

  // The whole gate: does this member prove the same person as the owner?
  if (!await sameIdentityAsOwner(view, row.pubkey, meta.owner)) {
    promoteMark(ctx, 'not-same-identity', { pk, owner: meta.owner.slice(0, 8), proof: typeof row.identityProof === 'string' })
    return
  }

  promoteMark(ctx, 'promoting', { pk })
  await base.addWriter(b4a.from(row._w, 'hex'), { indexer: true })
  promoteMark(ctx, 'promoted', { pk, writable: !!base.writable })
}

// engine applyOps: one op at a time, in linearized order. A delete is a put of
// a { deleted: true } tombstone (kept in the view so no-resurrection holds), so
// only 'put' ops exist.
async function applyListOp (op, ctx) {
  const { view, groupId, emit } = ctx
  if (!op || op.type !== 'put' || typeof op.key !== 'string') return

  // `space` singleton: the space's owner record + tombstone. Ownership is
  // explicit and signed (robust across remounts, unlike an Autobase-internal
  // key check). The FIRST signed write claims ownership (owner must equal the
  // signer); after that only the owner may update/delete it. On a fresh delete
  // we emit space:deleted so every member's UI can tear the space down.
  if (op.key === 'space') {
    const v = op.value
    if (!v || typeof v !== 'object' || typeof v.pubkey !== 'string' || typeof v.updatedAt !== 'number') return
    if (!verifyValue(v)) return
    const existing = (await view.get('space'))?.value
    if (!existing) {
      if (v.owner !== v.pubkey) return // the claimant must name themselves owner
      await view.put('space', v)
    } else {
      // Normally only the established owner may touch this row. The ONE exception is
      // a same-identity OWNERSHIP TRANSFER: another of the owner's own phones may
      // take it over, proven by the identity attestation on the member rows.
      //
      // WHY THIS IS NOT A SEIZURE BUTTON, which is what got ownership recovery
      // declined in July (proposals/2026-07-28-space-ownership-recovery.md): that
      // was about letting SOMEBODY ELSE claim a space when the owner is gone, and
      // nothing can tell a legitimate claim from a grab. This is the same person's
      // other device, and it is checkable - so both the writer AND the new owner
      // must prove the same identity root as the CURRENT owner. A space therefore
      // cannot be handed to a stranger, only moved between one person's phones.
      //
      // WHY IT EXISTS: removing a phone that owns a space used to leave that space
      // permanently unmanageable, because the owner is the only device that may
      // rename, delete, evict or arm. Watched on hardware 2026-07-29 - a button
      // labelled "remove this phone" locked its own user out. Transfer first, revoke
      // second.
      //
      // GATED ON revokeV2, deliberately reusing that capability rather than adding
      // one: revokeV2 is only armed once every member advertises `revoke2`, i.e.
      // every member runs a build that understands this rule too. An old peer would
      // reject the new row, store a different `space` value and fork - and indexers
      // sign the view, so that is not a soft failure.
      let allowed = v.pubkey === existing.owner
      if (!allowed && existing.revokeV2 === true && typeof existing.owner === 'string') {
        allowed = await sameIdentityAsOwner(view, v.pubkey, existing.owner) &&
                  await sameIdentityAsOwner(view, v.owner, existing.owner)
      }
      if (!allowed) return
      if (typeof existing.updatedAt === 'number' && v.updatedAt <= existing.updatedAt) return
      await view.put('space', v)
      if (v.deleted && !existing.deleted && typeof emit === 'function') { try { emit('space:deleted', { groupId }) } catch {} }
    }
    return
  }

  if (!inNamespace(op.key)) return
  const existing = (await view.get(op.key))?.value
  if (rowApplyDecision(op.key, op.value, existing) === 'accept') {
    let value = op.value
    // WRITER BINDING (gated by space.revokeV1; see proposals/2026-07-13-writer-
    // revocation.md). Revoking a writer needs its Autobase WRITER CORE key, but the
    // roster is keyed by IDENTITY pubkey and nothing maps between them.
    //
    // The mapping must NOT be self-declared: a member could then claim a victim's
    // writer key and have the owner's revocation remove the VICTIM instead. The only
    // unforgeable source is which core actually appended this block - you cannot
    // append to someone else's writer core - so we take it from node.from.key and
    // ignore anything the row claims.
    //
    // Recording it CHANGES THE VIEW, so it is fork-inducing and stays dormant until
    // the owner arms revokeV1 (which they may only do once every member advertises
    // support). Re-derived on every write, so it survives a republish.
    if (op.key.startsWith('member:')) {
      const meta = (await view.get('space'))?.value
      if (meta && meta.revokeV1 === true) {
        const w = writerKeyOf(ctx.node)
        if (w) value = { ...op.value, _w: w }
      }
    }
    await view.put(op.key, value)
    // PROMOTE THE OWNER'S OTHER PHONES TO INDEXERS. Done HERE, on the member write,
    // and not at admission time - because at admission all we have is the writer
    // core key, and the identity attestation that proves "this is my own phone"
    // lives on the member row and cannot be linked to that key yet. By the time a
    // row is written we have both: `_w` names the writer, `identityProof` names the
    // person.
    //
    // Everything it decides on is replicated state read back out of the view, so
    // every peer promotes the same key at the same point in the log. Gated on
    // promoteV1 because a peer that does NOT do it computes a different indexer set
    // and forks - see PROMOTE_CAP.
    if (op.key.startsWith('member:')) {
      // Still never blocks a member write, but the failure is no longer invisible:
      // an addWriter that throws in here used to look identical to a gate that
      // declined, and they need opposite fixes.
      try {
        await maybePromoteOwnDevice(ctx, view, value)
      } catch (e) {
        promoteMark(ctx, 'threw', { err: (e && e.message) || String(e) })
      }
    }
    try { await maybeNotify(ctx, op.key, op.value, existing) } catch {}
  }
}

// Local-notification signals (policy: assignment-only + join, opt-in, no push).
// Emitted from apply so they fire exactly when a peer's change is synced, and
// reach the RN shell even if the WebView is backgrounded. The shell decides
// whether to raise an OS notification (respecting the user's opt-in). A freshness
// window skips the burst of historical rows applied during an initial catch-up
// sync, so joining/reopening a space does not replay old assignments as alerts.

// Device keys proven to be the same person as `selfKey`, from this space's member
// rows. Memoised per space for a short window: apply runs per op, a catch-up sync
// applies many at once, and re-verifying proofs on each would turn a burst of
// rows into a burst of signature checks.
//
// Deliberately NOT cached forever - a second phone that links later must start
// receiving assignments without a restart, which is the case that made linking
// worth building.
const MY_KEYS_TTL_MS = 30 * 1000
const _myKeys = new Map() // groupId -> { keys:Set, at:number }
async function myDeviceKeys (ctx) {
  const { view, groupId, selfKey } = ctx
  const only = new Set(selfKey ? [selfKey] : [])
  if (!view || !selfKey) return only

  const hit = _myKeys.get(groupId)
  if (hit && (Date.now() - hit.at) < MY_KEYS_TTL_MS) return hit.keys

  try {
    const rows = []
    for await (const { value } of view.createReadStream(MEMBER_RANGE)) {
      if (value && value.pubkey) rows.push({ pubkey: value.pubkey, identityProof: value.identityProof })
    }
    const keys = await sameIdentityKeys(rows, selfKey)
    _myKeys.set(groupId, { keys, at: Date.now() })
    return keys
  } catch {
    // A failed read must not stop the notification we would have sent anyway.
    return only
  }
}

const NOTIFY_FRESH_MS = 60 * 1000
async function maybeNotify (ctx, key, value, existing) {
  const { emit, selfKey, view, groupId } = ctx
  if (typeof emit !== 'function' || !selfKey) return
  if (typeof value.updatedAt !== 'number' || value.updatedAt < Date.now() - NOTIFY_FRESH_MS) return
  if (value.pubkey === selfKey) return // our own change never notifies us
  if (value.deleted) return
  if (key.startsWith('member:')) {
    // A member row we have never seen before = someone joined the space.
    if (!existing) { try { emit('notify:joined', { name: String(value.displayName || 'Someone'), pubkey: value.pubkey, groupId }) } catch {} }
    return
  }
  // Someone assigned an item OR a whole list to me (and it was not already mine).
  // `kind` lets the shell/UI phrase item vs list differently; groupId + listId
  // let a notification tap deep-link straight to the related list.
  const isItem = key.startsWith('item:')
  const isList = key.startsWith('list:')
  // MY DEVICES, not my device. `assignee` is a device key, so before this a chore
  // assigned to someone with two phones notified exactly one of them - whichever
  // key happened to be picked - and the other stayed silent for the same person.
  // That is the failure this whole change exists to fix; see
  // proposals/2026-07-29-one-person-many-devices.md.
  //
  // Resolved by reading member rows and comparing verified identity roots, NOT by
  // trusting a claim on the item. Falls back to exactly `selfKey` when nothing can
  // be proven, so an unlinked device behaves precisely as it did before.
  const mine = await myDeviceKeys(ctx)
  if ((isItem || isList) && mine.has(value.assignee)) {
    const wasMine = !!existing && mine.has(existing.assignee)
    if (!wasMine) {
      const kind = isItem ? 'item' : 'list'
      const text = String((isItem ? value.text : value.name) || (isItem ? 'an item' : 'a list'))
      // item key = item:{listId}:{itemId}; list key = list:{listId}
      const listId = isItem ? key.split(':')[1] : key.slice('list:'.length)
      try { emit('notify:assigned', { kind, text, by: value.pubkey, groupId, listId }) } catch {}
    }
  }
  // Completion (the return leg): someone else just checked an item on a list I
  // created. The recipient is the list's CREATOR/owner (list.createdBy), NOT the
  // assignee: the assignee is who the list belongs to (e.g. a kid), while the
  // creator (e.g. a parent) is who wants to know it got done. Fires on my own
  // device when I apply their check, per the list's notify mode. `done` scans the
  // list and only fires once the last open item is checked; the just-checked item
  // is already in the view.
  if (isItem && value.checked === true && !(existing && existing.checked === true) && view) {
    const listId = key.split(':')[1]
    const list = (await view.get('list:' + listId))?.value
    if (list && !list.deleted && list.createdBy === selfKey) {
      const mode = effectiveNotifyMode(list)
      const base = { listName: String(list.name || 'a list'), kind: list.kind || 'list', by: value.pubkey, groupId, listId }
      if (mode === 'each') {
        try { emit('notify:completed', { ...base, allDone: false, item: String(value.text || 'an item') }) } catch {}
      } else if (mode === 'done') {
        let anyOpen = false
        // effectiveChecked: without it a list of weekly chores reads as all-done
        // for the rest of the week and the notification never fires again.
        const nowMs = Date.now()
        for await (const { value: it } of view.createReadStream(itemRange(listId))) {
          if (it && !it.deleted && !effectiveChecked(it, nowMs)) { anyOpen = true; break }
        }
        if (!anyOpen) { try { emit('notify:completed', { ...base, allDone: true }) } catch {} }
      }
    }
  }
}

// Roster visibility. Pure, so the filter is unit-testable without an Autobase:
// takes a member row and the `space` meta and says whether it belongs in the
// roster. Every membership surface (MembersBar, the member count, the assignee
// picker) reads member:getAll, so filtering here fixes all of them at once.
//   evicted - the owner listed this pubkey in space.evicted
//   left    - the member retired their own row
//   deleted - a tombstoned row (member:getAll never filtered these; latent bug)
function isEvicted (spaceMeta, pubkey) {
  const ev = spaceMeta && spaceMeta.evicted
  return !!(ev && typeof ev === 'object' && ev[pubkey])
}
function isMemberVisible (row, spaceMeta) {
  if (!row || typeof row.pubkey !== 'string') return false
  if (row.deleted === true || row.left === true) return false
  return !isEvicted(spaceMeta, row.pubkey)
}

// --- daily reminder digest ------------------------------------------------
// P1 of proposals/2026-07-27-reminder-notifications.md. Pure so the whole thing
// is unit-tested rather than eyeballed on a phone, and so the shell stays dumb:
// it schedules whatever digestText returns.
//
// This is a TIME-triggered notification. The OS is handed it in advance and
// delivers it with our process dead, which is why it is NOT blocked by the
// 2026-07-07 background-while-killed WON'T-FIX - that covers notifications
// triggered by a PEER'S change arriving, which needs us alive to apply it.

// Chores, to-dos and plain untyped lists count. GROCERY LISTS DO NOT (Tim's call,
// 2026-07-27, after the first real digest named one): a shopping list is a thing
// you carry to a shop when you happen to go, not work that is overdue, so a daily
// "you still have milk on the list" is noise. Chores and to-dos ARE work that
// goes stale, which is the whole reason to nag about them, and an untyped list is
// usually a checklist of things to do, so it is treated as one (Tim's call).
//
// Excluding notes is a separate and harder requirement: a note stores one item
// row per LINE (proposals/2026-07-20-note-lists.md) and those rows are never
// checked, so counting them would report a two-paragraph note as ~20 open tasks.
// An allowlist rather than a denylist, so a kind added later has to opt IN and
// cannot start nagging by accident.
const DIGEST_KINDS = ['chore', 'todo', 'list']
function digestKindOf (list) { return list && list.kind ? list.kind : 'list' }
function isDigestCountable (list) {
  if (!list || list.deleted === true) return false
  return DIGEST_KINDS.includes(digestKindOf(list))
}

// Chores lead, then to-dos, then untyped. Ties break on the open count then the
// name, so the order is deterministic: the "top list" naming the body must not
// wobble between runs or the copy reads as random.
const DIGEST_KIND_RANK = { chore: 0, todo: 1, list: 2 }
function digestRank (kind) {
  const r = DIGEST_KIND_RANK[kind || 'list']
  return typeof r === 'number' ? r : 99
}
function sortDigestLists (rows) {
  return (rows || []).slice().sort((a, b) =>
    digestRank(a.kind) - digestRank(b.kind) ||
    (b.open || 0) - (a.open || 0) ||
    String(a.name || '').localeCompare(String(b.name || '')))
}

// The digest copy. Returns null when nothing is open, and the caller CANCELS
// rather than scheduling: a daily "you have nothing to do" is pure noise.
//
// Deliberately carries no hard total ("7 items left"). The body is frozen when
// the notification is scheduled and on iOS the app may not have run since, so a
// hard count reads as a bug the moment it is stale. Naming the top list and
// counting the REST degrades honestly.
function digestText (rows) {
  const lists = sortDigestLists((rows || []).filter((r) => r && (r.open || 0) > 0))
  if (!lists.length) return null
  const top = lists[0]
  const name = String(top.name || '').trim() || 'One of your lists'
  const others = lists.length - 1
  const body = others === 0
    ? `"${name}" still has open items`
    : `"${name}" and ${others} other list${others === 1 ? '' : 's'} still have open items`
  // groupId + listId so a tap deep-links to the top list, same shape every other
  // notification uses.
  return { title: 'Still on your lists', body, groupId: top.groupId || null, listId: top.listId || null }
}

// --- recurring chores ------------------------------------------------------
// proposals/2026-07-27-recurring-chores.md. A chore that comes back.
//
// OPEN-NESS IS DERIVED, NEVER WRITTEN. The row stores `repeat` and `lastDoneAt`;
// whether the chore is open right now is computed here, at read time. Nothing
// resets it on a timer - which matters because there is no server and no leader,
// so a timed reset would have every awake device racing to write the same op,
// churning the log once per device per period forever.
//
// Checking the chore off is the ONLY write, and it is the write that already
// happened. Completion is what ADVANCES the cycle rather than something fighting
// it.
const REPEAT_KINDS = ['daily', 'weekly', 'monthly']
function normalizeRepeat (v) { return REPEAT_KINDS.includes(v) ? v : null }
function repeatOf (item) { return item ? normalizeRepeat(item.repeat) : null }

// Sunday, matching the calendar convention where this is used. One constant, so
// switching to an ISO Monday week is a one-line change if it is ever wanted.
const WEEK_STARTS_ON = 0

// Start of the current period, in LOCAL time. Deliberately local and not UTC:
// "this week" means the user's week. It is the one place recurrence is not an
// absolute instant, unlike remindAt, which is.
//
// Built from date parts rather than by subtracting milliseconds, so a DST change
// cannot shift a boundary by an hour and make a chore reopen or stay closed early.
function periodStart (repeat, now) {
  const d = new Date(now)
  const kind = normalizeRepeat(repeat)
  if (!kind) return null
  if (kind === 'monthly') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  if (kind === 'weekly') {
    const back = (d.getDay() - WEEK_STARTS_ON + 7) % 7
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// The whole feature: a recurring item is OPEN unless it was completed inside the
// current period. `checked` on the row is ignored here on purpose - it is a
// record of the last completion, not the current state.
function isRecurringOpen (item, now) {
  const kind = repeatOf(item)
  if (!kind) return false // not recurring; the caller uses plain `checked`
  const done = item.lastDoneAt
  if (typeof done !== 'number' || !Number.isFinite(done)) return true // never done
  return done < periodStart(kind, now)
}

// THE SEAM. Every read surface asks this instead of reading `item.checked`, so
// none of them can be half-migrated: item:getAll, the digest count, the reminder
// target, the all-done completion scan and (through item:getAll) the UI's
// auto-collapse. For a non-recurring item it is exactly `item.checked`, so
// nothing existing changes behaviour.
function effectiveChecked (item, now) {
  if (!item) return false
  if (!repeatOf(item)) return item.checked === true
  return !isRecurringOpen(item, now)
}

// When it comes back, for the UI's "due again" line. Null when not recurring.
function nextDueAt (item, now) {
  const kind = repeatOf(item)
  if (!kind) return null
  const start = periodStart(kind, now)
  const d = new Date(start)
  if (kind === 'monthly') return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  if (kind === 'weekly') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

// --- per-item reminders ----------------------------------------------------
// P2 of proposals/2026-07-27-reminder-notifications.md. `remindAt` is an epoch
// ms on the item row, additive and optional: rowApplyDecision validates only
// pubkey/updatedAt/sig/namespace and every local write path is a
// read-modify-write through signRow with no field allowlist, so an OLD build
// editing the item preserves it rather than dropping it. Its FUTURE_TS guard
// covers updatedAt only, so a remindAt a year out is accepted normally.
//
// Named remindAt and NOT dueAt on purpose: it is a reminder, not a deadline, and
// nothing later should read it as one. No sorting, no overdue styling, no
// list-level rollup.

// WHO FIRES IT. Exactly one member by construction, so exactly one phone rings.
// A parent setting a reminder on a kid's chore reaches the kid and nobody else.
// Without this every member's device would buzz for every reminder, which is the
// fastest way to get an app muted.
//
// Resolution order, first hit wins:
//   1. item.assignee  - whoever owns this specific job
//   2. list.assignee  - whoever the whole list belongs to
//   3. item.remindBy  - WHOEVER SET THE REMINDER
//   4. list.createdBy - the backstop, and only for rows written before remindBy
//
// remindBy was added 2026-07-27 after Tim got NO reminders on his iPhone. The
// rule used to fall straight from list.assignee to list.createdBy, and createdBy
// is a DEVICE identity: his lists were created on the Pixel, so a reminder he set
// on the iPhone resolved to the Pixel and his iPhone correctly scheduled nothing.
// Measured, not guessed - the iPhone logged "items: nothing to schedule" at the
// same moment the Pixel held an exact alarm for it.
//
// "The person who asked for the reminder gets the reminder" is the intuitive rule
// and it is what a single human with two phones expects. It sits BELOW the two
// assignee checks on purpose, so the parent-sets-a-reminder-on-the-kid's-chore
// case still reaches the kid rather than the parent.
//
// Returns null when nothing resolves (e.g. the list is gone), and the caller then
// schedules nothing rather than guessing.
function reminderTargetOf (item, list) {
  if (!item || item.deleted === true) return null
  if (typeof item.assignee === 'string' && item.assignee) return item.assignee
  if (!list || list.deleted === true) return null
  if (typeof list.assignee === 'string' && list.assignee) return list.assignee
  if (typeof item.remindBy === 'string' && item.remindBy) return item.remindBy
  if (typeof list.createdBy === 'string' && list.createdBy) return list.createdBy
  return null
}

// Is this row one that SHOULD have a notification pending right now, for me?
// Pure and time-injected so the boundary cases are testable without waiting.
// A checked item never rings: finishing something early is the normal way to
// cancel a reminder, and it must not still fire.
function isReminderPending (item, list, selfKey, now) {
  // effectiveChecked, not item.checked: a recurring chore completed LAST period
  // is open again and must ring, and one completed this period must not.
  if (!item || item.deleted === true || effectiveChecked(item, now)) return false
  if (typeof item.remindAt !== 'number' || !Number.isFinite(item.remindAt)) return false
  if (item.remindAt <= now) return false // already past; the OS has fired it or it was missed
  return !!selfKey && reminderTargetOf(item, list) === selfKey
}

// iOS keeps at most 64 pending local notifications per app and SILENTLY drops the
// rest, so the reconciler schedules only the soonest few and refills as they
// fire. 32 leaves generous headroom, plus a slot for the daily digest.
const MAX_SCHEDULED_REMINDERS = 32

module.exports = { applyListOp, rowApplyDecision, sameIdentityAsOwner, listKey, itemKey, memberKey, LIST_RANGE, MEMBER_RANGE, itemRange, FUTURE_TS_TOLERANCE_MS, LIST_KINDS, normalizeKind, NOTIFY_MODES, normalizeNotifyMode, effectiveNotifyMode, isEvicted, isMemberVisible, writerKeyOf, REVOKE_CAP, REVOKE_SELF_CAP, PROMOTE_CAP, hasCap, allMembersSupportCap, allMembersSupportRevoke, allMembersSupportSelfRevoke, allMembersSupportPromote, isDigestCountable, sortDigestLists, digestText, reminderTargetOf, isReminderPending, MAX_SCHEDULED_REMINDERS, REPEAT_KINDS, normalizeRepeat, periodStart, isRecurringOpen, effectiveChecked, nextDueAt }
