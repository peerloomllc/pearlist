// Guards the aisle-prompt harness fixture (src/aisleFewshot.js). The harness runs
// the model on a device, so nothing here measures accuracy - these check that the
// thing being measured is the thing that ships, and that the labelled set is a fair
// test of the model's ACTUAL workload.

const test = require('node:test')
const assert = require('node:assert/strict')

const fs = require('fs')
const path = require('path')
const aisles = require('../src/aisles')
const { AISLES, SYSTEM, FULL, VARIANTS, ITEMS, history, majorityVote, score } = require('../src/aisleFewshot')

test('the shipped prompt is byte-identical to the pre-refactor wording', () => {
  // If this fails, either the prompt changed (which invalidates every number the
  // harness has produced and changes what users get), or the builder broke.
  const msgs = history('Sargento', FULL)
  assert.equal(msgs.length, 2 + FULL.length * 2, 'system + 11 example pairs + the item')
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, 'You assign a grocery item to the single best supermarket aisle. Items are often BRAND NAMES - map the brand to the product it sells (e.g. a chip brand -> Snacks). Reply with JSON only.')
  assert.deepEqual(msgs.slice(1, 5), [
    { role: 'user', content: 'Item: "SunChips"' },
    { role: 'assistant', content: '{"aisle":"Snacks"}' },
    { role: 'user', content: 'Item: "La Croix"' },
    { role: 'assistant', content: '{"aisle":"Beverages"}' },
  ])
  assert.deepEqual(msgs[msgs.length - 1], { role: 'user', content: 'Item: "Sargento"' })
  assert.equal(SYSTEM, msgs[0].content)
})

test('app/qvac.ts builds its prompt from the shared module, not a copy', () => {
  // The 11 examples used to be inline in qvac.ts. If they come back, the harness
  // would be grading a prompt the app no longer uses.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'qvac.ts'), 'utf8')
  assert.match(src, /require\('\.\.\/src\/aisleFewshot\.js'\)/)
  assert.doesNotMatch(src, /Item: "SunChips"/, 'few-shot examples must not be inline in qvac.ts')
})

test('every few-shot example teaches a REAL aisle', () => {
  for (const [item, aisle] of FULL) {
    assert.ok(AISLES.includes(aisle), `${item} -> ${aisle} is not an aisle`)
  }
})

test('every variant is a subset of the shipped few-shot, in the same order', () => {
  const full = FULL.map(([i]) => i)
  for (const [name, shots] of Object.entries(VARIANTS)) {
    const names = shots.map(([i]) => i)
    for (const n of names) assert.ok(full.includes(n), `${name} has an example not in FULL: ${n}`)
    const positions = names.map((n) => full.indexOf(n))
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${name} reorders the examples`)
  }
  assert.equal(VARIANTS.v11.length, FULL.length, 'v11 IS the shipped prompt')
  assert.equal(VARIANTS.v0.length, 0, 'v0 is the no-few-shot floor')
})

test('a shorter variant really is a shorter prompt', () => {
  const len = (v) => history('x', VARIANTS[v]).map((m) => m.content).join('').length
  assert.ok(len('v0') < len('v2'), 'v0 < v2')
  assert.ok(len('v2') < len('v4'), 'v2 < v4')
  assert.ok(len('v4') < len('v6'), 'v4 < v6')
  assert.ok(len('v6') < len('v11'), 'v6 < v11')
})

test('every labelled item is one the keyword matcher CANNOT place', () => {
  // The model only ever sees items the keyword pass left as 'Other'. Grading it on
  // items the matcher already handles would measure work the model never does.
  for (const [item] of ITEMS) {
    const kw = aisles.classifyAisle(item)
    assert.ok(!kw || kw === aisles.FALLBACK, `${item} is already placed by keywords (-> ${kw}); it does not belong in the set`)
  }
})

test('every label is a real aisle, and the set is not lopsided', () => {
  const byAisle = new Map()
  for (const [item, expected] of ITEMS) {
    assert.ok(AISLES.includes(expected), `${item} -> ${expected} is not an aisle`)
    assert.notEqual(expected, aisles.FALLBACK, `${item} cannot be labelled Other - that is the failure answer`)
    byAisle.set(expected, (byAisle.get(expected) || 0) + 1)
  }
  assert.ok(byAisle.size >= 10, `only ${byAisle.size} aisles covered`)
  for (const [aisle, n] of byAisle) assert.ok(n <= 4, `${aisle} has ${n} items, the set is skewed toward it`)
})

test('no duplicate items, and no item is also a few-shot example', () => {
  const seen = new Set()
  const examples = new Set(FULL.map(([i]) => i.toLowerCase()))
  for (const [item] of ITEMS) {
    const k = item.toLowerCase()
    assert.ok(!seen.has(k), `duplicate item: ${item}`)
    assert.ok(!examples.has(k), `${item} is in the prompt itself - grading it would be a giveaway`)
    seen.add(k)
  }
})

test('majority vote picks the most frequent answer, ties to first seen', () => {
  assert.deepEqual(majorityVote(['Pantry', 'Pantry', 'Baking']), { answer: 'Pantry', votes: 2, total: 3 })
  assert.deepEqual(majorityVote(['Baking', 'Pantry']), { answer: 'Baking', votes: 1, total: 2 })
  assert.deepEqual(majorityVote([null, null, 'Pantry']), { answer: null, votes: 2, total: 3 })
})

test('score grades on the majority, and reports the ceiling separately', () => {
  const g = score([
    { item: 'a', expected: 'Pantry', answers: ['Pantry', 'Pantry', 'Baking'] },  // majority right
    { item: 'b', expected: 'Pantry', answers: ['Baking', 'Baking', 'Pantry'] },  // majority wrong, one right
    { item: 'c', expected: 'Snacks', answers: [null, null, null] },              // unusable every run
  ])
  assert.equal(g.items, 3)
  assert.equal(+g.accuracy.toFixed(3), 0.333, 'only item a survives the vote')
  assert.equal(+g.anyCorrect.toFixed(3), 0.667, 'a and b each got it right at least once')
  assert.equal(+g.consistency.toFixed(3), 0.778, 'mean of 2/3, 2/3, 3/3')
  assert.equal(+g.nullRate.toFixed(3), 0.333, '3 of 9 calls unusable')
  assert.deepEqual(g.wrong.map((w) => w.item), ['b', 'c'])
})
