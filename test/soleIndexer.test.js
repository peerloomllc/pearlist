// You cannot revoke the ONLY indexer of a space, and the app must not claim it did.
//
// Found on hardware 2026-07-30, removing the TCL from the iPhone. The TCL created
// the space, so it is that space's only INDEXER - the iPhone had been admitted with
// `indexer: false`. Autobase refuses to remove the last indexer, core's engine marks
// `apply:revokewriter-unremoveable` and SKIPS, and the app - which counted a
// revocation when it APPENDED the op rather than when the op took effect - reported
// "that phone can no longer edit your shared lists" about a phone that could.
//
// The opposite direction had worked all day precisely because the phone being
// removed was NOT an indexer. That asymmetry is what hid it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-sole-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}
const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function apply (nodes, view, base) {
  return (async () => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter') {
        try { await base.addWriter(b4a.from(op.key, 'hex'), { indexer: op.indexer !== false }) } catch {}
        continue
      }
      if (op.type === 'put') await view.put(op.key, op.value)
    }
  })()
}

test('Autobase reports the sole indexer as un-removeable, which is the fact everything else rests on', async (t) => {
  t.after(cleanup)
  const storeA = new Corestore(tmpDir()); await storeA.ready()
  const A = new Autobase(storeA.namespace('g'), null, { open: openView, apply, valueEncoding: 'json' })
  await A.ready()
  t.after(async () => { try { await A.close() } catch {}; try { await storeA.close() } catch {} })

  const storeB = new Corestore(tmpDir()); await storeB.ready()
  const B = new Autobase(storeB.namespace('g'), A.key, { open: openView, apply, valueEncoding: 'json' })
  await B.ready()
  t.after(async () => { try { await B.close() } catch {}; try { await storeB.close() } catch {} })

  const s1 = storeA.replicate(true); const s2 = storeB.replicate(false); s1.pipe(s2).pipe(s1)
  t.after(() => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  // B joins as a NON-indexer, which is how a space admits a paired device.
  await A.base ? null : null
  await A.append({ type: 'put', key: 'hello', value: 1 })
  await A.append({ type: 'addWriter', key: hex(B.local.key), indexer: false })
  for (const p of [A, B]) { try { await p.update() } catch {} }
  await sleep(2500)
  for (const p of [A, B]) { try { await p.update() } catch {} }

  assert.equal(B.writable, true, 'B can write')
  // A is the only indexer, so A cannot be removed - and B, a non-indexer, can.
  assert.equal(A.removeable(A.local.key), false, 'the sole indexer is NOT removeable')
  assert.equal(A.removeable(B.local.key), true, 'a non-indexer is removeable')
})

test('the app checks removeable BEFORE appending, so it cannot claim a revocation that will be skipped', () => {
  const src = read('src/listMethods.js')
  const at = src.indexOf('async function spaceRevokeBlocker')
  assert.ok(at > 0, 'the shared predicate exists')
  const body = src.slice(at, src.indexOf('\n}', at))
  assert.match(body, /base\.removeable\(b4a\.from\(row\._w, 'hex'\)\)/,
    'asks the same question the engine will ask')
  assert.match(body, /return 'sole-indexer'/, 'and names the reason distinctly')

  // It must be in the SHARED predicate, not bolted onto one caller - otherwise the
  // preview and the action disagree again, which is the bug that predates this one.
  const calls = src.match(/await spaceRevokeBlocker\(/g) || []
  assert.equal(calls.length, 2, 'still used by BOTH the preview and the removal')
})

test('the sole-indexer outcome gets its own message, not "everyone has to update"', () => {
  const src = read('src/ui/App.jsx')
  const at = src.indexOf('async function removeDevice')
  const body = src.slice(at, src.indexOf('\n  const fileRef', at))
  assert.match(body, /why === 'sole-indexer'/, 'the case is handled')
  assert.match(body, /only device that signs for one of your spaces/i,
    'and explained in terms a person can act on')
  // The generic "everyone has to be on the latest version" advice is WRONG here -
  // no amount of updating other phones makes the last indexer removeable - so the
  // sole-indexer branch must come BEFORE the generic ones.
  //
  // Scoped to the RESULT handling: that phrase also appears in the confirm text
  // further up, and comparing against that occurrence made this assert fail while
  // the ordering was already correct.
  const results = body.slice(body.indexOf('const sp = res && res.spaces'))
  assert.ok(results.indexOf("why === 'sole-indexer'") > 0, 'the branch is in the result handling')
  assert.ok(results.indexOf("why === 'sole-indexer'") < results.indexOf('has to be on the latest version'),
    'checked before the generic update advice, or the user is sent to fix the wrong thing')
})
