// GETTING BACK A SPACE THAT WOULD NOT OPEN.
// proposals/2026-09-10-repairing-a-space-1.0.9-broke.md.
//
// 1.0.9 ran retention against a core whose retain() swept the device's OWN local
// input core. Those blocks are the only copies that phone holds, so the base stops
// being self-sufficient and a later cold start waits on a block nobody can serve.
// These tests damage a store the same way - clear the local input core - and then
// assert on what the app does about it.
//
// The thing being pinned is NOT that repair always succeeds. It cannot: a rebuild
// needs a peer who is a writer and awake. What is pinned is that every path
// ANSWERS - unavailable is reported rather than thrown, and a repair that cannot
// work reports that instead of hanging, which is the failure the whole line of work
// exists to remove.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Corestore = require('corestore')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const listMethods = require('../src/listMethods')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

function fakeSwarm () {
  const ee = new EventEmitter()
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = async () => {}
  ee.destroy = async () => {}
  return ee
}

// A short mount budget, because these tests deliberately mount a base that cannot
// open and the default is 15s per group.
function driver (dir, { mountTimeout = 2000 } = {}) {
  const responses = []
  const read = new EventEmitter()
  const store = new Corestore(dir)
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: store, createSwarm: fakeSwarm,
    applyOps: applyListOp, methods: listMethods, mountTimeout,
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
  return { engine, store, call }
}

// A space that has been used and then had this device's own blocks deleted, which
// is precisely what 1.0.9's retention did.
async function damagedStore () {
  const dir = tmpDir('repair-')
  const d = driver(dir)
  await d.call('init')
  const { groupId } = await d.call('group:create', { name: 'Household' })
  const { listId } = await d.call('list:create', { groupId, name: 'Groceries' })
  for (let i = 0; i < 30; i++) await d.call('item:add', { groupId, listId, text: 'i' + i })
  const base = d.engine.bases.get(groupId)
  await base.update()
  await base.local.clear(0, base.local.length)
  await d.engine.close?.()
  await new Promise((r) => setTimeout(r, 400))
  return { dir, groupId, listId }
}

test('a space that will not open is REPORTED, not thrown', async () => {
  const { dir, groupId } = await damagedStore()
  const d = driver(dir)
  await d.call('init')

  const spaces = await d.call('spaces:list', {})
  const sp = spaces.find((x) => x.groupId === groupId)
  assert.ok(sp, 'the space is still listed, because the membership record survives')
  assert.equal(sp.available, false, 'and it is marked unavailable rather than looking ordinary')

  const status = await d.call('space:status', { groupId })
  assert.equal(status.available, false)
  assert.equal(status.writable, false)
  // The reason is what the user copies to us, so it has to be a string and not a
  // silent null. It comes from core's bounded mount.
  assert.equal(typeof status.reason, 'string')
  try { await d.engine.close?.() } catch {}
})

test('space:status still THROWS for a groupId that is not a space at all', async () => {
  const dir = tmpDir('repair-unknown-')
  const d = driver(dir)
  await d.call('init')
  // "not a space" and "a space that would not open" are different answers and the
  // caller acts differently on each, so they must not collapse into one.
  await assert.rejects(() => d.call('space:status', { groupId: 'ff'.repeat(16) }), /unknown group/)
  try { await d.engine.close?.() } catch {}
})

test('space:repair on a healthy space says it is already open and changes nothing', async () => {
  const dir = tmpDir('repair-healthy-')
  const d = driver(dir)
  await d.call('init')
  const { groupId } = await d.call('group:create', { name: 'Fine' })
  const before = d.engine.bases.get(groupId)

  const res = await d.call('space:repair', { groupId, rebuild: true })
  assert.equal(res.ok, true)
  assert.equal(res.alreadyOpen, true)
  assert.equal(res.rebuilt, false, 'a rebuild must never fire on a space that is open')
  assert.equal(d.engine.bases.get(groupId), before, 'and the base is the same one')
  try { await d.engine.close?.() } catch {}
})

test('a repair that cannot work ANSWERS, rather than hanging', async () => {
  const { dir, groupId } = await damagedStore()
  const d = driver(dir)
  await d.call('init')

  // No peer exists anywhere, so neither a retry nor a rebuild can bring the data
  // back. The requirement is not that they succeed, it is that they return. A hang
  // here is the original bug wearing a button.
  const retry = await d.call('space:repair', { groupId, rebuild: false }, 60_000)
  assert.equal(retry.ok, false)
  assert.equal(retry.why, 'did-not-open')

  const rebuild = await d.call('space:repair', { groupId, rebuild: true }, 60_000)
  assert.equal(typeof rebuild.ok, 'boolean', 'it answered')
  try { await d.engine.close?.() } catch {}
})

test('a retry does NOT rebuild, so a slow space keeps its local writer', async () => {
  const { dir, groupId } = await damagedStore()
  const d = driver(dir)
  await d.call('init')
  const before = (await d.call('spaces:list', {})).find((x) => x.groupId === groupId)

  await d.call('space:repair', { groupId, rebuild: false }, 60_000)

  // The membership record must still carry no rebuild namespace: a 15s mount
  // timeout is not proof of damage, and a retry that quietly rebuilt would throw
  // away a good local writer on a merely slow phone.
  const row = (await d.engine.localDb.get('groups:joined:' + groupId))?.value
  assert.ok(!row.namespace || !String(row.namespace).includes('rebuild'),
    'a retry reuses the namespace it already had')
  const after = (await d.call('spaces:list', {})).find((x) => x.groupId === groupId)
  assert.equal(after.joinedAt, before.joinedAt, 'and the space does not jump position in the switcher')
  try { await d.engine.close?.() } catch {}
})
