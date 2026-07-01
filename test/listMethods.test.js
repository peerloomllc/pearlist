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
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = () => {}
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

test('space:forget drops a space from spaces:list', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Temp' })
  await call('space:forget', { groupId })
  assert.ok(!(await call('spaces:list', {})).some((s) => s.groupId === groupId))
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
