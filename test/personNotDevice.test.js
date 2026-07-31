// A PERSON, NOT A DEVICE - the sweep, 2026-07-31.
//
// PR #161 fixed removal, PR #162 fixed space ownership, and both were reported by
// Tim rather than found. So this is the deliberate pass over the rest: every place
// that still compared one DEVICE key where it meant a PERSON. Each case below is a
// separate way the app told a linked phone it was somebody else.
//
// THE SHAPE IS ALWAYS THE SAME. Something stores a device key - an assignee, a
// createdBy, a member row's representative pubkey - and the reader compares it to
// the key THIS phone signs with. Correct on one phone, wrong the moment you link a
// second, and always silent: no error, just a notification that never arrives or a
// button that is not there.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { generateKeypair } = require('@peerloom/core/identity')
const { signValue } = require('@peerloom/core/records')
const {
  applyListOp, memberKey, itemKey, listKey, isReminderPending, isSelfKey,
} = require('../src/listWire.js')
const { isMyRow, myDeviceKeys, isMine } = require('../src/selfKeys.js')

const hex = (b) => b4a.toString(b, 'hex')

async function person () {
  const id = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  return async function device () {
    const kp = generateKeypair()
    const pubkey = hex(kp.publicKey)
    return { kp, pubkey, identityProof: hex(await id.bootstrap(b4a.from(pubkey, 'hex'))) }
  }
}

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

const memberRow = (d) => signValue({ pubkey: d.pubkey, updatedAt: 1, displayName: 'D', identityProof: d.identityProof }, d.kp.secretKey)

// apply one op as `self`, collecting the notification signals it emits.
//
// A FRESH groupId PER TEST, and it is not cosmetic: listWire memoises the "my device
// keys" set per space for 30s, keyed by groupId alone. That is correct in the app,
// where selfKey never changes inside a process - but a test file invents a new person
// per case, so reusing 'g' hands the next test the previous one's key set and it
// fails for a reason that has nothing to do with the code under test.
let _gid = 0
const nextGroup = () => 'g' + (++_gid)
async function applyAs (self, view, key, value, groupId) {
  const events = []
  await applyListOp({ type: 'put', key, value }, {
    view, groupId: groupId || view.gid, selfKey: self.pubkey, emit: (e, d) => events.push([e, d]),
  })
  return events
}

// A space whose roster proves phoneA and phoneB are one person, plus a housemate.
async function roster (a, b, h) {
  const view = mockView()
  for (const d of [a, b, h]) await view.put(memberKey(d.pubkey), memberRow(d))
  view.gid = nextGroup()
  return view
}

const fresh = () => Date.now() // inside maybeNotify's freshness window

test('a change I made on my OTHER phone does not notify me', async () => {
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const view = await roster(a, b, housemate)

  // Phone B assigns a list to me. Both phones are me, so this is me assigning to
  // myself - and phone A must stay quiet. Before this it announced "you were
  // assigned a list" about a list the user had just assigned themselves.
  const list = signValue({ id: 'l1', name: 'Chores', assignee: a.pubkey, pubkey: b.pubkey, updatedAt: fresh() }, b.kp.secretKey)
  const events = await applyAs(a, view, listKey('l1'), list)
  assert.deepEqual(events, [], 'my own phone assigning to me is not news')

  // The control: the SAME write from a housemate does notify.
  const view2 = await roster(a, b, housemate)
  const fromThem = signValue({ id: 'l2', name: 'Chores', assignee: a.pubkey, pubkey: housemate.pubkey, updatedAt: fresh() }, housemate.kp.secretKey)
  const events2 = await applyAs(a, view2, listKey('l2'), fromThem)
  assert.equal(events2.filter(([e]) => e === 'notify:assigned').length, 1)
})

test('a list assigned to my other phone still notifies me here', async () => {
  const me = await person()
  const a = await me()
  const b = await me()
  const housemate = await (await person())()
  const view = await roster(a, b, housemate)

  // A REGRESSION GUARD, not a fix: this one already worked, and it is the reference
  // the rest of the sweep was measured against. The forcing case from the
  // one-person-many-devices proposal - `assignee` is a device key, so a housemate
  // picking "Tim" stores whichever of Tim's keys the roster row happened to carry,
  // and the other phone must still hear about it. Pinned because every fix below
  // borrows this exact key set, so breaking it would break them silently.
  const list = signValue({ id: 'l1', name: 'Bins', assignee: b.pubkey, pubkey: housemate.pubkey, updatedAt: fresh() }, housemate.kp.secretKey)
  const events = await applyAs(a, view, listKey('l1'), list)
  assert.equal(events.filter(([e]) => e === 'notify:assigned').length, 1)
})

test("a completed chore reaches the creator's OTHER phone", async () => {
  const me = await person()
  const a = await me()        // the phone in the parent's hand
  const b = await me()        // the phone the list was created on
  const kid = await (await person())()
  const view = await roster(a, b, kid)

  // Created on phone B, so `createdBy` names B. The completion notification used to
  // compare that to THIS phone's key, so the parent holding phone A was told nothing
  // when the kid finished - the return leg of the assignment bug above.
  await view.put(listKey('l1'), signValue({
    id: 'l1', name: 'Bins', kind: 'chore', notifyOnComplete: 'each',
    createdBy: b.pubkey, pubkey: b.pubkey, updatedAt: 1,
  }, b.kp.secretKey))

  const item = signValue({ id: 'i1', listId: 'l1', text: 'Take the bins out', checked: true, pubkey: kid.pubkey, updatedAt: fresh() }, kid.kp.secretKey)
  const events = await applyAs(a, view, itemKey('l1', 'i1'), item)
  assert.equal(events.filter(([e]) => e === 'notify:completed').length, 1)

  // And a housemate's list completing is still none of my business.
  const view2 = await roster(a, b, kid)
  await view2.put(listKey('l2'), signValue({
    id: 'l2', name: 'Theirs', kind: 'chore', notifyOnComplete: 'each',
    createdBy: kid.pubkey, pubkey: kid.pubkey, updatedAt: 1,
  }, kid.kp.secretKey))
  const item2 = signValue({ id: 'i2', listId: 'l2', text: 'x', checked: true, pubkey: kid.pubkey, updatedAt: fresh() }, kid.kp.secretKey)
  const events2 = await applyAs(a, view2, itemKey('l2', 'i2'), item2)
  assert.deepEqual(events2.filter(([e]) => e === 'notify:completed'), [])
})

test('a reminder aimed at my other phone is still scheduled here', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const THEM = 'c'.repeat(64)
  const item = { id: 'i1', remindAt: 2000, assignee: B }
  const list = { id: 'l1', createdBy: THEM }

  // A single key is still accepted, unchanged - that is what the pure unit tests and
  // any unlinked phone pass.
  assert.equal(isReminderPending(item, list, A, 1000), false, 'one key: not mine')
  assert.equal(isReminderPending(item, list, B, 1000), true)

  // The key SET is the fix: a reminder resolving to my other phone rings here too.
  // Both phones ringing is the deliberate trade - a duplicate is noise, a reminder
  // that never fires is the feature not working.
  assert.equal(isReminderPending(item, list, new Set([A, B]), 1000), true)
  assert.equal(isReminderPending(item, list, new Set([A, THEM]), 1000), false, 'a set I am not in stays not mine')
  assert.equal(isReminderPending(item, list, [A, B], 1000), true, 'an array works too')

  // The other conditions still gate it, whatever shape `self` takes.
  assert.equal(isReminderPending({ ...item, checked: true }, list, new Set([A, B]), 1000), false)
  assert.equal(isReminderPending(item, list, new Set([A, B]), 3000), false, 'already past')
})

test('isSelfKey never matches on an absence', () => {
  const K = 'a'.repeat(64)
  assert.equal(isSelfKey(null, K), false)
  assert.equal(isSelfKey(K, null), false)
  assert.equal(isSelfKey(new Set(), K), false)
  assert.equal(isSelfKey(new Set([K]), undefined), false)
  assert.equal(isSelfKey('', ''), false, 'two empties are not a match')
})

// --- the UI half (src/selfKeys.js) ------------------------------------------

test('my own collapsed row is recognised through my other phone key', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  // collapseMembers keeps the most RECENTLY updated device as the row's pubkey, so
  // on phone A this row can easily be stamped with B. Every UI check that compared
  // `m.pubkey === selfPubkey` failed exactly here.
  const meRow = { pubkey: B, displayName: 'Tim', keys: [B, A] }
  const themRow = { pubkey: 'c'.repeat(64), displayName: 'Sam', keys: ['c'.repeat(64)] }

  assert.equal(isMyRow(meRow, A), true, 'my row, seen from my other phone')
  assert.equal(isMyRow(meRow, B), true)
  assert.equal(isMyRow(themRow, A), false)
  assert.deepEqual(myDeviceKeys([themRow, meRow], A), [B, A])
})

test('an unlinked phone speaks for exactly itself', () => {
  const A = 'a'.repeat(64)
  // No proof, so no `keys`, so no claim about anyone else. An absent roster must not
  // widen what this phone answers for - the same rule the collapse follows.
  assert.deepEqual(myDeviceKeys([{ pubkey: A, displayName: 'Tim' }], A), [A])
  assert.deepEqual(myDeviceKeys([], A), [A])
  assert.deepEqual(myDeviceKeys(null, A), [A])
  assert.deepEqual(myDeviceKeys([], null), [])
  assert.equal(isMyRow(null, A), false)
  assert.equal(isMyRow({ pubkey: A }, null), false)
})

test('a chore list I created on my other phone is still mine to delete', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const KID = 'c'.repeat(64)
  const members = [{ pubkey: B, displayName: 'Tim', keys: [B, A] }, { pubkey: KID, displayName: 'Kid', keys: [KID] }]

  // The parent/child rule is "only the creator may delete a chore list". Comparing
  // createdBy to this device's key applied the CHILD rule to the parent.
  assert.equal(isMine(members, A, B), true, 'created on my other phone')
  assert.equal(isMine(members, A, A), true)
  assert.equal(isMine(members, A, KID), false, "the kid's list is not mine")
  assert.equal(isMine(members, KID, B), false, 'and the rule still holds the other way')
  assert.equal(isMine(members, A, null), false)
})
