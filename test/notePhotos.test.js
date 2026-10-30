// Photos on notes (proposals/2026-10-29-keep-style-notes.md). They live on the
// note's list row and share the item photos' store, download pass and sweep.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const crypto = require('node:crypto')
const b4a = require('b4a')
const Corestore = require('corestore')
const SecretStream = require('@hyperswarm/secret-stream')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const { authorizeRevoke, admitWriter } = require('../src/revocation')
const listMethods = require('../src/listMethods')
const { liveSet, NOTE_PHOTOS_MAX } = require('../src/photos')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 24 * 60 * 60 * 1000
const fakeImage = (n) => 'data:image/jpeg;base64,' + crypto.randomBytes(n).toString('base64')
const photoPair = () => ({ photo: fakeImage(100 * 1024), thumb: fakeImage(8 * 1024), w: 1600, h: 1200 })

// --- real engines ----------------------------------------------------------

function fakeSwarm () {
  const ee = new EventEmitter()
  ee.connections = new Set()
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = async () => {}
  ee.destroy = async () => {}
  return ee
}

function driver (dir) {
  const responses = []
  const read = new EventEmitter()
  const swarm = fakeSwarm()
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: new Corestore(dir), createSwarm: () => swarm,
    applyOps: applyListOp, methods: listMethods, mountTimeout: 4000, authorizeRevoke, admitWriter,
  })
  engine.start({ read, write: (buf) => responses.push(JSON.parse(buf.toString())) })
  let nextId = 1
  const call = (method, args = {}, budget = 60_000) => new Promise((resolve, reject) => {
    const id = nextId++
    read.emit('data', Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
    const started = Date.now()
    const poll = setInterval(() => {
      const r = responses.find((x) => x.id === id)
      if (r) { clearInterval(poll); return r.error ? reject(new Error(r.error)) : resolve(r.result) }
      if (Date.now() - started > budget) { clearInterval(poll); reject(new Error('HUNG: ' + method)) }
    }, 20)
  })
  return { engine, swarm, call }
}

function connect (a, b) {
  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)
  s1.rawStream.pipe(s2.rawStream).pipe(s1.rawStream)
  a.swarm.connections.add(s1); b.swarm.connections.add(s2)
  a.swarm.emit('connection', s1, { publicKey: s2.publicKey })
  b.swarm.emit('connection', s2, { publicKey: s1.publicKey })
  return () => { try { s1.destroy() } catch {} ; try { s2.destroy() } catch {} }
}

async function until (fn, { budget = 20_000, step = 100 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started > budget) return false
    await sleep(step)
  }
}

// A founds a space with a grocery list, B joins and is admitted as a writer.
async function household (prefix) {
  const dirA = tmpDir(prefix + '-a-')
  const A = driver(dirA)
  await A.call('init')
  const { groupId } = await A.call('group:create', { name: 'Household' })
  await A.call('space:init', { groupId, name: 'Household' })
  const { listId } = await A.call('list:create', { groupId, name: 'Groceries' })
  const inviteKey = (await A.call('spaces:list', {})).find((s) => s.groupId === groupId).inviteKey
  const B = driver(tmpDir(prefix + '-b-'))
  await B.call('init')
  const cut = connect(A, B)
  await B.call('group:join', { inviteKey })
  assert.equal(await until(() => !!B.engine.bases.get(groupId)?.writable), true, 'B is admitted')
  return { A, B, cut, groupId, listId, inviteKey, dirA }
}

async function addItem (X, groupId, listId, text) {
  const { itemId } = await X.call('item:add', { groupId, listId, text })
  return itemId
}

// Does this device still hold the blocks behind a photo reference?
async function holds (X, key, id) {
  const core = X.engine.store.get(b4a.from(key, 'hex'))
  await core.ready()
  try { return await core.has(id.blockOffset, id.blockOffset + id.blockLength) } finally { await core.close() }
}


async function note (X, groupId, name = 'Ideas') {
  const { listId } = await X.call('list:create', { groupId, name, kind: 'note' })
  return listId
}
const listRow = async (X, groupId, listId) => (await X.call('list:getAll', { groupId })).find((l) => l.id === listId)

test('liveSet: photos on a live note are live, on a deleted note they are final', () => {
  const p = (hash) => ({ key: 'a'.repeat(64), id: { blockOffset: 0, blockLength: 1 }, tkey: 'a'.repeat(64), tid: { blockOffset: 1, blockLength: 1 }, hash })
  const s = liveSet([{ groupId: 'g', mounted: true, items: [], lists: [
    { id: 'N1', kind: 'note', photos: [p('h1'), { junk: true }] },
    { id: 'N2', kind: 'note', deleted: true, photos: [p('h2')] },
  ] }])
  assert.equal(s.live.has('h1'), true)
  assert.equal(s.final.has('h2'), true)
  assert.equal(s.deadItems.has('g/N2/_note'), true)
})

test('a note photo added on one phone can be read on the other', async () => {
  const h = await household('np1')
  const listId = await note(h.A, h.groupId)
  const { photo } = await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() })
  assert.equal((await listRow(h.A, h.groupId, listId)).photos.length, 1)
  assert.match(await h.A.call('note:getPhoto', { groupId: h.groupId, listId, hash: photo.hash }), /^data:image\/jpeg;base64,/)
  const got = await until(async () => !!(await h.B.call('note:getPhoto', { groupId: h.groupId, listId, hash: photo.hash, size: 'full' })))
  assert.equal(got, true, 'B fetched it from A')
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('renaming a note keeps its photos, and the same photo twice is stored once', async () => {
  const h = await household('np2')
  const listId = await note(h.A, h.groupId)
  const pair = photoPair()
  await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...pair })
  await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...pair })
  await h.A.call('list:rename', { groupId: h.groupId, listId, name: 'Recipes' })
  const l = await listRow(h.A, h.groupId, listId)
  assert.equal(l.name, 'Recipes')
  assert.equal(l.photos.length, 1)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('a removed note photo waits out the grace period, then goes', async () => {
  const h = await household('np3')
  const listId = await note(h.A, h.groupId)
  const { photo } = await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() })
  await h.A.call('note:removePhoto', { groupId: h.groupId, listId, hash: photo.hash })
  assert.equal('photos' in (await listRow(h.A, h.groupId, listId)), false, 'the field is gone from the row')
  const now = Date.now()
  assert.equal((await h.A.call('photo:maintain', { now })).cleared, 0)
  assert.equal(await holds(h.A, photo.key, photo.id), true)
  assert.equal((await h.A.call('photo:maintain', { now: now + 8 * DAY })).cleared, 1)
  assert.equal(await holds(h.A, photo.key, photo.id), false)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('deleting a note clears its photos at the next sweep', async () => {
  const h = await household('np4')
  const listId = await note(h.A, h.groupId)
  const a = (await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() })).photo
  const b = (await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() })).photo
  await h.A.call('list:delete', { groupId: h.groupId, listId })
  assert.equal((await h.A.call('photo:maintain', {})).cleared, 2)
  assert.equal(await holds(h.A, a.key, a.id), false)
  assert.equal(await holds(h.A, b.key, b.id), false)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('only notes take note photos, and a note holds at most the cap', async () => {
  const h = await household('np5')
  await assert.rejects(h.A.call('note:addPhoto', { groupId: h.groupId, listId: h.listId, ...photoPair() }), /only notes/)
  const listId = await note(h.A, h.groupId)
  for (let i = 0; i < NOTE_PHOTOS_MAX; i++) await h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() })
  await assert.rejects(h.A.call('note:addPhoto', { groupId: h.groupId, listId, ...photoPair() }), /up to/)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})
