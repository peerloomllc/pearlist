// A STORE THIS DEVICE CANNOT OPEN MUST ANSWER, NOT HANG.
//
// Written for the 2026-09-10 GrapheneOS report: PearList 1.0.9 opening to a black
// screen, then a black screen with the loading spinner and nothing else. The first
// theory was that the OS update rebooted the phone mid-write and left the store
// half written, and that opening it hung the worklet forever.
//
// It does not. Every way of damaging a Corestore that was tried here comes back as
// a clean error reply well inside the shell's 25s init budget, or opens fine. So a
// damaged store is NOT how the reported symptom happens, and the shell must treat
// that error reply as a failed boot: before PR #184 it ignored `{ error }` from
// init entirely and carried on, which showed a device with an unreadable store an
// EMPTY PearList. That reads as "my lists are gone" and invites clearing app
// storage, which is the one action that would actually make it true.
//
// The suite's other stores are built by helpers. These are built and damaged in
// place ON PURPOSE: RocksDB records the device and inode of its own files, so a
// COPIED store refuses to open with "Invalid device file, was moved unsafely"
// whether or not anything is wrong with it. Copying made all five damage modes
// produce that one identical error on the first attempt and proved nothing.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const Corestore = require('corestore')
const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('../src/listWire')
const listMethods = require('../src/listMethods')
const { tmpDir, cleanupTmpDirs } = require('./helpers/tmpdir')

after(cleanupTmpDirs)

// The shell's own budget (app/index.tsx WORKLET_INIT_TIMEOUT_MS). A reply that
// arrives after this is a hang as far as the user is concerned.
const INIT_BUDGET_MS = 25_000

function fakeSwarm () {
  const ee = new EventEmitter()
  ee.join = () => ({ flushed: async () => {} })
  ee.leave = async () => {}
  ee.destroy = async () => {}
  return ee
}

function driver (dir) {
  const responses = []
  const read = new EventEmitter()
  const engine = createGroupEngine({
    appId: 'pearlist', corestore: new Corestore(dir), createSwarm: fakeSwarm,
    applyOps: applyListOp, methods: listMethods,
  })
  engine.start({ read, write: (buf) => responses.push(JSON.parse(buf.toString())) })
  let nextId = 1
  // Resolves with the whole message, exactly as the shell's callRaw does, so a
  // reply carrying `error` is a resolution here too and not a rejection.
  const call = (method, args = {}, budget = INIT_BUDGET_MS) => new Promise((resolve, reject) => {
    const id = nextId++
    read.emit('data', Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
    const started = Date.now()
    const poll = setInterval(() => {
      const r = responses.find((x) => x.id === id)
      if (r) { clearInterval(poll); return resolve(r) }
      if (Date.now() - started > budget) { clearInterval(poll); reject(new Error('HUNG: no reply in ' + budget + 'ms')) }
    }, 20)
  })
  return { engine, call }
}

// A store that has been used for real and then closed cleanly, which is what a
// phone has on it when the OS reboots for an update.
async function usedStore () {
  const dir = tmpDir('damaged-')
  const d = driver(dir)
  await d.call('init')
  const g = (await d.call('group:create', { name: 'Household' })).result
  const l = (await d.call('list:create', { groupId: g.groupId, name: 'Groceries' })).result
  await d.call('item:add', { groupId: g.groupId, listId: l.listId, text: 'Oat milk' })
  await d.engine.close?.()
  await new Promise((r) => setTimeout(r, 400))
  return dir
}

const files = (root) => {
  const out = []
  ;(function walk (p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      e.isDirectory() ? walk(f) : out.push(path.relative(root, f))
    }
  })(root)
  return out
}
const find = (root, m) => {
  const hit = files(root).find(m)
  assert.ok(hit, 'expected a matching file in the store: ' + files(root).join(', '))
  return path.join(root, hit)
}
const halve = (f) => fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2))

// Each of these is a way a power cut mid-write leaves a RocksDB store.
const DAMAGE = {
  'a MANIFEST truncated mid-write': (d) => halve(find(d, (x) => x.includes('MANIFEST'))),
  'an emptied CURRENT': (d) => fs.truncateSync(find(d, (x) => x.endsWith('CURRENT')), 0),
  'a missing MANIFEST': (d) => fs.rmSync(find(d, (x) => x.includes('MANIFEST'))),
  'a zeroed CORESTORE header': (d) => {
    const f = find(d, (x) => x === 'CORESTORE')
    fs.writeFileSync(f, Buffer.alloc(fs.statSync(f).size))
  },
  'a WAL truncated mid-write': (d) => halve(find(d, (x) => x.endsWith('.log'))),
  'a stale LOCK left behind': (d) => fs.writeFileSync(find(d, (x) => x.endsWith('LOCK')), 'x'),
}

for (const [name, damage] of Object.entries(DAMAGE)) {
  test(`init answers within the shell's budget with ${name}`, async () => {
    const dir = await usedStore()
    damage(dir)
    const d = driver(dir)
    // The assertion is that this RESOLVES at all. A hang rejects with HUNG, which
    // is the symptom this test exists to rule out.
    const reply = await d.call('init')
    if (reply.error != null) {
      assert.equal(typeof reply.error, 'string')
      assert.ok(reply.error.length > 0, 'a refusal has to say why, that string is what the user copies to us')
    } else {
      assert.ok(reply.result, 'it opened, which is a fine answer too')
    }
    try { await d.engine.close?.() } catch {}
  })
}
