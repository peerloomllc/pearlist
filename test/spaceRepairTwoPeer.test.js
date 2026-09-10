// A REBUILD THAT ACTUALLY WORKS, which is the case the button exists for.
//
// test/spaceRepair.test.js pins that every path ANSWERS - unavailable is reported
// rather than thrown, and a repair that cannot work returns instead of hanging.
// None of it proves the repair repairs anything, because none of it has a peer.
// Core covers the shape in its own two-peer test (peerloom-core, e2cfce8), but
// PearList had never run space:repair end to end through its own IPC surface.
//
// The peers here are joined by a real @hyperswarm/secret-stream pair rather than a
// fake, because core does more with a connection than replicate: setupPairListener
// runs the pair protocol over Protomux on it, and writer admission happens there.
// A swarm double that only pipes corestores would replicate happily and never admit
// anyone, which looks exactly like a repair that did not work.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const Corestore = require('corestore')
const SecretStream = require('@hyperswarm/secret-stream')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const { authorizeRevoke, admitWriter } = require('../src/revocation')
const listMethods = require('../src/listMethods')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A swarm double that carries a REAL connection when one is handed to it.
function fakeSwarm () {
  const ee = new EventEmitter()
  ee.connections = new Set()
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = async () => {}
  ee.destroy = async () => {}
  return ee
}

function driver (dir, { mountTimeout = 4000 } = {}) {
  const responses = []
  const read = new EventEmitter()
  const swarm = fakeSwarm()
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: new Corestore(dir), createSwarm: () => swarm,
    applyOps: applyListOp, methods: listMethods, mountTimeout,
    authorizeRevoke, admitWriter,
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

// Hand both engines the two ends of one encrypted connection, the way Hyperswarm
// would. Returns a teardown.
function connect (a, b) {
  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)
  s1.rawStream.pipe(s2.rawStream).pipe(s1.rawStream)
  a.swarm.connections.add(s1); b.swarm.connections.add(s2)
  a.swarm.emit('connection', s1, { publicKey: s2.publicKey })
  b.swarm.emit('connection', s2, { publicKey: s1.publicKey })
  return () => { try { s1.destroy() } catch {} ; try { s2.destroy() } catch {} }
}

// Wait for a condition instead of sleeping a guessed amount. Admission crosses two
// devices and a fixed sleep is how a test like this turns flaky.
async function until (fn, { budget = 20_000, step = 100 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - started > budget) return false
    await sleep(step)
  }
}

// WHICH DEVICE ACTUALLY BREAKS, learned the hard way here on 2026-09-10.
//
// The first draft damaged the JOINER: admit B, clear B's local input core, restart
// B alone. B opened perfectly well and the test failed on its own setup. Then B was
// made to write items first, on the theory that an empty core cannot be damaged.
// It opened perfectly well again.
//
// A joiner is not the device this bug destroys. Its base bootstraps off the OWNER's
// core, which it has replicated into its own store, and once its own appends are
// indexed into the persisted view it can cold-open without them. The device that
// cannot recover is the one whose missing blocks are the base's own source of
// truth: the FOUNDER. That is also what the single-peer tests in
// test/spaceRepair.test.js damage, and why they reproduce it every time.
//
// So these tests damage the founder and repair it from the housemate. That is the
// real shape of "rebuild from another phone" anyway - the person who started the
// household is exactly the one with the most to lose.
//
// Both tests assert the damage BEFORE repairing it. Without that a test passes on a
// store that was never broken, which is what the second one did for two runs.

const OWNER_ITEMS = 12
const MATE_ITEMS = 6

// Build a household: A founds a space with a list, B joins and is admitted, both
// write. Returns the pieces plus a live connection.
async function household (prefix) {
  const dirA = tmpDir(prefix + '-owner-')
  const dirB = tmpDir(prefix + '-mate-')
  const A = driver(dirA)
  await A.call('init')
  const { groupId } = await A.call('group:create', { name: 'Household' })
  await A.call('space:init', { groupId, name: 'Household' })
  const { listId } = await A.call('list:create', { groupId, name: 'Groceries' })
  for (let i = 0; i < OWNER_ITEMS; i++) await A.call('item:add', { groupId, listId, text: 'a' + i })
  const inviteKey = (await A.call('spaces:list', {})).find((s) => s.groupId === groupId).inviteKey

  const B = driver(dirB)
  await B.call('init')
  const cut = connect(A, B)
  await B.call('group:join', { inviteKey })
  assert.equal(await until(() => !!B.engine.bases.get(groupId)?.writable), true,
    'B has to be admitted as a writer, or it cannot admit A back later')

  for (let i = 0; i < MATE_ITEMS; i++) await B.call('item:add', { groupId, listId, text: 'b' + i })
  const total = OWNER_ITEMS + MATE_ITEMS
  assert.equal(await until(async () => (await A.call('item:getAll', { groupId, listId })).length === total), true,
    'both phones agree before anything is broken')
  return { dirA, dirB, A, B, cut, groupId, listId, total }
}

// Do to the founder's store exactly what 1.0.9's retention did: delete this
// device's own input blocks, which are the only copies it holds.
async function damageOwner (A, groupId, cut) {
  const base = A.engine.bases.get(groupId)
  await base.update()
  await base.local.clear(0, base.local.length)
  cut()
  await A.engine.close?.()
  await sleep(400)
}

test('a rebuild with the other phone present brings the space back', async () => {
  const h = await household('rp1')
  await damageOwner(h.A, h.groupId, h.cut)

  // The founder restarts alone. This is the launch after the phone reboots.
  let A = driver(h.dirA)
  await A.call('init')
  const broken = (await A.call('spaces:list', {})).find((s) => s.groupId === h.groupId)
  assert.equal(broken.available, false, 'the damage reproduces through the app surface')

  // The housemate opens PearList, which is what the copy tells them to do.
  const cut = connect(A, h.B)
  const res = await A.call('space:repair', { groupId: h.groupId, rebuild: true }, 60_000)
  assert.equal(res.ok, true, 'the rebuild mounted')
  assert.equal(res.rebuilt, true, 'a real rebuild, not an alreadyOpen no-op')

  assert.equal(await until(async () => (await A.call('list:getAll', { groupId: h.groupId }).catch(() => [])).length === 1),
    true, 'the list came back from the other phone')
  assert.equal((await A.call('item:getAll', { groupId: h.groupId, listId: h.listId })).length, h.total,
    'with every item, including the ones this phone wrote before it broke')
  assert.equal((await A.call('space:status', { groupId: h.groupId })).available, true,
    'and the space reports itself open again')

  cut()
  try { await A.engine.close?.() } catch {}
  try { await h.B.engine.close?.() } catch {}
})

test('the repaired phone opens ALONE afterwards, with nobody to fetch from', async () => {
  // A rebuild that only works while the other phone is connected has moved the
  // problem, not fixed it - "it works when the other phone is awake" is what the
  // original bug looked like.
  const h = await household('rp2')
  await damageOwner(h.A, h.groupId, h.cut)

  let A = driver(h.dirA)
  await A.call('init')
  assert.equal((await A.call('spaces:list', {})).find((s) => s.groupId === h.groupId).available, false,
    'broken before it is repaired, or this proves nothing')

  const cut = connect(A, h.B)
  assert.equal((await A.call('space:repair', { groupId: h.groupId, rebuild: true }, 60_000)).rebuilt, true)
  assert.equal(await until(async () => (await A.call('list:getAll', { groupId: h.groupId }).catch(() => [])).length === 1), true)

  // Take the household away entirely and restart on its own.
  cut()
  try { await h.B.engine.close?.() } catch {}
  await A.engine.close?.()
  await sleep(400)

  A = driver(h.dirA)
  await A.call('init')
  assert.equal((await A.call('spaces:list', {})).find((s) => s.groupId === h.groupId).available, true,
    'the repaired space opens with no peer anywhere')
  assert.equal((await A.call('item:getAll', { groupId: h.groupId, listId: h.listId })).length, h.total,
    'and every item is still readable')
  try { await A.engine.close?.() } catch {}
})
