// Photos on list items (proposals/2026-09-23-item-photos.md, issue #195).
//
// The pure rules first (what counts as live, what the sweep does with one photo),
// then real engines on real Autobases joined by a real encrypted connection, the
// way test/spaceRepairTwoPeer.test.js does it. A mock view cannot answer the
// questions that matter here: whether a housemate's phone actually gets the bytes,
// whether clearing them frees the blocks, and whether a space still opens after.

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
const { liveSet, sweepDecision, parseImage, PHOTO_MAX_BYTES, REPLACED_GRACE_MS, _resetCaches } = require('../src/photos')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 24 * 60 * 60 * 1000

// Random bytes behind an image mime. The worklet never decodes an image, it only
// stores and serves bytes, so real JPEG content would prove nothing extra here.
const fakeImage = (n) => 'data:image/jpeg;base64,' + crypto.randomBytes(n).toString('base64')
const photoPair = () => ({ photo: fakeImage(300 * 1024), thumb: fakeImage(10 * 1024), w: 1600, h: 1200 })

// --- pure rules ------------------------------------------------------------

const ref = (key = 'a'.repeat(64)) => ({ key, id: { blockOffset: 0, blockLength: 1 }, tkey: key, tid: { blockOffset: 1, blockLength: 1 } })
const row = (id, hash, extra = {}) => ({ id, listId: 'L', text: id, photo: { ...ref(), hash }, deleted: false, ...extra })

test('liveSet: a photo on a live item is live, on a tombstone it is final', () => {
  const s = liveSet([{ groupId: 'g', mounted: true, lists: [{ id: 'L' }], items: [row('i1', 'h1'), row('i2', 'h2', { deleted: true })] }])
  assert.equal(s.live.has('h1'), true)
  assert.equal(s.live.has('h2'), false)
  assert.equal(s.final.has('h2'), true)
})

test('liveSet: items in a deleted list are dead even though their own rows are not tombstoned', () => {
  const s = liveSet([{ groupId: 'g', mounted: true, lists: [{ id: 'L', deleted: true }], items: [row('i1', 'h1')] }])
  assert.equal(s.live.has('h1'), false)
  assert.equal(s.final.has('h1'), true)
})

test('liveSet: an item whose list row has not arrived yet counts as live', () => {
  const s = liveSet([{ groupId: 'g', mounted: true, lists: [], items: [row('i1', 'h1')] }])
  assert.equal(s.live.has('h1'), true)
})

test('liveSet: the same bytes live on one item and dead on another stay live', () => {
  const s = liveSet([{ groupId: 'g', mounted: true, lists: [{ id: 'L' }], items: [row('i1', 'h1', { deleted: true }), row('i2', 'h1')] }])
  assert.equal(s.live.has('h1'), true)
  assert.equal(s.final.has('h1'), false)
})

test('sweepDecision: grace period for a replaced photo, none for a tombstone or a left space', () => {
  const now = 1_000_000_000_000
  const sets = (over = {}) => ({ live: new Map(), final: new Set(), unknownGroups: new Set(), joined: new Set(['g']), ...over })
  assert.equal(sweepDecision({ groups: ['g'] }, 'h', sets(), now, REPLACED_GRACE_MS), 'mark')
  assert.equal(sweepDecision({ groups: ['g'], deadSince: now - DAY }, 'h', sets(), now, REPLACED_GRACE_MS), 'wait')
  assert.equal(sweepDecision({ groups: ['g'], deadSince: now - 8 * DAY }, 'h', sets(), now, REPLACED_GRACE_MS), 'clear')
  assert.equal(sweepDecision({ groups: ['g'] }, 'h', sets({ final: new Set(['h']) }), now, REPLACED_GRACE_MS), 'clear')
  assert.equal(sweepDecision({ groups: ['gone'] }, 'h', sets(), now, REPLACED_GRACE_MS), 'clear')
  assert.equal(sweepDecision({ groups: ['g'], deadSince: now }, 'h', sets({ live: new Map([['h', {}]]) }), now, REPLACED_GRACE_MS), 'revive')
})

test('sweepDecision: a space that is joined but will not open keeps every photo', () => {
  const sets = { live: new Map(), final: new Set(['h']), unknownGroups: new Set(['g']), joined: new Set(['g']) }
  assert.equal(sweepDecision({ groups: ['g'], deadSince: 0 }, 'h', sets, Date.now(), 0), 'keep')
})

test('parseImage: rejects oversized, empty and non-image input', () => {
  assert.throws(() => parseImage(fakeImage(PHOTO_MAX_BYTES + 1), PHOTO_MAX_BYTES, 'photo'), /too large/)
  assert.throws(() => parseImage('data:image/jpeg;base64,', PHOTO_MAX_BYTES, 'photo'), /empty/)
  assert.throws(() => parseImage('data:text/html;base64,AAAA', PHOTO_MAX_BYTES, 'photo'), /JPEG, PNG or WebP/)
  assert.throws(() => parseImage('https://example.com/x.jpg', PHOTO_MAX_BYTES, 'photo'), /data URL/)
})

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

async function rowOf (X, groupId, listId, itemId) {
  return (await X.call('item:getAll', { groupId, listId })).find((i) => i.id === itemId)
}

test('a photo set on one phone reaches the other and stays there after the first goes away', async () => {
  const h = await household('ph1')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Soy sauce')
  const pair = photoPair()
  const set = await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...pair })
  assert.equal(set.ok, true)
  assert.equal(set.photo.w, 1600)
  assert.equal(await h.A.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'full' }), pair.photo,
    'the author reads back exactly the bytes it stored')

  assert.equal(await until(async () => !!(await rowOf(h.B, h.groupId, h.listId, itemId))?.photo), true, 'the reference syncs')
  _resetCaches() // both engines share this process; make B read its own copy
  // Reading the list already starts the download in the background, so wait on
  // what B HOLDS rather than on who fetched it.
  await h.B.call('photo:maintain', {})
  assert.equal(await until(async () => (await h.B.call('photo:stats', {})).bytes === 310 * 1024), true,
    'B holds the thumbnail and the full image')
  h.cut()
  await h.A.engine.close()
  _resetCaches()
  assert.equal(await h.B.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'full' }), pair.photo,
    'B still has the photo with A gone')
  assert.equal(await h.B.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'thumb' }), pair.thumb)
  const stats = await h.B.call('photo:stats', {})
  assert.equal(stats.count, 1)
  assert.equal(stats.bytes, 310 * 1024)
  await h.B.engine.close()
})

test('item:getPhoto answers at once when the bytes are not here, and fetches in the background', async () => {
  const h = await household('ph2')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Noodles')
  const pair = photoPair()
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...pair })
  assert.equal(await until(async () => !!(await rowOf(h.B, h.groupId, h.listId, itemId))?.photo), true)
  _resetCaches()
  const t0 = Date.now()
  const first = await h.B.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'thumb' })
  assert.ok(Date.now() - t0 < 1000, 'a miss must not hold up the IPC loop')
  assert.ok(first === null || first === pair.thumb)
  assert.equal(await until(async () => (await h.B.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'thumb' })) === pair.thumb), true,
    'the background fetch lands and the next ask returns it')
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('the same photo on two items is stored once', async () => {
  const h = await household('ph3')
  const i1 = await addItem(h.A, h.groupId, h.listId, 'Rice')
  const i2 = await addItem(h.A, h.groupId, h.listId, 'More rice')
  const pair = photoPair()
  const a = await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: i1, ...pair })
  const b = await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: i2, ...pair })
  assert.deepEqual(b.photo.id, a.photo.id, 'the second item points at the first copy')
  assert.equal((await h.A.call('photo:stats', {})).count, 1)
  // Deleting one of them must not clear the bytes the other still shows.
  await h.A.call('item:delete', { groupId: h.groupId, listId: h.listId, itemId: i1 })
  assert.equal((await h.A.call('photo:maintain', {})).cleared, 0)
  assert.equal(await holds(h.A, a.photo.key, a.photo.id), true)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('deleting an item clears its photo on both phones at the next sweep', async () => {
  const h = await household('ph4')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Kimchi')
  const { photo } = await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })
  assert.equal(await until(async () => !!(await rowOf(h.B, h.groupId, h.listId, itemId))?.photo), true)
  await h.B.call('photo:maintain', {})
  assert.equal(await holds(h.B, photo.key, photo.id), true, 'B holds it before the delete')

  await h.B.call('item:delete', { groupId: h.groupId, listId: h.listId, itemId })
  assert.equal(await until(async () => !(await rowOf(h.A, h.groupId, h.listId, itemId))), true, 'the delete syncs')
  assert.equal((await h.A.call('photo:maintain', {})).cleared, 1)
  assert.equal((await h.B.call('photo:maintain', {})).cleared, 1)
  assert.equal(await holds(h.A, photo.key, photo.id), false, "the author's own copy is gone")
  assert.equal(await holds(h.B, photo.key, photo.id), false, "the housemate's copy is gone")
  assert.equal(await holds(h.A, photo.tkey, photo.tid), false, 'and the thumbnail')
  assert.deepEqual(await h.A.call('photo:stats', {}), { count: 0, bytes: 0 })
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('deleting a list clears the photos of every item in it', async () => {
  const h = await household('ph5')
  const i1 = await addItem(h.A, h.groupId, h.listId, 'One')
  const i2 = await addItem(h.A, h.groupId, h.listId, 'Two')
  const p1 = (await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: i1, ...photoPair() })).photo
  const p2 = (await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: i2, ...photoPair() })).photo
  await h.A.call('list:delete', { groupId: h.groupId, listId: h.listId })
  assert.equal((await h.A.call('photo:maintain', {})).cleared, 2)
  assert.equal(await holds(h.A, p1.key, p1.id), false)
  assert.equal(await holds(h.A, p2.key, p2.id), false)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('a replaced photo waits out the grace period, then goes', async () => {
  const h = await household('ph6')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Tea')
  const old = (await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })).photo
  const now = Date.now()
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })
  assert.equal((await h.A.call('photo:maintain', { now })).cleared, 0, 'marked, not cleared')
  assert.equal((await h.A.call('photo:maintain', { now: now + 6 * DAY })).cleared, 0, 'still inside 7 days')
  assert.equal(await holds(h.A, old.key, old.id), true)
  assert.equal((await h.A.call('photo:maintain', { now: now + 8 * DAY })).cleared, 1, 'cleared after 7 days')
  assert.equal(await holds(h.A, old.key, old.id), false)
  // The current photo is untouched.
  assert.equal((await h.A.call('photo:stats', {})).count, 1)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('removing a photo also waits out the grace period', async () => {
  const h = await household('ph7')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Milk')
  const old = (await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })).photo
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, photo: null })
  assert.equal((await rowOf(h.A, h.groupId, h.listId, itemId)).photo, undefined, 'the field is gone from the row')
  const now = Date.now()
  assert.equal((await h.A.call('photo:maintain', { now })).cleared, 0)
  assert.equal((await h.A.call('photo:maintain', { now: now + 8 * DAY })).cleared, 1)
  assert.equal(await holds(h.A, old.key, old.id), false)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('a housemate edit that brings the old photo back keeps it from being cleared', async () => {
  const h = await household('ph8')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Bread')
  const old = (await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })).photo
  assert.equal(await until(async () => (await rowOf(h.B, h.groupId, h.listId, itemId))?.photo?.hash === old.hash), true)
  await h.B.call('photo:maintain', {})

  // Offline from each other: A replaces the photo, B edits the text from the OLD row.
  h.cut()
  const now = Date.now()
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })
  assert.equal((await h.A.call('photo:maintain', { now })).cleared, 0)
  await sleep(20)
  await h.B.call('item:edit', { groupId: h.groupId, listId: h.listId, itemId, text: 'Sourdough' })

  // Back together. B's edit is later, so last-writer-wins puts the old photo back.
  const cut = connect(h.A, h.B)
  assert.equal(await until(async () => (await rowOf(h.A, h.groupId, h.listId, itemId))?.text === 'Sourdough'), true)
  assert.equal((await rowOf(h.A, h.groupId, h.listId, itemId)).photo.hash, old.hash, 'the old reference won')
  await h.A.call('photo:maintain', { now: now + 1000 })
  const r = await h.A.call('photo:maintain', { now: now + 8 * DAY })
  assert.equal(await holds(h.A, old.key, old.id), true, 'the photo the item shows again was NOT cleared')
  assert.equal(r.cleared, 1, 'the replacement nobody shows any more was')
  cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('leaving a space clears its photos on this phone', async () => {
  const h = await household('ph9')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Eggs')
  const { photo } = await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...photoPair() })
  assert.equal(await until(async () => !!(await rowOf(h.B, h.groupId, h.listId, itemId))?.photo), true)
  await h.B.call('photo:maintain', {})
  assert.equal(await holds(h.B, photo.key, photo.id), true)
  await h.B.call('space:leave', { groupId: h.groupId })
  assert.equal((await h.B.call('photo:maintain', {})).cleared, 1)
  assert.equal(await holds(h.B, photo.key, photo.id), false)
  assert.equal(await holds(h.A, photo.key, photo.id), true, 'the author, still in the space, keeps it')
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})

test('after a sweep the avatar is intact and the space still cold-starts with no peer', async () => {
  const h = await household('ph10')
  const avatar = 'data:image/png;base64,' + crypto.randomBytes(2048).toString('base64')
  await h.A.call('profile:set', { displayName: 'Tim', avatar })
  const keep = await addItem(h.A, h.groupId, h.listId, 'Butter')
  const gone = await addItem(h.A, h.groupId, h.listId, 'Jam')
  const pair = photoPair()
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: keep, ...pair })
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: gone, ...photoPair() })
  await h.A.call('item:delete', { groupId: h.groupId, listId: h.listId, itemId: gone })
  assert.equal((await h.A.call('photo:maintain', {})).cleared, 1)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()

  // The founder restarts alone, which is the launch that hung in 1.0.9.
  _resetCaches()
  const A = driver(h.dirA)
  await A.call('init')
  const items = await A.call('item:getAll', { groupId: h.groupId, listId: h.listId })
  assert.deepEqual(items.map((i) => i.text), ['Butter'], 'the space opens and reads')
  assert.equal((await A.call('profile:get', {})).avatar, avatar, 'the avatar in the same blob core survived')
  assert.equal(await A.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId: keep, size: 'full' }), pair.photo,
    'the photo on the live item survived')
  await A.engine.close()
})

test('a third phone gets the photo from the housemate after the author has gone', async () => {
  const h = await household('ph11')
  const itemId = await addItem(h.A, h.groupId, h.listId, 'Fish sauce')
  const pair = photoPair()
  await h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId, ...pair })
  assert.equal(await until(async () => !!(await rowOf(h.B, h.groupId, h.listId, itemId))?.photo), true)
  await h.B.call('photo:maintain', {})
  assert.equal(await until(async () => (await h.B.call('photo:stats', {})).bytes === 310 * 1024), true, 'B holds both images')

  const C = driver(tmpDir('ph11-c-'))
  await C.call('init')
  const cutBC = connect(h.B, C)
  await C.call('group:join', { inviteKey: h.inviteKey })
  h.cut(); await h.A.engine.close() // the author is gone before C asks for anything
  assert.equal(await until(async () => !!(await rowOf(C, h.groupId, h.listId, itemId).catch(() => null))?.photo), true, 'C sees the item')
  _resetCaches()
  await C.call('photo:maintain', {})
  assert.equal(await until(async () => (await C.call('photo:stats', {})).bytes === 310 * 1024), true, 'C downloaded both images from B')
  _resetCaches()
  assert.equal(await C.call('item:getPhoto', { groupId: h.groupId, listId: h.listId, itemId, size: 'full' }), pair.photo)
  cutBC(); await h.B.engine.close(); await C.engine.close()
})

test('notes do not take photos, and a deleted item cannot get one', async () => {
  const h = await household('ph12')
  const { listId: noteId } = await h.A.call('list:create', { groupId: h.groupId, name: 'Note', kind: 'note' })
  const n = await addItem(h.A, h.groupId, noteId, 'line')
  await assert.rejects(h.A.call('item:setPhoto', { groupId: h.groupId, listId: noteId, itemId: n, ...photoPair() }), /notes do not take photos/)
  const i = await addItem(h.A, h.groupId, h.listId, 'Gone')
  await h.A.call('item:delete', { groupId: h.groupId, listId: h.listId, itemId: i })
  await assert.rejects(h.A.call('item:setPhoto', { groupId: h.groupId, listId: h.listId, itemId: i, ...photoPair() }), /item not found/)
  h.cut(); await h.A.engine.close(); await h.B.engine.close()
})
