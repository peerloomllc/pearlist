const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const { generateKeypair } = require('@peerloom/core/identity')
const { signValue } = require('@peerloom/core/records')
const { rowApplyDecision, listKey, itemKey, applyListOp } = require('../src/listWire')

const KP = generateKeypair()
const PUB = b4a.toString(KP.publicKey, 'hex')

// Build a signed row at a given updatedAt.
function row (extra = {}, kp = KP, pub = PUB) {
  return signValue({ pubkey: pub, updatedAt: 1000, text: 'milk', checked: false, ...extra }, kp.secretKey)
}

test('accepts a fresh, valid, signed row', () => {
  assert.equal(rowApplyDecision(itemKey('L', 'I'), row(), null), 'accept')
  assert.equal(rowApplyDecision(listKey('L'), row({ name: 'Groceries' }), null), 'accept')
})

test('rejects a row whose signature does not verify', () => {
  const r = row()
  r.text = 'beer' // tamper after signing
  assert.equal(rowApplyDecision(itemKey('L', 'I'), r, null), 'reject')
})

test('rejects a row signed by a key other than its pubkey field', () => {
  const other = generateKeypair()
  const r = signValue({ pubkey: PUB, updatedAt: 1000, text: 'x' }, other.secretKey)
  assert.equal(rowApplyDecision(itemKey('L', 'I'), r, null), 'reject')
})

test('rejects an updatedAt far in the future', () => {
  const r = row({ updatedAt: Date.now() + 60 * 60 * 1000 })
  assert.equal(rowApplyDecision(itemKey('L', 'I'), r, null), 'reject')
})

test('last-writer-wins by updatedAt', () => {
  const older = { ...row(), updatedAt: 1000 }
  const newer = row({ updatedAt: 2000 })
  assert.equal(rowApplyDecision(itemKey('L', 'I'), newer, older), 'accept')
  assert.equal(rowApplyDecision(itemKey('L', 'I'), { ...row(), updatedAt: 1000 }, { ...row(), updatedAt: 2000 }), 'reject')
})

test('equal updatedAt breaks ties deterministically by signature', () => {
  const a = row({ text: 'a' })
  const b = row({ text: 'b' })
  const hi = a.sig > b.sig ? a : b
  const lo = a.sig > b.sig ? b : a
  assert.equal(rowApplyDecision(itemKey('L', 'I'), hi, lo), 'accept')
  assert.equal(rowApplyDecision(itemKey('L', 'I'), lo, hi), 'reject')
})

test('no resurrection: a tombstone rejects all later writes', () => {
  const tombstone = row({ deleted: true, updatedAt: 1000 })
  const laterEdit = row({ updatedAt: 5000 })
  assert.equal(rowApplyDecision(itemKey('L', 'I'), laterEdit, tombstone), 'reject')
})

test('rejects keys outside the list:/item:/member: namespaces', () => {
  assert.equal(rowApplyDecision('other:1', row(), null), 'reject')
})

test('member row is owner-scoped: only the key-matching pubkey may write it', () => {
  const kp = generateKeypair()
  const pub = b4a.toString(kp.publicKey, 'hex')
  const good = signValue({ pubkey: pub, updatedAt: 1000, displayName: 'Sam' }, kp.secretKey)
  assert.equal(rowApplyDecision('member:' + pub, good, null), 'accept')
  // A member row whose key names a different pubkey than the (validly signed)
  // value is rejected, so nobody can overwrite another member's roster entry.
  assert.equal(rowApplyDecision('member:' + '00'.repeat(32), good, null), 'reject')
})

// --- local-notification signals from apply (maybeNotify) --------------------

const OTHER = generateKeypair()
const OTHERPUB = b4a.toString(OTHER.publicKey, 'hex')

function mockView (initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { m.set(k, v) },
    async * createReadStream (range = {}) {
      const { gt, lt } = range
      for (const [k, v] of m) {
        if (gt != null && !(k > gt)) continue
        if (lt != null && !(k < lt)) continue
        yield { key: k, value: v }
      }
    },
  }
}
async function apply (op, extra = {}) {
  const events = []
  const view = extra.view || mockView(extra.initial || {})
  await applyListOp(op, { view, groupId: 'g', selfKey: PUB, emit: (e, d) => events.push([e, d]), ...extra.ctx })
  return events
}

test('notify:assigned (kind item) fires when a peer assigns me a fresh item', async () => {
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now(), text: 'milk', assignee: PUB, deleted: false }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: itemKey('L', 'I'), value: val })
  assert.ok(events.some(([e, d]) => e === 'notify:assigned' && d.kind === 'item' && d.text === 'milk' && d.by === OTHERPUB && d.groupId === 'g' && d.listId === 'L'))
})

test('notify:assigned (kind list) fires when a peer assigns me a whole list', async () => {
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now(), name: 'Chores', assignee: PUB, deleted: false }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: listKey('L2'), value: val })
  assert.ok(events.some(([e, d]) => e === 'notify:assigned' && d.kind === 'list' && d.text === 'Chores' && d.by === OTHERPUB && d.groupId === 'g' && d.listId === 'L2'))
})

test('no notify for a historical assignment (initial-sync burst)', async () => {
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now() - 5 * 60 * 1000, text: 'old', assignee: PUB }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: itemKey('L', 'I2'), value: val })
  assert.ok(!events.some(([e]) => e === 'notify:assigned'))
})

test('no notify when I assign an item to myself', async () => {
  const val = signValue({ pubkey: PUB, updatedAt: Date.now(), text: 'mine', assignee: PUB }, KP.secretKey)
  const events = await apply({ type: 'put', key: itemKey('L', 'I3'), value: val })
  assert.ok(!events.some(([e]) => e === 'notify:assigned'))
})

test('no re-notify when an already-mine item is edited', async () => {
  const existing = signValue({ pubkey: OTHERPUB, updatedAt: Date.now() - 1000, text: 'milk', assignee: PUB }, OTHER.secretKey)
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now(), text: 'milk 2%', assignee: PUB }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: itemKey('L', 'I4'), value: val }, { initial: { [itemKey('L', 'I4')]: existing } })
  assert.ok(!events.some(([e]) => e === 'notify:assigned'))
})

test('notify:joined fires for a new member row from a peer', async () => {
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now(), displayName: 'Sam' }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: 'member:' + OTHERPUB, value: val })
  assert.ok(events.some(([e, d]) => e === 'notify:joined' && d.name === 'Sam'))
})

// --- completion notifications (the return leg; recipient = list creator) -----

// A chore list I created (createdBy = me), assigned to a peer (like a kid).
function choreList (listId, extra = {}) {
  return signValue({ pubkey: PUB, updatedAt: Date.now() - 2000, id: listId, name: 'Chores', kind: 'chore', createdBy: PUB, assignee: OTHERPUB, deleted: false, ...extra }, KP.secretKey)
}
// A peer's item at a checked state (defaults to a fresh check).
function peerItem (listId, id, checked, ts = Date.now()) {
  return signValue({ pubkey: OTHERPUB, updatedAt: ts, id, text: id, checked, deleted: false }, OTHER.secretKey)
}

test('notify:completed (each) fires when a peer checks an item on a chore list I created', async () => {
  const initial = { [listKey('L')]: choreList('L', { notifyOnComplete: 'each' }), [itemKey('L', 'I')]: peerItem('L', 'I', false, Date.now() - 500) }
  const events = await apply({ type: 'put', key: itemKey('L', 'I'), value: peerItem('L', 'I', true) }, { initial })
  assert.ok(events.some(([e, d]) => e === 'notify:completed' && d.allDone === false && d.item === 'I' && d.listName === 'Chores' && d.kind === 'chore' && d.by === OTHERPUB && d.listId === 'L' && d.groupId === 'g'))
})

test('notify:completed (done) fires only when the LAST open item is checked', async () => {
  // Item A already checked; checking the last open item B -> all done.
  const initial = {
    [listKey('L2')]: choreList('L2', { notifyOnComplete: 'done' }),
    [itemKey('L2', 'A')]: peerItem('L2', 'A', true, Date.now() - 800),
    [itemKey('L2', 'B')]: peerItem('L2', 'B', false, Date.now() - 700),
  }
  const events = await apply({ type: 'put', key: itemKey('L2', 'B'), value: peerItem('L2', 'B', true) }, { initial })
  assert.ok(events.some(([e, d]) => e === 'notify:completed' && d.allDone === true && d.listName === 'Chores' && d.kind === 'chore'))
})

test('no notify:completed (done) while other items remain open', async () => {
  const initial = {
    [listKey('L3')]: choreList('L3', { notifyOnComplete: 'done' }),
    [itemKey('L3', 'A')]: peerItem('L3', 'A', false, Date.now() - 700),
    [itemKey('L3', 'B')]: peerItem('L3', 'B', false, Date.now() - 600),
  }
  const events = await apply({ type: 'put', key: itemKey('L3', 'A'), value: peerItem('L3', 'A', true) }, { initial })
  assert.ok(!events.some(([e]) => e === 'notify:completed'))
})

test('chore list with no explicit mode defaults to done-mode completion notify', async () => {
  const initial = { [listKey('L4')]: choreList('L4'), [itemKey('L4', 'I')]: peerItem('L4', 'I', false, Date.now() - 500) }
  const events = await apply({ type: 'put', key: itemKey('L4', 'I'), value: peerItem('L4', 'I', true) }, { initial })
  assert.ok(events.some(([e, d]) => e === 'notify:completed' && d.allDone === true))
})

test('no notify:completed when I did not create the list (I am only its assignee)', async () => {
  // Created by a peer, assigned to me: I am the "kid", not the recipient.
  const list = signValue({ pubkey: OTHERPUB, updatedAt: Date.now() - 2000, name: 'Chores', kind: 'chore', createdBy: OTHERPUB, assignee: PUB, notifyOnComplete: 'each' }, OTHER.secretKey)
  const initial = { [listKey('L5')]: list, [itemKey('L5', 'I')]: peerItem('L5', 'I', false, Date.now() - 500) }
  const events = await apply({ type: 'put', key: itemKey('L5', 'I'), value: peerItem('L5', 'I', true) }, { initial })
  assert.ok(!events.some(([e]) => e === 'notify:completed'))
})

test('non-chore list fires no completion notify by default', async () => {
  const list = signValue({ pubkey: PUB, updatedAt: Date.now() - 2000, name: 'Groceries', kind: 'grocery', createdBy: PUB }, KP.secretKey)
  const initial = { [listKey('L6')]: list, [itemKey('L6', 'I')]: peerItem('L6', 'I', false, Date.now() - 500) }
  const events = await apply({ type: 'put', key: itemKey('L6', 'I'), value: peerItem('L6', 'I', true) }, { initial })
  assert.ok(!events.some(([e]) => e === 'notify:completed'))
})

test('no notify:completed when I complete an item myself', async () => {
  const initial = { [listKey('L7')]: choreList('L7', { notifyOnComplete: 'each' }), [itemKey('L7', 'I')]: signValue({ pubkey: PUB, updatedAt: Date.now() - 500, text: 'mine', checked: false }, KP.secretKey) }
  const mine = signValue({ pubkey: PUB, updatedAt: Date.now(), text: 'mine', checked: true }, KP.secretKey)
  const events = await apply({ type: 'put', key: itemKey('L7', 'I'), value: mine }, { initial })
  assert.ok(!events.some(([e]) => e === 'notify:completed'))
})

// --- membership removal (proposals/2026-07-13-space-member-eviction.md) -------
// Owner evicts via space.evicted; a member leaves via `left` on their own row.
// The security property lives in the EXISTING `space` apply rule (owner-only
// updates), so a forged eviction from a non-owner must be dropped in apply on
// every peer, not merely refused by the IPC method.

const { isMemberVisible, memberKey } = require('../src/listWire')

function memberRow (pub, kp, extra = {}) {
  return signValue({ pubkey: pub, updatedAt: 1000, displayName: 'Someone', ...extra }, kp.secretKey)
}
// A stored `space` row owned by PUB.
function spaceRow (extra = {}, kp = KP, pub = PUB, at = 1000) {
  return signValue({ pubkey: pub, owner: PUB, name: 'Home', createdAt: 1, updatedAt: at, ...extra }, kp.secretKey)
}

test('roster hides evicted, left and tombstoned members', () => {
  const meta = { owner: PUB, evicted: { [OTHERPUB]: { at: 5 } } }
  assert.equal(isMemberVisible(memberRow(PUB, KP), meta), true)
  assert.equal(isMemberVisible(memberRow(OTHERPUB, OTHER), meta), false, 'evicted by the owner')
  assert.equal(isMemberVisible(memberRow(PUB, KP, { left: true }), meta), false, 'left the space')
  assert.equal(isMemberVisible(memberRow(PUB, KP, { deleted: true }), meta), false, 'tombstoned')
  assert.equal(isMemberVisible(memberRow(PUB, KP), null), true, 'no space meta yet')
})

test('eviction is revocable, so a re-invited member comes back', () => {
  const evicted = { owner: PUB, evicted: { [OTHERPUB]: { at: 5 } } }
  assert.equal(isMemberVisible(memberRow(OTHERPUB, OTHER), evicted), false)
  // member:restore deletes the key rather than tombstoning it. A tombstone would
  // trip the no-resurrection rule and strand them forever.
  const restored = { owner: PUB, evicted: {} }
  assert.equal(isMemberVisible(memberRow(OTHERPUB, OTHER), restored), true)
})

test('apply: the owner may evict a member', async () => {
  const view = mockView({ space: spaceRow() })
  const update = spaceRow({ evicted: { [OTHERPUB]: { at: 9 } } }, KP, PUB, 2000)
  await apply({ type: 'put', key: 'space', value: update }, { view })
  const stored = (await view.get('space')).value
  assert.deepEqual(stored.evicted, { [OTHERPUB]: { at: 9 } })
})

test('apply: a NON-owner cannot evict anyone (forged eviction is dropped)', async () => {
  const view = mockView({ space: spaceRow() })
  // OTHER is a member (a writer!) but not the owner: they sign a space update
  // that evicts the owner. Every peer must drop it identically.
  const forged = signValue({ pubkey: OTHERPUB, owner: PUB, name: 'Home', createdAt: 1, updatedAt: 3000, evicted: { [PUB]: { at: 9 } } }, OTHER.secretKey)
  await apply({ type: 'put', key: 'space', value: forged }, { view })
  const stored = (await view.get('space')).value
  assert.equal(stored.evicted, undefined, 'forged eviction must not apply')
  assert.equal(isMemberVisible(memberRow(PUB, KP), stored), true, 'owner still in the roster')
})

test('apply: the space row is stored verbatim, so old peers do not diverge', async () => {
  // The compat argument for the whole feature: `evicted` is an additive field on
  // an existing row, and apply put()s the value as-is. An old peer (which does
  // not know the field) therefore stores byte-identical bytes and merely fails to
  // INTERPRET it. A new NAMESPACE would instead be dropped by old peers, giving a
  // divergent view - and Autobase indexers sign the view.
  const view = mockView({ space: spaceRow() })
  const update = spaceRow({ evicted: { [OTHERPUB]: { at: 9 } }, someFutureField: 42 }, KP, PUB, 2000)
  await apply({ type: 'put', key: 'space', value: update }, { view })
  assert.deepEqual((await view.get('space')).value, update, 'stored verbatim, unknown fields intact')
})

test('a member may retire their OWN row with `left` (owner-scoped rule allows it)', () => {
  const mine = memberRow(PUB, KP, { left: true })
  assert.equal(rowApplyDecision(memberKey(PUB), mine, null), 'accept')
  // ...but still cannot write anyone else's row, so nobody can force you out.
  assert.equal(rowApplyDecision(memberKey(OTHERPUB), mine, null), 'reject')
})

// --- writer revocation (proposals/2026-07-13-writer-revocation.md) -----------
// The binding that revocation depends on must come from the block's AUTHORING
// writer core (node.from.key), never from anything the row claims - otherwise a
// member could name a VICTIM's writer key and have the owner revoke the victim.

const { writerKeyOf, REVOKE_CAP, hasCap, allMembersSupportRevoke } = require('../src/listWire')

const WKEY_A = 'aa'.repeat(32)
const WKEY_VICTIM = 'bb'.repeat(32)
const fakeNode = (writerHex) => ({ from: { key: Buffer.from(writerHex, 'hex') } })

test('writerKeyOf reads the AUTHORING core, not the row', () => {
  assert.equal(writerKeyOf(fakeNode(WKEY_A)), WKEY_A)
  assert.equal(writerKeyOf({}), null)
  assert.equal(writerKeyOf(null), null)
})

test('apply records the writer binding ONLY once the space is armed', async () => {
  const armedSpace = signValue({ pubkey: PUB, owner: PUB, name: 'H', updatedAt: 1000, revokeV1: true }, KP.secretKey)
  const coldSpace = signValue({ pubkey: PUB, owner: PUB, name: 'H', updatedAt: 1000 }, KP.secretKey)
  const row = signValue({ pubkey: PUB, updatedAt: 2000, displayName: 'Me', caps: [REVOKE_CAP] }, KP.secretKey)

  // Not armed -> the row is stored verbatim (byte-identical to what old peers store,
  // which is what keeps an un-armed space fork-free).
  const cold = mockView({ space: coldSpace })
  await apply({ type: 'put', key: memberKey(PUB), value: row }, { view: cold, ctx: { node: fakeNode(WKEY_A) } })
  assert.equal((await cold.get(memberKey(PUB))).value._w, undefined, 'dormant until armed')

  // Armed -> the binding is recorded from the authoring core.
  const hot = mockView({ space: armedSpace })
  await apply({ type: 'put', key: memberKey(PUB), value: row }, { view: hot, ctx: { node: fakeNode(WKEY_A) } })
  assert.equal((await hot.get(memberKey(PUB))).value._w, WKEY_A, 'binding taken from node.from.key')
})

test('a member CANNOT redirect revocation by lying about its writer key', async () => {
  const armedSpace = signValue({ pubkey: PUB, owner: PUB, name: 'H', updatedAt: 1000, revokeV1: true }, KP.secretKey)
  // OTHER signs their own row but CLAIMS the victim's writer core key.
  const liar = signValue({ pubkey: OTHERPUB, updatedAt: 2000, displayName: 'Liar', _w: WKEY_VICTIM }, OTHER.secretKey)
  const view = mockView({ space: armedSpace })
  // ...but the block was actually appended by the liar's OWN core.
  await apply({ type: 'put', key: memberKey(OTHERPUB), value: liar }, { view, ctx: { node: fakeNode(WKEY_A) } })
  const stored = (await view.get(memberKey(OTHERPUB))).value
  assert.equal(stored._w, WKEY_A, 'the claimed key is OVERWRITTEN by the authoring core')
  assert.notEqual(stored._w, WKEY_VICTIM, 'the victim is NOT the revocation target')
})

test('capability gate: every member must advertise, except the eviction target', () => {
  const withCap = (pub) => ({ pubkey: pub, caps: [REVOKE_CAP] })
  const noCap = (pub) => ({ pubkey: pub })
  assert.equal(hasCap(withCap(PUB), REVOKE_CAP), true)
  assert.equal(hasCap(noCap(PUB), REVOKE_CAP), false)

  assert.equal(allMembersSupportRevoke([withCap(PUB), withCap(OTHERPUB)]), true, 'all updated -> can arm')
  assert.equal(allMembersSupportRevoke([withCap(PUB), noCap(OTHERPUB)]), false, 'one straggler -> must NOT arm')
  // The stale device we are evicting will NEVER advertise support - if it counted,
  // the gate would never open and the whole feature would be useless.
  assert.equal(allMembersSupportRevoke([withCap(PUB), noCap(OTHERPUB)], [OTHERPUB]), true,
    'the eviction target is excluded from the gate')
  assert.equal(allMembersSupportRevoke([]), false, 'no members -> nothing to arm')
})
