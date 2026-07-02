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
  assert.ok(events.some(([e, d]) => e === 'notify:assigned' && d.kind === 'item' && d.text === 'milk' && d.by === OTHERPUB))
})

test('notify:assigned (kind list) fires when a peer assigns me a whole list', async () => {
  const val = signValue({ pubkey: OTHERPUB, updatedAt: Date.now(), name: 'Chores', assignee: PUB, deleted: false }, OTHER.secretKey)
  const events = await apply({ type: 'put', key: listKey('L2'), value: val })
  assert.ok(events.some(([e, d]) => e === 'notify:assigned' && d.kind === 'list' && d.text === 'Chores' && d.by === OTHERPUB))
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
