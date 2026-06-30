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

test('household:get returns the joined household with a re-encodable invite', async () => {
  const { engine, call } = driver()
  await call('init', {})
  const created = await call('group:create', { name: 'The Nest' })
  const household = await call('household:get', {})
  assert.equal(household.groupId, created.groupId)
  assert.equal(household.name, 'The Nest')
  assert.equal(typeof household.inviteKey, 'string')
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
