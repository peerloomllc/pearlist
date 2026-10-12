// Backing a space up to a blind seeder (src/seeders.js), against the real seeder
// from ../peerloom-seeder over a local DHT testnet:
//   - pairing lists the seeder on our member row, and the other member backs up
//     to it too;
//   - a member catches up from the seeder alone when the other phone is off;
//   - the seeder holds no readable list text;
//   - stopping takes it off the row and asks the seeder to drop the space.
// Skipped where there is no sibling seeder install.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const EventEmitter = require('node:events')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('@hyperswarm/testnet')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const { authorizeRevoke, admitWriter } = require('../src/revocation')
const listMethods = require('../src/listMethods')
const seeders = require('../src/seeders')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

const SEEDER_DIR = path.join(__dirname, '..', '..', 'peerloom-seeder')
const haveSeeder = fs.existsSync(path.join(SEEDER_DIR, 'node_modules', 'blind-peer'))
const SECRET = 'oat-milk-secret-4471'

async function waitFor (label, fn, { timeout = 40000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error('timed out waiting for: ' + label)
}

test('a space backs up to a seeder', { skip: !haveSeeder && 'no ../peerloom-seeder install here' }, async (t) => {
  const { createSeeder } = require(path.join(SEEDER_DIR, 'src', 'seeder.js'))
  const testnet = await createTestnet(3)
  const seeder = await createSeeder({ dataDir: tmpDir(), bootstrap: testnet.bootstrap })
  const open = []
  t.after(async () => {
    for (const close of open.reverse()) { try { await close() } catch {} }
    try { await seeder.close() } catch {}
    await testnet.destroy()
    cleanupTmpDirs()
  })

  async function device (dir) {
    const responses = []
    const read = new EventEmitter()
    const engine = createGroupEngine({
      appId: 'pearlist', corestore: new Corestore(dir),
      createSwarm: ({ keyPair }) => new Hyperswarm({ keyPair, bootstrap: testnet.bootstrap }),
      applyOps: applyListOp, methods: listMethods, authorizeRevoke, admitWriter,
    })
    engine.start({ read, write: (buf) => responses.push(JSON.parse(buf.toString())) })
    let nextId = 1
    const call = (method, args = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      read.emit('data', Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
      const started = Date.now()
      const poll = setInterval(() => {
        const r = responses.find((x) => x.id === id)
        if (r) { clearInterval(poll); return r.error ? reject(new Error(r.error)) : resolve(r.result) }
        if (Date.now() - started > 60000) { clearInterval(poll); reject(new Error('HUNG: ' + method)) }
      }, 20)
    })
    await call('init', {})
    seeders.getSeeding(engine).start()
    const close = async () => { await seeders.getSeeding(engine).close(); await engine.close() }
    open.push(close)
    return { engine, call, close }
  }

  const dirA = tmpDir()
  const dirB = tmpDir()
  let A = await device(dirA)
  let B = await device(dirB)
  const { groupId, inviteKey } = await A.call('group:create', { name: 'Home' })
  await A.call('space:init', { groupId, name: 'Home' })
  await B.call('group:join', { inviteKey })
  await waitFor('B writable', () => B.engine.bases.get(groupId)?.writable === true)
  const { listId } = await A.call('list:create', { groupId, name: 'Shopping', kind: 'shopping' })
  await A.call('item:add', { groupId, listId, text: 'bread' })

  // A pairs. Its member row now lists the seeder.
  const { seederKey } = await A.call('seeder:pair', { link: seeder.openPairing().link })
  const bootstrap = b4a.toString(A.engine.bases.get(groupId).key, 'hex')
  await waitFor('the seeder allows the space', () => seeder.allowedSpaces().includes(bootstrap))
  await waitFor('B sees the seeder on the member rows', async () => {
    const base = B.engine.bases.get(groupId)
    await base.update()
    return (await seeders.seedersOfSpace(base)).includes(seederKey)
  })
  assert.deepEqual((await A.call('seeder:list')).map((s) => [s.seederKey, s.spaces]), [[seederKey, 1]])

  async function seederHas (key, length) {
    const core = seeder.peer.store.get({ key })
    await core.ready()
    const ok = core.contiguousLength >= length
    await core.close()
    return ok
  }
  const b = B.engine.bases.get(groupId)
  await waitFor('the seeder holds B\'s writes too', () => seederHas(b.local.key, b.local.length))

  // B is off; A adds an item; the seeder takes it; A is off; B comes back.
  await B.close()
  await A.call('item:add', { groupId, listId, text: SECRET })
  const a = A.engine.bases.get(groupId)
  await waitFor('the seeder has the new item', () => seederHas(a.local.key, a.local.length))
  await A.close()
  B = await device(dirB)
  await waitFor('B catches up from the seeder alone', async () => {
    const items = await B.call('item:getAll', { groupId, listId }).catch(() => [])
    return Array.isArray(items) && items.some((i) => i.text === SECRET)
  }, { timeout: 60000 })

  let hits = 0
  let scanned = 0
  for (const w of B.engine.bases.get(groupId).activeWriters) {
    const core = seeder.peer.store.get({ key: w.core.key })
    await core.ready()
    for (let i = 0; i < core.contiguousLength; i++) {
      const raw = await core.get(i, { raw: true, wait: false })
      if (!raw) continue
      scanned++
      if (b4a.indexOf(raw, b4a.from(SECRET)) !== -1) hits++
    }
    await core.close()
  }
  assert.ok(scanned > 0)
  assert.equal(hits, 0, 'the seeder holds no readable list text')

  // A comes back and stops using the seeder: off its rows, and the space is
  // dropped since no other member lists it.
  A = await device(dirA)
  await waitFor('A has the space again', () => !!A.engine.bases.get(groupId))
  const stop = await A.call('seeder:stop', { seederKey })
  assert.equal(stop.stopped, true)
  assert.deepEqual(await A.call('seeder:list'), [])
  await waitFor('the seeder schedules the drop', async () => (await seeder.drops()).some((d) => d.space === bootstrap))
  await waitFor('B no longer sees the seeder listed', async () => {
    const base = B.engine.bases.get(groupId)
    await base.update()
    return !(await seeders.seedersOfSpace(base)).includes(seederKey)
  })
})
