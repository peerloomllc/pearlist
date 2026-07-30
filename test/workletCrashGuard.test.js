// An unhandled rejection must not kill the worklet.
//
// Bare aborts the whole worklet on an unhandled rejection or uncaught exception,
// and NOTHING listened for either - not here, not in @peerloom/core. So one stray
// rejection anywhere took PearList down on EVERY launch: open, hit the same
// rejection, die. Both test phones ended up unusable that way on 2026-07-30, from a
// single HypercoreError escaping the writer-admission path.
//
// A broken feature is recoverable. An app that will not start is not, and a user
// cannot tell "this crashed" from "this is gone".

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '../src/bare.js'), 'utf8')

test('the worklet listens for both fatal Bare events', () => {
  assert.match(src, /guard\('unhandledRejection'\)/, 'the one that took the phones down')
  assert.match(src, /guard\('uncaughtException'\)/, 'and its synchronous twin')
  assert.match(src, /Bare\.on\(kind,/, 'installed on the Bare global, which is what aborts')
})

test('it is installed BEFORE anything that can throw', () => {
  // The engine is what does the work, so a guard registered after it would miss a
  // rejection thrown during construction - which is exactly when this fired.
  const guardAt = src.indexOf("guard('unhandledRejection')")
  const engineAt = src.indexOf('createGroupEngine(')
  assert.ok(guardAt > 0 && engineAt > 0, 'found both')
  assert.ok(guardAt < engineAt, 'the guard goes in before the engine is built')
})

test('it reports LOUDLY rather than swallowing', () => {
  const at = src.indexOf('function guard (kind)')
  const body = src.slice(at, at + 500)
  // Every bug that cost real time today failed QUIETLY. A guard that hides the
  // error would trade a crash for an invisible fault, which is not obviously better.
  assert.match(body, /mark\('worklet:' \+ kind/, 'goes through the normal trace channel')
  assert.match(body, /err: \(err && err\.message\)/, 'carries the message')
  assert.match(body, /code: err && err\.code/, 'and the code, which is what named the Hypercore assertion')
})

test('a runtime without the hook is not made worse', () => {
  const at = src.indexOf('function guard (kind)')
  const body = src.slice(at, at + 500)
  // Bare.on may not exist on an older runtime. Failing to install the guard should
  // leave behaviour exactly as it was, not throw during boot and take the app down
  // in a new way.
  assert.match(body, /try \{[\s\S]*catch \{/, 'installation itself is guarded')
})
