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
