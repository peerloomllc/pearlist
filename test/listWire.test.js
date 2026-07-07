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
