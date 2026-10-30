// Cards on the Lists page (proposals/2026-10-29-keep-style-notes.md): a list's
// colour and pin are shared fields on its row, and list:previews feeds each card.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Corestore = require('corestore')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const listMethods = require('../src/listMethods')
const { normalizeColor, isPinned, LIST_COLORS } = require('../src/listStyle')
const { buildBackup, parseBackup } = require('../src/spaceBackup')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

function fakeSwarm () {
  const ee = new EventEmitter()
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = () => {}
  ee.destroy = async () => {}
  return ee
}

function driver () {
  const responses = []
  const read = new EventEmitter()
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: new Corestore(tmpDir('pearlist-')), createSwarm: fakeSwarm,
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

async function space (call) {
  await call('init', {})
  const { groupId } = await call('group:create', { name: 'Household' })
  return groupId
}
const listOf = async (call, groupId, listId) => (await call('list:getAll', { groupId })).find((l) => l.id === listId)

test('normalizeColor keeps the eight names and turns anything else into default', () => {
  assert.equal(LIST_COLORS.length, 8)
  for (const c of LIST_COLORS) assert.equal(normalizeColor(c), c)
  for (const junk of ['pink', '', null, undefined, 3, { c: 'red' }, 'RED']) assert.equal(normalizeColor(junk), 'default')
  assert.equal(isPinned({ pinned: true }), true)
  for (const v of [false, 'true', 1, undefined]) assert.equal(isPinned({ pinned: v }), false)
  assert.equal(isPinned(null), false)
})

test('colour and pin are stored, and default or unpinned leave no field', async () => {
  const { engine, call } = driver()
  const groupId = await space(call)
  const { listId } = await call('list:create', { groupId, name: 'Groceries' })

  await call('list:setColor', { groupId, listId, color: 'teal' })
  await call('list:setPinned', { groupId, listId, pinned: true })
  let l = await listOf(call, groupId, listId)
  assert.equal(l.color, 'teal')
  assert.equal(l.pinned, true)

  await call('list:setColor', { groupId, listId, color: 'not-a-colour' })
  await call('list:setPinned', { groupId, listId, pinned: 'yes' })
  l = await listOf(call, groupId, listId)
  assert.equal('color' in l, false, 'junk is written as default, which is no field')
  assert.equal('pinned' in l, false)
  await engine.close()
})

test('rename, assign and a kind change keep the colour and pin', async () => {
  const { engine, call } = driver()
  const groupId = await space(call)
  const { listId } = await call('list:create', { groupId, name: 'Groceries' })
  await call('list:setColor', { groupId, listId, color: 'red' })
  await call('list:setPinned', { groupId, listId, pinned: true })

  await call('list:rename', { groupId, listId, name: 'Shop' })
  await call('list:assign', { groupId, listId, assignee: null })
  await call('list:setKind', { groupId, listId, kind: 'todo' })
  const l = await listOf(call, groupId, listId)
  assert.equal(l.name, 'Shop')
  assert.equal(l.color, 'red')
  assert.equal(l.pinned, true)
  await engine.close()
})

test('list:previews counts items and puts open ones first, notes in their own order', async () => {
  const { engine, call } = driver()
  const groupId = await space(call)
  const { listId } = await call('list:create', { groupId, name: 'Groceries' })
  const { listId: empty } = await call('list:create', { groupId, name: 'Empty' })
  for (const text of ['milk', 'eggs', 'bread']) await call('item:add', { groupId, listId, text })
  const items = await call('item:getAll', { groupId, listId })
  await call('item:toggle', { groupId, listId, itemId: items.find((i) => i.text === 'milk').id, checked: true })

  const p = await call('list:previews', { groupId })
  assert.equal(p[listId].open, 2)
  assert.equal(p[listId].total, 3)
  assert.deepEqual(p[listId].lines.map((x) => x.text), ['eggs', 'bread', 'milk'])
  assert.equal(p[listId].lines[2].checked, true)
  assert.equal(p[listId].photo, null)
  assert.deepEqual(p[empty], { open: 0, total: 0, lines: [], photo: null })
  await engine.close()
})

test('a saved copy carries the colour and pin', () => {
  const spaces = [{ name: 'Home', lists: [
    { name: 'A', kind: 'list', color: 'blue', pinned: true, items: [] },
    { name: 'B', kind: 'list', color: 'default', pinned: false, items: [] },
  ] }]
  const { spaces: back } = parseBackup(JSON.stringify(buildBackup({ spaces, templates: [], learnedAisles: {}, exportedAt: 1 })))
  const [a, b] = back[0].lists
  assert.equal(a.color, 'blue')
  assert.equal(a.pinned, true)
  assert.equal('color' in b, false)
  assert.equal('pinned' in b, false)
})
