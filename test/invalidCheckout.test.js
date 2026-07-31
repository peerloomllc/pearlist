// WHAT 'Invalid checkout N for batch, length is 0' ACTUALLY IS.
//
// The error that bricked both phones on 2026-07-30. It came out of
// `ctx.append(groupId, {type:'addWriter'})` and was filed as unexplained; PR #147
// stopped it killing the worklet but said nothing about why it happened.
//
// It is a SILENT FAILURE followed by a loud one - the same shape as almost every
// other bug found that day. Three lines, in two libraries:
//
//   1. hypercore/lib/copy-prologue.js:17
//        if (src.length < prologue.length || prologue.length === 0) return
//      Copies NOTHING and says nothing when the source is shorter than the
//      prologue being copied. No throw, no warning, no return value.
//
//   2. autobase/index.js:1570 (_migrateView) and :1522
//      (_applyFastForwardMigration)
//        const batch = next.session({ name: 'batch', overwrite: true, checkout: N })
//      Checks the fresh core out to N regardless. Nothing was copied, so its
//      length is 0.
//
//   3. hypercore/index.js:420
//        if (checkout > this.state.length) throw ASSERTION(...)
//      N > 0, so: 'Invalid checkout N for batch, length is 0'.
//
// The fast-forward caller is the worse of the two: it wraps the copy in
// `try {} catch {}` commented "we might be missing some nodes for this, just
// ignore, only an optimisation" - and then the very next line makes it mandatory.
//
// WHY IT LOOKED LIKE A RE-PAIR BUG: a view migration is what triggers it, and an
// indexer-set change is what triggers a view migration - which is exactly what an
// `addWriter` with `indexer: true` does. The append was the messenger.
//
// WHY THE NUMBER MOVED 15 -> 16: it is the view length being migrated to, so it
// tracks the space's state. Not a race. Not the fast-forward minimum, which is
// also 16 and a coincidence.
//
// WHAT IS STILL OPEN: which app-level sequence puts a PearList peer into the
// precondition (local view core behind the length being migrated to). Four
// in-process Autobase harnesses failed to produce it, and two suspects are ruled
// out below. See TODO.md and DECISIONS.md 2026-07-31.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const Corestore = require('corestore')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-checkout-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

// A destination core shaped the way autobase shapes a migrated view: a fresh core
// whose manifest declares a prologue copied from `src`.
async function migratedViewCore (store, name, src, length) {
  const next = store.get({
    name,
    manifest: {
      version: 1,
      hash: 'blake2b',
      allowPatch: false,
      quorum: 1,
      signers: [{ signature: 'ed25519', namespace: Buffer.alloc(32), publicKey: src.key }],
      prologue: { length, hash: await src.treeHash(length) }
    }
  })
  await next.ready()
  return next
}

// The crashing half runs in a child, because the assertion escapes twice and the
// second copy would take this runner down. Returns { out, err, status }.
function runCrashFixture (n) {
  const script = path.join(__dirname, 'fixtures', 'invalid-checkout-crash.js')
  try {
    const out = execFileSync(process.execPath, [script, String(n)], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
    })
    return { out, err: '', status: 0 }
  } catch (e) {
    return { out: e.stdout || '', err: e.stderr || '', status: e.status == null ? -1 : e.status }
  }
}

test('a source SHORTER than the prologue silently copies nothing, then asserts', () => {
  const { out, err, status } = runCrashFixture(16)

  assert.match(out, /COPIED_LENGTH 0/,
    'THE SILENT PART: copyPrologue copied nothing and reported nothing')
  assert.match(out, /CAUGHT ERR_ASSERTION /,
    'THE LOUD PART: the code the crash guard reported off the phone')
  assert.match(out, /Invalid checkout 16 for batch, length is 0/,
    'byte for byte the message the TCL threw')
  assert.notEqual(status, 0, 'and the process died even though the caller caught it')
  assert.match(err, /Invalid checkout 16 for batch, length is 0/,
    'the second copy escapes outside the promise the caller was holding')
  assert.ok(!out.includes('SURVIVED'),
    'awaiting in a try/catch is NOT enough to contain this - only the Bare-level guard is')
})

test('the checkout number is the VIEW LENGTH, which is why it moved 15 -> 16', () => {
  // Pin the PROPERTY - the number is whatever the migration is aiming at - rather
  // than the single value 16. A repeat attempt on a space that has moved on
  // reports a different number and is the SAME bug, not a new one.
  for (const n of [15, 41]) {
    const { out } = runCrashFixture(n)
    assert.match(out, new RegExp('CAUGHT ERR_ASSERTION .*Invalid checkout ' + n + ' for batch, length is 0'),
      'the message names the length being migrated to, not a constant')
  }
})

test('RULED OUT: retention clearing old blocks does NOT cause it', async (t) => {
  t.after(cleanup)
  const store = new Corestore(tmpDir())
  await store.ready()
  t.after(async () => { try { await store.close() } catch {} })

  // PearList is the app that prunes: retentionInterval 30 min, keepRecent 512
  // (src/bare.js). clear() was the obvious suspect, being the one thing we
  // deliberately do that removes blocks. It is NOT the cause - clear() leaves the
  // Merkle tree intact and drops only block data, and copyPrologue reads through
  // that happily. Measured, so it does not get re-proposed on intuition.
  const src = store.get({ name: 'src' })
  await src.ready()
  for (let i = 0; i < 24; i++) await src.append(Buffer.from('block-' + i))
  await src.clear(0, 8) // exactly the shape of retain(): a prefix, keeping recent

  const next = await migratedViewCore(store, 'next', src, 16)
  await next.core.copyPrologue(src.state)
  assert.equal(next.core.state.length, 16, 'the prologue copied fine across cleared blocks')

  const batch = next.session({ name: 'batch', overwrite: true, checkout: 16 })
  await batch.ready()
  assert.equal(batch.length, 16, 'and the checkout that follows it succeeds')
  await batch.close()
})

test('the two upstream lines that turn a skipped copy into a crash are still there', () => {
  // Source pins on the PROPERTY, not on one formatting. If either fails, upstream
  // has changed something relevant - re-read DECISIONS.md 2026-07-31 before
  // deleting the test, because the conclusion above may no longer hold.
  const ab = fs.readFileSync(require.resolve('autobase/index.js'), 'utf8')
  const cp = fs.readFileSync(require.resolve('hypercore/lib/copy-prologue.js'), 'utf8')

  assert.match(cp, /src\.length < prologue\.length \|\| prologue\.length === 0\) return/,
    'copy-prologue still returns silently when the source is short')
  assert.match(ab, /catch \{[\s\S]{0,80}we might be missing some nodes for this, just ignore/,
    'autobase still swallows the copy failure it then depends on')
  assert.match(ab, /name: 'batch', overwrite: true, checkout:/,
    'and still checks the batch out to a length it never verified was copied')
})
