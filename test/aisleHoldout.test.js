// THE HOLD-OUT MUST STAY A HOLD-OUT.
//
// scripts/aisle-accuracy.mjs has always documented `--burn` as the flag that gates
// naming held-out misses, and its header explains that printing them by default is
// what burned round one's hold-out on 2026-07-26. Until 2026-09-10 the flag existed
// ONLY in that comment: the misses loop printed every miss, held ones included. So
// the first run against the fresh hold-out written that day burned it immediately,
// in exactly the way the comment said the flag prevented.
//
// A comment is not a guard. These tests are the guard.
//
// They deliberately assert on the SHAPE of the output and never on a fixture's
// contents or its score. A test carrying a held item's text, or the number to beat,
// would leak the same thing the flag protects.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const HOLDOUT = 'test/fixtures/aisle-holdout.json'
const TUNED = ['test/fixtures/aisle-items.json', 'test/fixtures/aisle-phrasing.json']

const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
const score = (args) => execFileSync('node', ['scripts/aisle-accuracy.mjs', ...args], { cwd: root, encoding: 'utf8' })

test('every item in the hold-out is held, or it is not a hold-out', () => {
  const { items } = read(HOLDOUT)
  assert.ok(items.length > 0)
  assert.equal(items.every((i) => i.held === true), true, 'one un-held item makes the headline number a blend')
})

test('the hold-out shares no item with anything the table was tuned against', () => {
  const tuned = new Set(TUNED.flatMap((f) => read(f).items.map((i) => i.text.toLowerCase())))
  const overlap = read(HOLDOUT).items.map((i) => i.text.toLowerCase()).filter((t) => tuned.has(t))
  assert.deepEqual(overlap, [], 'an item present in a tuned fixture is being scored against its own training data')
})

test('held-out misses are NOT named without --burn', () => {
  const out = score(['--file', HOLDOUT])
  // The whole point: the run is useful (it prints a score) and tells you nothing
  // about WHICH items failed.
  assert.match(out, /held-out \d+\/\d+/, 'it still reports the score')
  assert.doesNotMatch(out, /\[held\]/, 'and names no held item')
  assert.match(out, /NOT named/, 'and says it is holding them back, rather than being silently empty')
})

test('--burn names them, so the escape hatch still works', () => {
  const out = score(['--file', HOLDOUT, '--burn'])
  assert.match(out, /\[held\]/, 'burning is still possible on purpose')
  assert.doesNotMatch(out, /NOT named/)
})

test('the tuned fixture still scores, so --file did not break the default', () => {
  const out = score(['--quiet'])
  assert.match(out, /fixture {2}test\/fixtures\/aisle-items\.json/, 'no --file means the tuned fixture')
  assert.match(out, /overall {2}\d+\/\d+/)
})
