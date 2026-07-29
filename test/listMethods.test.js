// End-to-end on one peer: drive the real engine IPC loop (init, group:create,
// then the list:/item: methods) and assert the worklet behaviour. The engine's
// cross-peer replication is already covered in @peerloom/core's two-peer test.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Corestore = require('corestore')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const listMethods = require('../src/listMethods')
const { MAX_SCHEDULED_REMINDERS } = require('../src/listWire')

const _tmpDirs = []
function tmpStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearlist-'))
  _tmpDirs.push(dir)
  return new Corestore(dir)
}
after(() => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function fakeSwarm () {
  const ee = new EventEmitter()
  ee.left = []
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = (topic) => { ee.left.push(topic) }
  ee.destroy = async () => {}
  return ee
}

// A driver around the engine's IPC loop: feed a method call, await its reply.
function driver () {
  const responses = []
  const read = new EventEmitter()
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: tmpStore(), createSwarm: fakeSwarm,
    applyOps: applyListOp, methods: listMethods,
  })
  engine.start({ read, write: (buf) => responses.push(JSON.parse(buf.toString())) })
  let nextId = 1
  const call = async (method, args) => {
    const id = nextId++
    read.emit('data', Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
    for (let i = 0; i < 200; i++) {
      const r = responses.find(x => x.id === id)
      if (r) { if (r.error) throw new Error(r.error); return r.result }
      await new Promise(res => setTimeout(res, 10))
    }
    throw new Error('timed out: ' + method)
  }
  return { engine, call }
}

test('create a list, add items, read them back', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Household' })

  const { listId } = await call('list:create', { groupId, name: 'Groceries' })
  assert.ok(listId)
  const lists = await call('list:getAll', { groupId })
  assert.equal(lists.length, 1)
  assert.equal(lists[0].name, 'Groceries')

  await call('item:add', { groupId, listId, text: 'milk' })
  await call('item:add', { groupId, listId, text: 'eggs', qty: 12 })
  const items = await call('item:getAll', { groupId, listId })
  assert.equal(items.length, 2)
  assert.deepEqual(items.map(i => i.text).sort(), ['eggs', 'milk'])
  assert.equal(items.find(i => i.text === 'eggs').qty, 12)
  assert.equal(items.every(i => i.checked === false), true)
  await engine.close()
})

test('toggle, edit, and assign an item', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Chores' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'dishes' })

  await call('item:toggle', { groupId, listId, itemId, checked: true })
  await call('item:edit', { groupId, listId, itemId, text: 'wash dishes' })
  await call('item:assign', { groupId, listId, itemId, assignee: 'sam' })

  const [item] = await call('item:getAll', { groupId, listId })
  assert.equal(item.checked, true)
  assert.equal(item.text, 'wash dishes')
  assert.equal(item.assignee, 'sam')
  await engine.close()
})

test('item note + link: stored, sanitized, and clearable', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Groceries' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'Oat milk' })

  // Note is kept; a bare domain link is upgraded to https://.
  await call('item:edit', { groupId, listId, itemId, note: 'the barista blend, 2%', url: 'kroger.com/p/oat-milk' })
  let [it] = await call('item:getAll', { groupId, listId })
  assert.equal(it.note, 'the barista blend, 2%')
  assert.equal(it.url, 'https://kroger.com/p/oat-milk')

  // A full https link is kept as-is; a dangerous scheme is dropped to ''.
  await call('item:edit', { groupId, listId, itemId, url: 'https://shop.example.com/item/9' })
  assert.equal((await call('item:getAll', { groupId, listId }))[0].url, 'https://shop.example.com/item/9')
  await call('item:edit', { groupId, listId, itemId, url: 'javascript:alert(1)' })
  assert.equal((await call('item:getAll', { groupId, listId }))[0].url, '')

  // Editing text alone leaves the note untouched; '' clears the note.
  await call('item:edit', { groupId, listId, itemId, text: 'Oat milk (2 ct)' })
  assert.equal((await call('item:getAll', { groupId, listId }))[0].note, 'the barista blend, 2%')
  await call('item:edit', { groupId, listId, itemId, note: '' })
  assert.equal((await call('item:getAll', { groupId, listId }))[0].note, '')
  await engine.close()
})

test('item suggestions: learns added items, ranks by frequency, matches word prefix', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'G' })
  await call('item:add', { groupId, listId, text: 'Oat milk' })
  await call('item:add', { groupId, listId, text: 'Milk' })
  await call('item:add', { groupId, listId, text: 'Milk' }) // added twice -> ranks higher
  await call('item:add', { groupId, listId, text: 'Bread' })

  // Word-prefix match: "mi" surfaces both "Milk" and "Oat milk".
  const s = await call('item:suggest', { prefix: 'mi' })
  assert.ok(s.includes('Milk') && s.includes('Oat milk'))
  assert.ok(s.indexOf('Milk') < s.indexOf('Oat milk'), 'more frequent item ranks first')
  // The exact current text is excluded (nothing to autocomplete).
  assert.ok(!(await call('item:suggest', { prefix: 'milk' })).includes('Milk'))
  // No prefix returns the top recents.
  assert.ok((await call('item:suggest', {})).includes('Milk'))
  await engine.close()
})

test('deleting an item hides it and survives no-resurrection', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'L' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'gone' })

  await call('item:delete', { groupId, listId, itemId })
  assert.equal((await call('item:getAll', { groupId, listId })).length, 0)

  // A toggle after delete must fail (the row is a tombstone, not found).
  await assert.rejects(() => call('item:toggle', { groupId, listId, itemId, checked: true }))
  await engine.close()
})

test('spaces:list returns each joined space with a re-encodable invite', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const fam = await call('group:create', { name: 'Family' })
  const party = await call('group:create', { name: 'Party Crew' })
  const spaces = await call('spaces:list', {})
  assert.equal(spaces.length, 2)
  const names = spaces.map((s) => s.name).sort()
  assert.deepEqual(names, ['Family', 'Party Crew'])
  const famSpace = spaces.find((s) => s.groupId === fam.groupId)
  assert.equal(typeof famSpace.inviteKey, 'string')
  assert.ok(spaces.find((s) => s.groupId === party.groupId))
  await engine.close()
})

test('profile:set / profile:get round-trip, preserving avatar on a name-only update', async () => {
  const { engine, call } = driver()
  await call('init', {})
  assert.equal(await call('profile:get', {}), null)

  await call('profile:set', { displayName: 'Sam', avatar: 'data:image/png;base64,AAAA' })
  let p = await call('profile:get', {})
  assert.equal(p.displayName, 'Sam')
  assert.equal(p.avatar, 'data:image/png;base64,AAAA')

  // Name-only update keeps the avatar; clearing with null removes it.
  await call('profile:set', { displayName: 'Samantha' })
  p = await call('profile:get', {})
  assert.equal(p.displayName, 'Samantha')
  assert.equal(p.avatar, 'data:image/png;base64,AAAA')

  await call('profile:set', { displayName: 'Samantha', avatar: null })
  p = await call('profile:get', {})
  assert.equal(p.avatar, undefined)

  await assert.rejects(() => call('profile:set', { displayName: '' }))
  await engine.close()
})

test('donation reminder: fresh is not due, dismiss marks it shown', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const s1 = await call('donation:status', {})
  assert.equal(s1.due, false) // first use just now, 14 days not elapsed
  assert.equal(s1.shown, false)
  assert.equal(typeof s1.firstUseAt, 'number')
  await call('donation:dismiss', {})
  const s2 = await call('donation:status', {})
  assert.equal(s2.shown, true)
  assert.equal(s2.due, false)
  await engine.close()
})

test('donation reminder: due once 14 days have elapsed, then dismiss stops it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  // Seed a first-use 15 days ago (the nudge triggers at 14). Seeding the localDb
  // row directly stands in for "the app has been in use for two weeks".
  const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000
  await engine.localDb.put('donateReminder', { firstUseAt: fifteenDaysAgo, shown: false })

  const due = await call('donation:status', {})
  assert.equal(due.due, true) // 14 days elapsed and not yet shown -> due
  assert.equal(due.shown, false)
  assert.equal(due.firstUseAt, fifteenDaysAgo) // existing first-use is preserved, not reset

  // The UI marks it shown the moment it surfaces, so it never nags twice.
  await call('donation:dismiss', {})
  const after = await call('donation:status', {})
  assert.equal(after.shown, true)
  assert.equal(after.due, false)
  await engine.close()
})

test('avatar stored as a blob reference (not inline), resolves back for the UI', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const png = 'data:image/png;base64,' + 'A'.repeat(4096) // ~3 KB of bytes
  await call('profile:set', { displayName: 'Sam', avatar: png })
  const id = await call('identity:get', {})

  // The replicated member row carries only a tiny reference, NOT the bytes.
  const base = engine.bases.get(groupId)
  await base.update()
  const row = (await base.view.get('member:' + id.pubkey)).value
  assert.equal(row.avatar, undefined)
  assert.ok(row.avatarBlob && typeof row.avatarBlob.key === 'string')
  // The row (a reference) is far smaller than the inline data URL it replaced.
  assert.ok(JSON.stringify(row).length < png.length / 4, 'member row stays small')

  // profile:get and member:getAll resolve the reference back to the data URL.
  assert.equal((await call('profile:get', {})).avatar, png)
  assert.equal((await call('member:getAll', { groupId }))[0].avatar, png)

  // A name-only edit reuses the same blob ref (no re-append of the bytes).
  await call('profile:set', { displayName: 'Samantha' })
  await base.update()
  const row2 = (await base.view.get('member:' + id.pubkey)).value
  assert.deepEqual(row2.avatarBlob, row.avatarBlob)
  await engine.close()
})

test('member roster: publish self, read it, and assign a list to a member', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  await call('profile:set', { displayName: 'Sam' }) // republishes the member row
  const id = await call('identity:get', {})

  const members = await call('member:getAll', { groupId })
  assert.equal(members.length, 1)
  assert.equal(members[0].pubkey, id.pubkey)
  assert.equal(members[0].displayName, 'Sam')

  const { listId } = await call('list:create', { groupId, name: 'Chores' })
  await call('list:assign', { groupId, listId, assignee: id.pubkey })
  assert.equal((await call('list:getAll', { groupId })).find(l => l.id === listId).assignee, id.pubkey)

  await call('list:assign', { groupId, listId, assignee: null }) // unassign
  assert.equal((await call('list:getAll', { groupId })).find(l => l.id === listId).assignee, null)
  await engine.close()
})

test('space: owner flag, owner delete writes a tombstone + forgets it locally', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Fam' })
  await call('space:init', { groupId, name: 'Fam' }) // claim ownership

  const spaces = await call('spaces:list', {})
  assert.equal(spaces.find((s) => s.groupId === groupId).owner, true)

  const res = await call('space:delete', { groupId })
  assert.deepEqual(res, { ok: true })

  // The owner's tombstone is accepted into the shared view (founder-write rule).
  const base = engine.bases.get(groupId)
  await base.update()
  assert.equal((await base.view.get('space')).value.deleted, true)

  // And it is forgotten locally (dropped from the space list).
  assert.ok(!(await call('spaces:list', {})).some((s) => s.groupId === groupId))
  await engine.close()
})

test('space: legacy space with no owner record is migrated to the founder', async () => {
  const { engine, call } = driver()
  await call('init', {})
  // group:create does NOT write a `space` record (that is the UI's space:init),
  // so this stands in for a space created before signed ownership existed.
  const { groupId } = await call('group:create', { name: 'Legacy' })
  const base = engine.bases.get(groupId)
  await base.update()
  assert.equal(await base.view.get('space'), null) // no owner record yet

  // Listing migrates it: the founder claims ownership once.
  assert.equal((await call('spaces:list', {})).find((s) => s.groupId === groupId).owner, true)
  await base.update()
  assert.equal((await base.view.get('space')).value.owner, (await call('identity:get', {})).pubkey)

  // And the migrated owner can now delete it.
  assert.deepEqual(await call('space:delete', { groupId }), { ok: true })
  await engine.close()
})

test('space:forget drops a space from spaces:list AND tears down its base + topic', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Temp' })
  assert.ok(engine.bases.has(groupId), 'base mounted while joined')
  const leftBefore = engine.swarm.left.length

  await call('space:forget', { groupId })

  assert.ok(!(await call('spaces:list', {})).some((s) => s.groupId === groupId))
  assert.ok(!engine.bases.has(groupId), 'base unmounted so it stops replicating')
  assert.equal(engine.swarm.left.length, leftBefore + 1, 'left the swarm topic')
  await engine.close()
})

// A joined-but-never-admitted device: mounted against a bootstrap nobody hosts,
// so it can read nothing and write nothing. This is the state behind the
// 2026-07-28 report - a rejoined phone showing a space name and nothing else - and
// the two things it must still be able to do are SEE why, and LEAVE.
function ghostInvite (name = 'Ghost') {
  const hex = (n) => require('node:crypto').randomBytes(n).toString('hex')
  return require('@peerloom/core/engine').defaultEncodeInvite({
    groupId: hex(16), groupKey: hex(32), encryptionKey: hex(32), bootstrap: hex(32), name,
  })
}

test('space:status reports an unadmitted space as not writable and empty', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:join', { inviteKey: ghostInvite() })

  const st = await call('space:status', { groupId })
  assert.equal(st.writable, false, 'never admitted, so not writable')
  assert.equal(st.members, 0, 'no roster arrived')
  assert.equal(st.lists, 0, 'no lists arrived')
  await engine.close()
})

test('space:leave works on a space we were never admitted to', async () => {
  // Regression: leave appended a `left` roster row unconditionally, so on an
  // unadmitted base Autobase threw `Not writable` and the whole method failed -
  // the user could not remove a dead space from their phone at all. There is
  // nothing to retract there anyway: no peer ever saw us as a member.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:join', { inviteKey: ghostInvite() })
  assert.equal(engine.bases.get(groupId).writable, false)

  const res = await call('space:leave', { groupId })
  assert.equal(res.ok, true)
  assert.equal(res.retracted, false, 'nothing to retract when we were never a member')
  assert.ok(!(await call('spaces:list', {})).some((s) => s.groupId === groupId), 'dropped locally')
  await engine.close()
})

test('space:leave still retracts the roster row when we ARE a member', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Fam' })
  await call('space:init', { groupId, name: 'Fam' })
  await call('member:publish', { groupId })

  const res = await call('space:leave', { groupId })
  assert.equal(res.retracted, true)
  const base = engine.bases.get(groupId)
  await base.update()
  const self = (await call('identity:get', {})).pubkey
  assert.equal((await base.view.get('member:' + self)).value.left, true)
  await engine.close()
})


test('backup covers every space on the device, not the one on screen', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const a = await call('group:create', { name: 'Fresh' })
  await call('space:init', { groupId: a.groupId, name: 'Fresh' })
  const { listId } = await call('list:create', { groupId: a.groupId, name: 'Groceries', kind: 'grocery' })
  const { itemId } = await call('item:add', { groupId: a.groupId, listId, text: 'Milk', qty: 2 })
  await call('item:toggle', { groupId: a.groupId, listId, itemId, checked: true })

  const b = await call('group:create', { name: 'family' })
  await call('space:init', { groupId: b.groupId, name: 'family' })
  const l2 = await call('list:create', { groupId: b.groupId, name: 'Chores', kind: 'chore' })
  await call('item:add', { groupId: b.groupId, listId: l2.listId, text: 'Bins' })

  const exp = await call('backup:export', {})
  assert.equal(exp.counts.spaces, 2)
  assert.equal(exp.counts.lists, 2)
  assert.equal(exp.counts.items, 2)
  assert.match(exp.filename, /^pearlist-backup-\d{4}-\d{2}-\d{2}\.json$/)
  const doc = JSON.parse(exp.json)
  assert.deepEqual(doc.spaces.map((s) => s.name).sort(), ['family', 'Fresh'].sort())

  const imp = await call('backup:import', { jsonString: exp.json })
  assert.equal(imp.counts.spaces, 2)
  const ids = new Set(imp.spaces.map((s) => s.groupId))
  assert.ok(!ids.has(a.groupId) && !ids.has(b.groupId), 'NEW spaces, never merged into the old ones')

  const restoredFresh = imp.spaces.find((s) => s.name === 'Fresh')
  const lists = await call('list:getAll', { groupId: restoredFresh.groupId })
  assert.deepEqual(lists.map((l) => l.name), ['Groceries'])
  assert.equal(lists[0].kind, 'grocery')
  const items = await call('item:getAll', { groupId: restoredFresh.groupId, listId: lists[0].id })
  assert.equal(items[0].text, 'Milk')
  assert.equal(items[0].checked, true, 'checked state survives (unlike a template)')
  assert.equal(items[0].qty, 2)
  await engine.close()
})

test('the importing device owns every restored space and can write to it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Old' })
  const { listId } = await call('list:create', { groupId, name: 'L' })
  await call('item:add', { groupId, listId, text: 'x' })
  const exp = await call('backup:export', {})

  const imp = await call('backup:import', { jsonString: exp.json })
  const spaces = await call('spaces:list', {})
  for (const s of imp.spaces) {
    assert.equal(spaces.find((x) => x.groupId === s.groupId).owner, true)
  }
  // And they are normal, writable spaces: adding to one works.
  const target = imp.spaces[0].groupId
  const lid = (await call('list:getAll', { groupId: target }))[0].id
  await call('item:add', { groupId: target, listId: lid, text: 'added after import' })
  assert.equal((await call('item:getAll', { groupId: target, listId: lid })).length, 2)
  await engine.close()
})

test('backup:export includes a space we can only read', async () => {
  // The rescue case: a device that joined but was never admitted cannot append,
  // so an export that wrote anything would throw exactly when it is needed most -
  // and a per-space export would also have to be aimed at the right space by a
  // user who has no idea which one is broken.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Mine' })
  const { listId } = await call('list:create', { groupId, name: 'L' })
  await call('item:add', { groupId, listId, text: 'x' })
  const stuck = await call('group:join', { inviteKey: ghostInvite('Stuck') })
  assert.equal(engine.bases.get(stuck.groupId).writable, false)

  const exp = await call('backup:export', {})
  const names = JSON.parse(exp.json).spaces.map((s) => s.name)
  assert.ok(names.includes('Mine'))
  // The stuck space replicated nothing, so it has no lists and is dropped on the
  // way back IN - but exporting it must not throw, and must not lose the others.
  assert.equal(exp.counts.spaces >= 1, true)
  await engine.close()
})

test('a recurring chore comes back DONE, not due, after a restore', async () => {
  // End to end through the real IPC loop, because the interesting part is not the
  // file - it is that item:getAll DERIVES a repeating item's checked state from
  // lastDoneAt. Without it carried, a chore done a minute ago reads as due again.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Home' })
  const { listId } = await call('list:create', { groupId, name: 'Chores', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'Bins' })
  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly' })
  await call('item:toggle', { groupId, listId, itemId, checked: true })
  assert.equal((await call('item:getAll', { groupId, listId }))[0].checked, true, 'done before the backup')

  const exp = await call('backup:export', {})
  const imp = await call('backup:import', { jsonString: exp.json })
  const restored = imp.spaces.find((s) => s.name === 'Home')
  const lid = (await call('list:getAll', { groupId: restored.groupId }))[0].id
  const [item] = await call('item:getAll', { groupId: restored.groupId, listId: lid })

  assert.equal(item.text, 'Bins')
  assert.ok(item.repeat, 'still repeating')
  assert.equal(item.checked, true, 'and still done for this period, not reset to due')
  await engine.close()
})

test('a pinned aisle and a list notify setting survive a real restore', async () => {
  // The two omissions the 2026-07-28 field audit found, end to end.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Home' })
  const { listId } = await call('list:create', { groupId, name: 'Chores', kind: 'chore' })
  await call('list:setNotifyOnComplete', { groupId, listId, mode: 'done' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'Flour' })
  await call('ai:setCategory', { groupId, listId, itemId, category: 'Baking', by: 'user' })

  const exp = await call('backup:export', {})
  const imp = await call('backup:import', { jsonString: exp.json })
  const restored = imp.spaces.find((s) => s.name === 'Home')
  const [list] = await call('list:getAll', { groupId: restored.groupId })
  assert.equal(list.notifyOnComplete, 'done', 'the list keeps the setting the user chose')
  const [item] = await call('item:getAll', { groupId: restored.groupId, listId: list.id })
  assert.equal(item.category, 'Baking')
  assert.equal(item.catBy, 'user', 'and the aisle stays pinned as a hand-made choice')
  await engine.close()
})

test('an item reminder is NOT carried into a restore', async () => {
  // Deliberate: remindAt is an absolute instant, so a month-old backup would hand
  // the OS a pile of past-dated reminders. The UI says so after every import.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Home' })
  const { listId } = await call('list:create', { groupId, name: 'L' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'Call the vet' })
  await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + 86400000 })
  assert.ok((await call('item:getAll', { groupId, listId }))[0].remindAt, 'set before the backup')

  const exp = await call('backup:export', {})
  assert.doesNotMatch(exp.json, /remindAt/, 'not even present in the file')
  const imp = await call('backup:import', { jsonString: exp.json })
  const restored = imp.spaces.find((s) => s.name === 'Home')
  const lid = (await call('list:getAll', { groupId: restored.groupId }))[0].id
  assert.equal((await call('item:getAll', { groupId: restored.groupId, listId: lid }))[0].remindAt, undefined)
  await engine.close()
})

test('saved lists survive a restore, and an existing one is never overwritten', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Home' })
  const { listId } = await call('list:create', { groupId, name: 'Monthly shop', kind: 'grocery' })
  await call('item:add', { groupId, listId, text: 'Rice' })
  await call('template:save', { groupId, listId, name: 'Monthly shop' })

  const exp = await call('backup:export', {})
  assert.equal(exp.counts.templates, 1, 'the saved list is in the file')

  // Importing onto the SAME device, which already holds that template by name.
  const again = await call('backup:import', { jsonString: exp.json })
  assert.equal(again.counts.templates, 0, 'nothing added: the name is already taken')
  assert.equal((await call('template:list', {})).length, 1, 'and it was not duplicated')

  // The one that matters is a fresh device, where nothing collides.
  const fresh = driver()
  await fresh.call('init', {})
  const restored = await fresh.call('backup:import', { jsonString: exp.json })
  assert.equal(restored.counts.templates, 1)
  const [t] = await fresh.call('template:list', {})
  assert.equal(t.name, 'Monthly shop')
  assert.equal(t.count, 1)
  await engine.close(); await fresh.engine.close()
})

test('learned aisles and hand-made aisle names ride through the worklet', async () => {
  // Both live in the WebView's localStorage, so the worklet only ferries them:
  // in as arguments to export, out as results from import. The custom aisles come
  // back keyed by the id the space was JUST given, which only the worklet knows.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Home' })
  const { listId } = await call('list:create', { groupId, name: 'G', kind: 'grocery' })
  await call('item:add', { groupId, listId, text: 'Milk' })

  const exp = await call('backup:export', {
    learnedAisles: { parmesan: 'Baking' },
    customAisles: { [groupId]: ['Deli counter'] },
  })
  assert.equal(exp.counts.learnedAisles, 1)

  const imp = await call('backup:import', { jsonString: exp.json })
  assert.deepEqual(imp.learnedAisles, { parmesan: 'Baking' })
  const restored = imp.spaces.find((s) => s.name === 'Home')
  assert.deepEqual(restored.customAisles, ['Deli counter'])
  assert.notEqual(restored.groupId, groupId, 'and they are attached to the NEW space id')
  await engine.close()
})

test('backup:import refuses a file that is not a PearList backup', async () => {
  const { engine, call } = driver()
  await call('init', {})
  await assert.rejects(call('backup:import', { jsonString: '{"kind":"something-else"}' }), /not a PearList backup/)
  await engine.close()
})

// --- device-link (SLICE 1, dark) -------------------------------------------
// proposals/2026-07-28-device-linking.md. The engine is constructed beside the
// group engine on the SAME runtime; these assert it comes up and that an ordinary
// build is untouched by its presence.
const deviceLink = require('../src/deviceLink')

test('device:status reports disabled on an ordinary build', async () => {
  // The flag is off in a normal build, and the method must answer rather than
  // throw - the UI asks unconditionally.
  const { engine, call } = driver()
  await call('init', {})
  assert.deepEqual(await call('device:status', {}), { enabled: false })
  await engine.close()
})

test('device-link starts on the shared runtime and derives a stable identity', async (t) => {
  // Drives the factory directly rather than flipping the constant, so the test
  // says what it means and does not depend on build config.
  const { engine, call } = driver()
  await call('init', {})
  deviceLink._resetForTest()
  t.after(() => deviceLink._resetForTest())

  const ctx = { store: engine.store, swarm: engine.swarm, localDb: engine.localDb, emit: () => {} }
  const dl = await deviceLink.getDeviceLink(ctx)

  assert.match(dl.identityPublicKeyHex, /^[0-9a-f]{64}$/, 'an identity is derived from the mnemonic')
  // The mnemonic is persisted, so the identity is stable rather than minted per
  // launch - the whole point of it being a RECOVERY phrase.
  const stored = (await engine.localDb.get(deviceLink.MNEMONIC_KEY)).value.mnemonic
  assert.equal(stored.split(' ').length, 12)

  deviceLink._resetForTest()
  const again = await deviceLink.getDeviceLink(ctx)
  assert.equal(again.identityPublicKeyHex, dl.identityPublicKeyHex, 'same phrase, same identity')

  await dl.stop().catch(() => {})
  await engine.close()
})

test('device-link identity is NOT the signing identity (coexist, slice 1)', async (t) => {
  // The thing most likely to be assumed wrong: adopting device-link does not
  // change who signs a row. Space rows stay on core's per-device keypair, which
  // is why two phones are still two members until the mnemonic-root slice.
  const { engine, call } = driver()
  await call('init', {})
  deviceLink._resetForTest()
  t.after(() => deviceLink._resetForTest())

  const dl = await deviceLink.getDeviceLink({ store: engine.store, swarm: engine.swarm, localDb: engine.localDb, emit: () => {} })
  const signing = Buffer.from(engine.identity.publicKey).toString('hex')
  assert.notEqual(dl.identityPublicKeyHex, signing)
  await dl.stop().catch(() => {})
  await engine.close()
})

test('the pair link uses OUR scheme, not device-link\'s default', async () => {
  // device-link builds `peerloom://pair?...` by default - a scheme this app is not
  // registered for. A link built there would be shown to a user and open nothing,
  // so PearList builds its own from the session snapshot.
  const { buildPairLink, parsePairLink } = require('../src/deviceLink')
  const url = buildPairLink({ topic: 'a'.repeat(64), handshake: 'b'.repeat(64), identity: 'c'.repeat(64), expiresMs: Date.now() + 60000 })
  assert.ok(url.startsWith('pear://pearlist-device?'), 'our scheme: ' + url.slice(0, 40))
  const parsed = parsePairLink(url)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.identity, 'c'.repeat(64))
})

test('a SPACE invite is not accepted as a device link, or the reverse', async () => {
  // The two links look similar and mean opposite things: an invite is safe to
  // forward, a device link hands over your identity. Different hosts so a
  // mis-paste is refused outright rather than half-understood.
  const { parsePairLink } = require('../src/deviceLink')
  const spaceInvite = 'pear://pearlist/join#' + Buffer.from('{}').toString('base64url')
  assert.equal(parsePairLink(spaceInvite).ok, false)
})

test('the group plugin carries every space, and re-seeding is idempotent', async (t) => {
  // The leg PearPetal does not have: a linked device that cannot write to any
  // space has gained nothing. Drives the plugin directly - the pairing handshake
  // itself is device-link's own integration test.
  const deviceLink = require('../src/deviceLink')
  const { engine, call } = driver()
  await call('init', {})
  deviceLink._resetForTest()
  t.after(() => deviceLink._resetForTest())

  const a = await call('group:create', { name: 'Home' })
  await call('group:create', { name: 'Work' })

  // Reach the plugin the way device-link does, through the engine's method ctx.
  const ctx = { store: engine.store, swarm: engine.swarm, localDb: engine.localDb, emit: () => {}, append: engine.append, joinGroup: engine.joinGroup }
  const dl = await deviceLink.getDeviceLink(ctx)
  const plugin = deviceLink._groupPluginForTest(ctx)

  const groups = await plugin.collectGroups()
  assert.equal(groups.length, 2, 'both spaces collected')
  const home = groups.find((g) => g.name === 'Home')
  assert.equal(home.groupId, a.groupId)
  assert.ok(home.groupKey && home.encryptionKey && home.bootstrap, 'everything a join needs travels')

  // Seeding spaces this device is already in must be a no-op, not a second mount.
  const before = engine.bases.size
  await plugin.seedGroups(groups)
  assert.equal(engine.bases.size, before, 'already-joined spaces are skipped')

  await dl.stop().catch(() => {})
  await engine.close()
})

test('the device-link trace REDACTS the pair secrets', () => {
  // The trace is console.warn'd AND written to a file that gets pulled off the
  // device. A pair snapshot carries topic + handshake + identity, and together
  // those ARE the link - which hands over an identity. Logging them in full would
  // turn a diagnostic into a credential leak.
  const { _safeEventData } = require('../src/deviceLink')
  const SECRET = 'deadbeef'.repeat(8) // 64 hex, like the real thing

  const out = _safeEventData({
    role: 'primary', topicHex: SECRET, handshakeHex: SECRET, identityHex: SECRET,
    writerKey: SECRET, expiresAt: 123,
  })

  const dumped = JSON.stringify(out)
  assert.doesNotMatch(dumped, new RegExp(SECRET), 'no secret survives in full')
  for (const k of ['topicHex', 'handshakeHex', 'identityHex', 'writerKey']) {
    assert.equal(out[k], 'deadbeef…', k + ' is a short prefix')
  }
  // Short prefixes are kept deliberately: they are what lets two devices' logs be
  // correlated, which is the entire reason for tracing this at all.
  assert.equal(out.role, 'primary', 'safe fields pass through untouched')
  assert.equal(out.expiresAt, 123)
})

test('destroyGroup unmounts a group but leaves other groups intact', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const a = await call('group:create', { name: 'A' })
  const b = await call('group:create', { name: 'B' })
  const { listId } = await call('list:create', { groupId: b.groupId, name: 'L' })
  await call('item:add', { groupId: b.groupId, listId, text: 'keep me' })

  await engine.destroyGroup(a.groupId)
  assert.ok(!engine.bases.has(a.groupId), 'A unmounted')
  assert.ok(engine.bases.has(b.groupId), 'B still mounted')
  // B still fully works after A is destroyed.
  assert.equal((await call('item:getAll', { groupId: b.groupId, listId }))[0].text, 'keep me')
  await call('item:add', { groupId: b.groupId, listId, text: 'still writable' })
  assert.equal((await call('item:getAll', { groupId: b.groupId, listId })).length, 2)
  await engine.close()
})

test('list category: create carries a kind, defaults to list, normalizes junk, setKind changes it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })

  // Explicit kind is stored.
  const chores = await call('list:create', { groupId, name: 'Chores', kind: 'chore' })
  // Omitted kind defaults to the generic 'list'.
  const misc = await call('list:create', { groupId, name: 'Misc' })
  // An unknown kind is normalized to 'list', never stored as-is.
  const junk = await call('list:create', { groupId, name: 'Junk', kind: 'not-a-kind' })

  const byId = (id) => (lists.find((l) => l.id === id))
  let lists = await call('list:getAll', { groupId })
  assert.equal(byId(chores.listId).kind, 'chore')
  assert.equal(byId(misc.listId).kind, 'list')
  assert.equal(byId(junk.listId).kind, 'list')

  // setKind changes the category (and re-normalizes).
  await call('list:setKind', { groupId, listId: misc.listId, kind: 'grocery' })
  await call('list:setKind', { groupId, listId: chores.listId, kind: 'bogus' })
  lists = await call('list:getAll', { groupId })
  assert.equal(byId(misc.listId).kind, 'grocery')
  assert.equal(byId(chores.listId).kind, 'list')

  // setKind on a missing list rejects.
  await assert.rejects(() => call('list:setKind', { groupId, listId: 'nope', kind: 'chore' }))
  await engine.close()
})

test('list:setNotifyOnComplete stores a normalized mode; junk falls back to off', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Chores', kind: 'chore' })
  const modeOf = async () => (await call('list:getAll', { groupId })).find((l) => l.id === listId).notifyOnComplete

  // A fresh list has no explicit mode (the default is derived in the worklet).
  assert.equal(await modeOf(), undefined)
  await call('list:setNotifyOnComplete', { groupId, listId, mode: 'each' })
  assert.equal(await modeOf(), 'each')
  await call('list:setNotifyOnComplete', { groupId, listId, mode: 'done' })
  assert.equal(await modeOf(), 'done')
  // Junk normalizes to 'off', never stored as-is.
  await call('list:setNotifyOnComplete', { groupId, listId, mode: 'bogus' })
  assert.equal(await modeOf(), 'off')
  // Missing list rejects.
  await assert.rejects(() => call('list:setNotifyOnComplete', { groupId, listId: 'nope', mode: 'each' }))
  await engine.close()
})

test('deleting a list hides it from list:getAll', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Temp' })
  await call('list:delete', { groupId, listId })
  assert.equal((await call('list:getAll', { groupId })).length, 0)
  await engine.close()
})

test('space:retain prunes old blocks but items stay intact and writable', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Churny' })
  const { listId } = await call('list:create', { groupId, name: 'L' })
  for (let i = 0; i < 200; i++) await call('item:add', { groupId, listId, text: 'i' + i })
  const base = engine.bases.get(groupId); await base.update()

  const res = await call('space:retain', { groupId, keepRecent: 20 })
  assert.equal(res.ok, true)
  assert.ok(res.cleared > 0, 'pruned some blocks')
  assert.equal(await base.local.has(0), false, 'oldest block pruned')

  // No data loss: all 200 items still readable, and the list is still writable.
  assert.equal((await call('item:getAll', { groupId, listId })).length, 200)
  await call('item:add', { groupId, listId, text: 'after' })
  assert.equal((await call('item:getAll', { groupId, listId })).length, 201)
  await engine.close()
})

// --- note lists (proposals/2026-07-20-note-lists.md) ------------------------

const { noteTextOf, sortNoteRows } = require('../src/noteText')

// item:getAll returns rows in Hyperbee key order, so a baseline is built the way
// the editor builds one: sorted into document order first.
const baselineOf = (rows) => sortNoteRows(rows).map((r) => ({ id: r.id, text: r.text }))

test("note:save writes a note's lines as ordered rows and reads back verbatim", async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Wifi', kind: 'note' })

  const lists = await call('list:getAll', { groupId })
  assert.equal(lists.find((l) => l.id === listId).kind, 'note', "'note' is a real kind, not normalized away")

  const text = 'Router password\n\nhunter2\nback of the router'
  await call('note:save', { groupId, listId, baseline: [], lines: text.split('\n') })

  const rows = await call('item:getAll', { groupId, listId })
  assert.equal(rows.length, 4, 'one row per line, blank line included')
  assert.equal(noteTextOf(rows), text, 'round-trips exactly, blank line and all')
  assert.equal(rows.every((r) => typeof r.ord === 'string' && r.ord), true, 'every line carries an ord')
  await engine.close()
})

test('note:save edits one line in place, keeping the row and its ord', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'N', kind: 'note' })

  await call('note:save', { groupId, listId, baseline: [], lines: ['one', 'two', 'three'] })
  const before = await call('item:getAll', { groupId, listId })
  const baseline = baselineOf(before)
  const target = before.find((r) => r.text === 'two')

  const res = await call('note:save', { groupId, listId, baseline, lines: ['one', 'TWO', 'three'] })
  assert.deepEqual({ ...res }, { updated: 1, deleted: 0, inserted: 0 }, 'an edit is one update, not a delete + insert')

  const after = await call('item:getAll', { groupId, listId })
  assert.equal(after.length, 3)
  const edited = after.find((r) => r.id === target.id)
  assert.equal(edited.text, 'TWO', 'the same row now holds the new text')
  assert.equal(edited.ord, target.ord, 'its position is untouched')
  assert.equal(noteTextOf(after), 'one\nTWO\nthree')
  await engine.close()
})

test('note:save inserts a line in the middle without renumbering the others', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'N', kind: 'note' })

  await call('note:save', { groupId, listId, baseline: [], lines: ['one', 'three'] })
  const before = await call('item:getAll', { groupId, listId })
  const ords = Object.fromEntries(before.map((r) => [r.text, r.ord]))

  await call('note:save', {
    groupId, listId, baseline: baselineOf(before), lines: ['one', 'two', 'three'],
  })
  const after = await call('item:getAll', { groupId, listId })
  assert.equal(noteTextOf(after), 'one\ntwo\nthree')
  // The whole point of a fractional index: the neighbours were not rewritten.
  for (const t of ['one', 'three']) assert.equal(after.find((r) => r.text === t).ord, ords[t], t + ' kept its ord')
  await engine.close()
})

test('note:save does not clobber a line another writer added mid-edit', async () => {
  // The three-way merge, end to end. We load the note, something else appends to
  // it, and only THEN do we save an edit derived from the stale baseline.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'N', kind: 'note' })

  await call('note:save', { groupId, listId, baseline: [], lines: ['one', 'two'] })
  const loaded = await call('item:getAll', { groupId, listId })
  const staleBaseline = baselineOf(loaded)

  // Someone else appends a third line while our editor is open.
  await call('note:save', {
    groupId, listId, baseline: staleBaseline, lines: ['one', 'two', 'theirs'],
  })

  // We now save our own edit, still derived from the baseline we loaded.
  await call('note:save', { groupId, listId, baseline: staleBaseline, lines: ['one', 'TWO'] })

  const after = await call('item:getAll', { groupId, listId })
  assert.equal(after.some((r) => r.text === 'theirs'), true, "their line survived our save")
  assert.equal(after.some((r) => r.text === 'TWO'), true, 'our edit landed')
  assert.equal(after.length, 3)
  await engine.close()
})

test('note:save deleting a line tombstones it, and no-resurrection holds', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'N', kind: 'note' })

  await call('note:save', { groupId, listId, baseline: [], lines: ['keep', 'drop'] })
  const before = await call('item:getAll', { groupId, listId })
  const baseline = baselineOf(before)

  await call('note:save', { groupId, listId, baseline, lines: ['keep'] })
  let after = await call('item:getAll', { groupId, listId })
  assert.deepEqual(after.map((r) => r.text), ['keep'])

  // A stale editor still showing the deleted line does not resurrect it. Its
  // baseline and its text agree that the line is unchanged, so it plans nothing
  // and whoever deleted the line wins. The stale screen catches up on its next
  // hydration - which is the right way round: the alternative is that anyone with
  // the note open silently undoes everyone else's deletions.
  await call('note:save', { groupId, listId, baseline, lines: ['keep', 'drop'] })
  after = await call('item:getAll', { groupId, listId })
  assert.deepEqual(after.map((r) => r.text), ['keep'], "a peer's delete beats a stale view")

  // Deliberately typing the line again, from an up-to-date baseline, DOES add it
  // back - as a new row, since no-resurrection makes the tombstoned key unusable.
  const fresh = await call('item:getAll', { groupId, listId })
  await call('note:save', { groupId, listId, baseline: baselineOf(fresh), lines: ['keep', 'drop'] })
  after = await call('item:getAll', { groupId, listId })
  assert.deepEqual(sortNoteRows(after).map((r) => r.text), ['keep', 'drop'])
  assert.equal(after.some((r) => r.text === 'drop' && r.id === baseline[1].id), false, 'a new row, not the old key')
  await engine.close()
})

test('note:save rejects a missing or deleted list', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'N', kind: 'note' })
  await assert.rejects(() => call('note:save', { groupId, listId: 'nope', baseline: [], lines: ['x'] }))
  await call('list:delete', { groupId, listId })
  await assert.rejects(() => call('note:save', { groupId, listId, baseline: [], lines: ['x'] }))
  await engine.close()
})

test('a note line does not pollute the shopping autosuggest corpus', async () => {
  // item:add feeds the recents corpus. Note prose must not turn up as a
  // suggestion when someone is adding groceries.
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const note = await call('list:create', { groupId, name: 'Note', kind: 'note' })
  const shop = await call('list:create', { groupId, name: 'Shop', kind: 'grocery' })

  await call('item:add', { groupId, listId: note.listId, text: 'milkshake recipe from mum' })
  await call('item:add', { groupId, listId: shop.listId, text: 'milk' })

  // 'mil' rather than 'milk': item:suggest excludes an exact match, since there
  // would be nothing left to autocomplete.
  const suggestions = await call('item:suggest', { prefix: 'mil' })
  assert.deepEqual(suggestions, ['milk'], 'only the grocery item was learned')
  await engine.close()
})

// --- saved list templates (device-local) ------------------------------------

test('save a list as a template, then start a new list from it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const shop = await call('list:create', { groupId, name: 'Weekly shop', kind: 'grocery' })
  await call('item:add', { groupId, listId: shop.listId, text: 'milk', qty: 2 })
  const bread = await call('item:add', { groupId, listId: shop.listId, text: 'bread' })

  // Check one off: the template must capture the SHAPE, not the state.
  await call('item:toggle', { groupId, listId: shop.listId, itemId: bread.itemId, checked: true })

  const saved = await call('template:save', { groupId, listId: shop.listId })
  assert.equal(saved.count, 2)
  assert.equal(saved.name, 'Weekly shop')

  const listed = await call('template:list', {})
  assert.equal(listed.length, 1)
  assert.equal(listed[0].kind, 'grocery')
  assert.equal(listed[0].count, 2)

  const applied = await call('template:apply', { groupId, id: saved.id })
  assert.equal(applied.added, 2)
  assert.notEqual(applied.listId, shop.listId, 'a NEW list, not the one it was saved from')

  const items = await call('item:getAll', { groupId, listId: applied.listId })
  assert.deepEqual(items.map((i) => i.text).sort(), ['bread', 'milk'])
  assert.ok(items.every((i) => !i.checked), 'a list started from a template begins unchecked')
  assert.equal(items.find((i) => i.text === 'milk').qty, 2, 'quantities carry over')

  const lists = await call('list:getAll', { groupId })
  assert.equal(lists.filter((l) => l.name === 'Weekly shop').length, 2, 'original and the new one')
  assert.equal(lists.find((l) => l.id === applied.listId).kind, 'grocery', 'kind carries over')
  await engine.close()
})

test('re-saving under the same name replaces rather than duplicates', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const l = await call('list:create', { groupId, name: 'Shop', kind: 'grocery' })
  await call('item:add', { groupId, listId: l.listId, text: 'milk' })
  const first = await call('template:save', { groupId, listId: l.listId })

  await call('item:add', { groupId, listId: l.listId, text: 'eggs' })
  const second = await call('template:save', { groupId, listId: l.listId })

  assert.equal(second.replaced, true)
  assert.equal(second.id, first.id, 'same template, refreshed')
  const listed = await call('template:list', {})
  assert.equal(listed.length, 1, 'not two near-identical entries')
  assert.equal(listed[0].count, 2)
  await engine.close()
})

test('templates are device-local: nothing about them reaches the space', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const l = await call('list:create', { groupId, name: 'Shop' })
  await call('item:add', { groupId, listId: l.listId, text: 'milk' })
  await call('template:save', { groupId, listId: l.listId })

  // The replicated view holds exactly the one list and its one item. A template
  // that leaked into it would be a row an older peer could not interpret.
  const lists = await call('list:getAll', { groupId })
  assert.equal(lists.length, 1)
  assert.equal((await call('item:getAll', { groupId, listId: l.listId })).length, 1)
  await engine.close()
})

test('saving an empty list is refused, and deleting forgets it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const empty = await call('list:create', { groupId, name: 'Empty' })
  await assert.rejects(() => call('template:save', { groupId, listId: empty.listId }), /empty/)

  const l = await call('list:create', { groupId, name: 'Shop' })
  await call('item:add', { groupId, listId: l.listId, text: 'milk' })
  const t = await call('template:save', { groupId, listId: l.listId })
  assert.equal((await call('template:delete', { id: t.id })).deleted, true)
  assert.deepEqual(await call('template:list', {}), [])
  await assert.rejects(() => call('template:apply', { groupId, id: t.id }), /not found/)
  await engine.close()
})

test('a deleted item is not carried into the template', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const l = await call('list:create', { groupId, name: 'Shop' })
  await call('item:add', { groupId, listId: l.listId, text: 'milk' })
  const gone = await call('item:add', { groupId, listId: l.listId, text: 'anchovies' })
  await call('item:delete', { groupId, listId: l.listId, itemId: gone.itemId })

  const t = await call('template:save', { groupId, listId: l.listId })
  assert.equal(t.count, 1)
  const applied = await call('template:apply', { groupId, id: t.id })
  const items = await call('item:getAll', { groupId, listId: applied.listId })
  assert.deepEqual(items.map((i) => i.text), ['milk'])
  await engine.close()
})

test('list:openSummary counts open items across spaces, excluding notes and checked rows', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const a = (await call('group:create', { name: 'Home' })).groupId
  const b = (await call('group:create', { name: 'Cabin' })).groupId

  const chores = (await call('list:create', { groupId: a, name: 'Jobs', kind: 'chore' })).listId
  const shop = (await call('list:create', { groupId: a, name: 'Shopping', kind: 'grocery' })).listId
  const wifi = (await call('list:create', { groupId: a, name: 'Wifi', kind: 'note' })).listId
  const other = (await call('list:create', { groupId: b, name: 'Cabin jobs', kind: 'todo' })).listId
  // No kind at all: created by just typing a name, and it still counts.
  const odds = (await call('list:create', { groupId: a, name: 'Odds' })).listId

  await call('item:add', { groupId: a, listId: chores, text: 'bins' })
  const done = (await call('item:add', { groupId: a, listId: chores, text: 'dishes' })).itemId
  await call('item:toggle', { groupId: a, listId: chores, itemId: done, checked: true })
  const gone = (await call('item:add', { groupId: a, listId: chores, text: 'typo' })).itemId
  await call('item:delete', { groupId: a, listId: chores, itemId: gone })
  await call('item:add', { groupId: a, listId: shop, text: 'milk' })
  await call('item:add', { groupId: b, listId: other, text: 'firewood' })
  await call('item:add', { groupId: a, listId: odds, text: 'fix the gate' })
  // A note's lines are item rows that are never checked. If they counted, this
  // four-line note alone would swamp the digest.
  await call('note:save', { groupId: a, listId: wifi, baseline: [], lines: ['a', 'b', 'c', 'd'] })

  const s = await call('list:openSummary', {})
  assert.equal(s.total, 3, 'bins + firewood + odds; milk is on a SHOPPING list, which never counts')
  assert.equal(s.lists.length, 3)
  assert.equal(s.lists.some((l) => l.listId === wifi), false, 'the note list is absent entirely')
  assert.equal(s.lists.some((l) => l.listId === shop), false, 'the grocery list is absent entirely')
  assert.deepEqual(s.lists.map((l) => l.name), ['Jobs', 'Cabin jobs', 'Odds'], 'chore, todo, then untyped')
  assert.equal(s.lists[0].groupId, a, 'each row says which space it came from')
  assert.equal(s.digest.body, '"Jobs" and 2 other lists still have open items')
  assert.equal(s.digest.listId, chores, 'a tap opens the top list')
  await engine.close()
})

test('list:openSummary returns a null digest once everything is checked off', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })

  assert.equal((await call('list:openSummary', {})).total, 1)
  await call('item:toggle', { groupId, listId, itemId, checked: true })

  const s = await call('list:openSummary', {})
  assert.equal(s.total, 0)
  assert.deepEqual(s.lists, [])
  assert.equal(s.digest, null, 'nothing open -> the shell cancels rather than nagging')
  await engine.close()
})

test('item:setReminder round-trips, clears, and refuses a time already gone', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })

  const when = Date.now() + 60 * 60 * 1000
  const set = await call('item:setReminder', { groupId, listId, itemId, remindAt: when })
  assert.equal(set.remindAt, when)
  assert.ok(set.remindBy, 'the setter is recorded, so the reminder rings on the device that asked')
  let row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(row.remindAt, when)
  assert.equal(row.text, 'bins', 'the rest of the row survives the read-modify-write')

  await assert.rejects(
    () => call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() - 1000 }),
    /already passed/, 'a past time would silently never fire, so it is refused')
  await assert.rejects(
    () => call('item:setReminder', { groupId, listId, itemId, remindAt: 'soon' }), /timestamp/)

  assert.deepEqual(await call('item:setReminder', { groupId, listId, itemId, remindAt: null }), { remindAt: null, remindBy: null })
  row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(row.remindAt, null, 'cleared')
  await engine.close()
})

test('reminder:pending returns only what THIS device should schedule, soonest first', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })

  const soon = Date.now() + 10 * 60 * 1000
  const later = Date.now() + 60 * 60 * 1000
  const a = (await call('item:add', { groupId, listId, text: 'bins' })).itemId
  const b = (await call('item:add', { groupId, listId, text: 'dishes' })).itemId
  const c = (await call('item:add', { groupId, listId, text: 'someone elses' })).itemId
  const d = (await call('item:add', { groupId, listId, text: 'already done' })).itemId
  await call('item:setReminder', { groupId, listId, itemId: a, remindAt: later })
  await call('item:setReminder', { groupId, listId, itemId: b, remindAt: soon })
  await call('item:setReminder', { groupId, listId, itemId: d, remindAt: soon })
  await call('item:toggle', { groupId, listId, itemId: d, checked: true })
  // Assigned to a member who is not us: their phone rings, not ours.
  await call('item:assign', { groupId, listId, itemId: c, assignee: 'f'.repeat(64) })
  await call('item:setReminder', { groupId, listId, itemId: c, remindAt: soon })

  const { reminders, dropped } = await call('reminder:pending', {})
  assert.equal(dropped, 0)
  assert.deepEqual(reminders.map((r) => r.text), ['dishes', 'bins'], 'soonest first, so a cap keeps the urgent ones')
  assert.equal(reminders.some((r) => r.text === 'someone elses'), false, 'not our reminder to fire')
  assert.equal(reminders.some((r) => r.text === 'already done'), false, 'checked off, so it must not still fire')
  assert.equal(reminders[0].key, `item:${listId}:${b}`, 'keyed by the item key so a cancel is exact')
  assert.equal(reminders[0].listName, 'Jobs')
  await engine.close()
})

test('reminder:pending caps what it schedules and SAYS how many it dropped', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })

  const n = MAX_SCHEDULED_REMINDERS + 5
  for (let i = 0; i < n; i++) {
    const { itemId } = await call('item:add', { groupId, listId, text: 'job ' + i })
    await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + (i + 1) * 60000 })
  }

  const { reminders, dropped } = await call('reminder:pending', {})
  assert.equal(reminders.length, MAX_SCHEDULED_REMINDERS, 'iOS drops past 64 pending, so stay under')
  assert.equal(dropped, 5, 'a cap that hides what it discarded reads as "all scheduled" when it is not')
  assert.equal(reminders[0].text, 'job 0', 'the soonest survive the cap')
  await engine.close()
})

test('recurring chore: checking it stamps lastDoneAt, unchecking clears it', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })

  assert.deepEqual(await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly' }), { repeat: 'weekly' })
  assert.deepEqual(await call('item:setRepeat', { groupId, listId, itemId, repeat: 'yearly' }), { repeat: null }, 'junk is not a schedule')
  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly' })

  let row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(row.checked, false, 'never done, so open')
  assert.ok(row.nextDueAt > Date.now(), 'says when it comes back')

  await call('item:toggle', { groupId, listId, itemId, checked: true })
  row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.ok(row.lastDoneAt > 0, 'completion is the ONLY write the feature needs')
  assert.equal(row.checked, true, 'done this period')

  await call('item:toggle', { groupId, listId, itemId, checked: false })
  row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(row.lastDoneAt, null, 'unticking undoes the completion')
  assert.equal(row.checked, false)
  await engine.close()
})

test('a chore done LAST period reads as open again, with no reset ever written', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })
  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'daily' })
  await call('item:toggle', { groupId, listId, itemId, checked: true })

  assert.equal((await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId).checked, true)
  // Backdate the stamp to two days ago: the same row, untouched by any reset.
  await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + 60000 })
  const before = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.ok(before.lastDoneAt > 0)

  // Reach past the IPC to age the stamp, since the clock cannot be moved: this is
  // the same row the apply path stores, so it proves the DERIVED read, not a reset.
  const raw = await engineRow(engine, groupId, `item:${listId}:${itemId}`)
  await putRawRow(engine, groupId, `item:${listId}:${itemId}`, { ...raw, lastDoneAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })

  const after = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(after.checked, false, 'yesterday\'s completion does not close today')
  assert.equal((await call('list:openSummary', {})).total, 1, 'and it counts as open work again')
  await engine.close()
})

test('the daily digest ignores a recurring chore already done this period', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })
  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly' })

  assert.equal((await call('list:openSummary', {})).total, 1, 'open before it is done')
  await call('item:toggle', { groupId, listId, itemId, checked: true })
  const s = await call('list:openSummary', {})
  assert.equal(s.total, 0, 'done this week is not open work')
  assert.equal(s.digest, null, 'so there is nothing to nag about')
  await engine.close()
})

test('reminder:pending skips a recurring chore already done this period', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })
  await call('item:setRepeat', { groupId, listId, itemId, repeat: 'weekly' })
  await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + 60 * 60 * 1000 })

  assert.equal((await call('reminder:pending', {})).reminders.length, 1)
  await call('item:toggle', { groupId, listId, itemId, checked: true })
  assert.equal((await call('reminder:pending', {})).reminders.length, 0, 'done this week, so it must not ring')
  await engine.close()
})

// Reach past the IPC to read/write a raw row, so a test can age a timestamp the
// clock will not let it move. Uses the same signed append path the methods use.
async function engineRow (engine, groupId, key) {
  const base = engine.bases.get(groupId)
  await base.update()
  return (await base.view.get(key))?.value ?? null
}
async function putRawRow (engine, groupId, key, value) {
  const { signValue } = require('@peerloom/core/records')
  const v = { ...value, updatedAt: Date.now() }
  delete v.sig
  await engine.append(groupId, { type: 'put', key, value: signValue(v, engine.identity.secretKey) })
  const base = engine.bases.get(groupId)
  await base.update()
}

test('a reminder rings on the device that SET it, not the one that made the list', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })

  const res = await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + 60 * 60 * 1000 })
  assert.ok(res.remindBy, 'the setter is recorded on the row')
  const row = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(row.remindBy, res.remindBy)

  // This peer both created the list and set the reminder, so it is the target
  // either way - what matters is that remindBy is what carries it.
  assert.equal((await call('reminder:pending', {})).reminders.length, 1)

  await call('item:setReminder', { groupId, listId, itemId, remindAt: null })
  const cleared = (await call('item:getAll', { groupId, listId })).find((r) => r.id === itemId)
  assert.equal(cleared.remindBy, null, 'clearing the reminder clears who asked for it')
  await engine.close()
})

test('reminder:pending distinguishes "none exist" from "none are MINE"', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'H' })
  const { listId } = await call('list:create', { groupId, name: 'Jobs', kind: 'chore' })
  const { itemId } = await call('item:add', { groupId, listId, text: 'bins' })

  let s = await call('reminder:pending', {})
  assert.deepEqual([s.reminders.length, s.elsewhere], [0, 0], 'nothing exists')

  // Assigned to somebody else, so it is pending for THEM, not us.
  await call('item:assign', { groupId, listId, itemId, assignee: 'f'.repeat(64) })
  await call('item:setReminder', { groupId, listId, itemId, remindAt: Date.now() + 60 * 60 * 1000 })
  s = await call('reminder:pending', {})
  assert.deepEqual([s.reminders.length, s.elsewhere], [0, 1],
    'these two cases look identical without the count, which is what made a working iPhone look broken')
  await engine.close()
})
