// Two bugs that both presented as SILENCE, which is why they are tested together.
//
// 1. grantGroupWriter appended to the SPACE base from inside the PERSONAL base's
//    apply. Appending to one base from another's apply asserts in Hyperbee -
//    "Invalid checkout 15 for batch, length is 0" - and the rejection was swallowed,
//    so it degraded to "the space grant did not happen" with nothing said. It did
//    NOT reproduce on the iPhone minutes earlier, so it is timing-dependent.
//
// 2. A removal that touched no space reported NOTHING AT ALL. Watched on the TCL
//    2026-07-30: removed from the account, still editing the household list, no
//    error and no confirmation. The silence was the only clue.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

test('the per-space grant is queued, not appended from inside apply', () => {
  const src = read('src/deviceLink.js')

  // The old shape: an await straight onto ctx.append inside the plugin method that
  // device-link calls from its apply loop.
  const at = src.indexOf('grantGroupWriter (groupId, writerKey)')
  assert.ok(at > 0, 'found the plugin method')
  const method = src.slice(at, at + 400)
  assert.doesNotMatch(method, /await ctx\.append\(/, 'must not append from the apply context')
  assert.match(method, /scheduleGroupWriterGrant\(ctx, groupId, String\(writerKey\)\)/, 'queues instead')

  // The queue itself must actually leave the current turn.
  const q = src.slice(src.indexOf('function scheduleGroupWriterGrant'))
  assert.match(q, /setTimeout\(attempt, 0\)/, 'runs on a later turn, out of apply')
  assert.match(q, /if \(n < 5\)/, 'retries, because the failure is timing-dependent')
  assert.match(q, /dl:grantGroupWriter-failed/, 'and traces failure')
  assert.match(q, /dl:grantGroupWriter'/, 'and traces success, so the two are distinguishable')
})

test('a duplicate grant for the same space+writer is not queued twice', () => {
  // The deviceGroupWriter op is applied on EVERY device and can replay, so without
  // this the same grant would be appended repeatedly - write amplification, which
  // this app has already had once.
  const src = read('src/deviceLink.js')
  const q = src.slice(src.indexOf('function scheduleGroupWriterGrant'))
  assert.match(q, /if \(_pendingGrants\.has\(key\)\) return/, 'deduped')
  assert.match(q, /const key = groupId \+ ':' \+ writerKey/, 'keyed by both, not by group alone')
})

test('a removal that touched no space still says something', () => {
  const src = read('src/ui/App.jsx')
  const at = src.indexOf('async function removeDevice')
  const body = src.slice(at, src.indexOf('\n  const fileRef', at))

  // There must be an else on the `spaces` branch at all - its absence is the bug.
  const spAt = body.indexOf('const sp = res && res.spaces')
  assert.ok(spAt > 0, 'found the result handling')
  const results = body.slice(spAt)
  assert.match(results, /\} else \{[\s\S]{0,400}await notify\(/, 'the no-space case is not silent')

  // And the two ways of getting there must read differently: "nothing to cut off"
  // is good news, "could not tell which member it is" means it may still be editing.
  assert.match(results, /res && res\.appPubkey/, 'distinguishes the two causes')
  assert.match(results, /no shared lists to cut it off from/i, 'the benign case')
  assert.match(results, /could not work out which member it is/i, 'the case that is NOT done')
  assert.match(results, /Only partly removed/, 'and titles it so it does not read as success')
})
