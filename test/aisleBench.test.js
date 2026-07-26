// Guards the aisle-prompt harness fixture (src/aisleFewshot.js). The harness runs
// the model on a device, so nothing here measures accuracy - these check that the
// thing being measured is the thing that ships, and that the labelled set is a fair
// test of the model's ACTUAL workload.

const test = require('node:test')
const assert = require('node:assert/strict')

const fs = require('fs')
const path = require('path')
const aisles = require('../src/aisles')
const { AISLES, SYSTEM, FULL, SHIPPED, VARIANTS, ITEMS, history, majorityVote, score } = require('../src/aisleFewshot')

test('what ships is the FOUR-example prompt, and exactly these four', () => {
  // Cut from eleven on 2026-07-26 after measuring all five variants: ~1.7x faster
  // for no measurable accuracy cost (the numbers are in src/aisleFewshot.js).
  // Each of the four earns its place, so losing one silently is a regression:
  //   SunChips  a brand -> the product it sells, the core skill
  //   Tide Pods a NON-FOOD brand, so household items do not land in a food aisle
  //   Chobani   a dairy brand
  //   cat food  the pet rule, the one instruction the taxonomy cannot infer
  assert.deepEqual(SHIPPED, [
    ['SunChips', 'Snacks'],
    ['Tide Pods', 'Household'],
    ['Chobani', 'Dairy & Eggs'],
    ['cat food', 'Pet'],
  ])
  assert.equal(SHIPPED, VARIANTS.v4, 'SHIPPED must BE a measured variant, not a hand-edited copy')
})

test('the shipped prompt renders exactly as the model sees it', () => {
  const msgs = history('Sargento', SHIPPED)
  assert.equal(msgs.length, 2 + SHIPPED.length * 2, 'system + 4 example pairs + the item')
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, 'You assign a grocery item to the single best supermarket aisle. Items are often BRAND NAMES - map the brand to the product it sells (e.g. a chip brand -> Snacks). Reply with JSON only.')
  assert.deepEqual(msgs.slice(1, 5), [
    { role: 'user', content: 'Item: "SunChips"' },
    { role: 'assistant', content: '{"aisle":"Snacks"}' },
    { role: 'user', content: 'Item: "Tide Pods"' },
    { role: 'assistant', content: '{"aisle":"Household"}' },
  ])
  assert.deepEqual(msgs[msgs.length - 1], { role: 'user', content: 'Item: "Sargento"' })
  assert.equal(SYSTEM, msgs[0].content)
})

test('the old eleven-example prompt is preserved verbatim as the reference', () => {
  // Every measurement is expressed as a delta against this, and every variant is a
  // subset of it, so it has to stay exactly as it shipped even though it no longer
  // does. If it drifts, the comparison table stops meaning anything.
  assert.equal(FULL.length, 11)
  assert.deepEqual(FULL.slice(0, 3), [['SunChips', 'Snacks'], ['La Croix', 'Beverages'], ['Tide Pods', 'Household']])
  assert.deepEqual(FULL.slice(-2), [['cat food', 'Pet'], ['dog food', 'Pet']])
  assert.equal(VARIANTS.v11, FULL)
})

test('the shipped prompt really is shorter than the old one', () => {
  const len = (shots) => history('x', shots).map((m) => m.content).join('').length
  assert.ok(len(SHIPPED) < len(FULL) * 0.65, 'the whole point was cutting prefill; this must stay well under the old size')
})

test('app/qvac.ts uses SHIPPED from the shared module, not a copy', () => {
  // The examples used to be inline in qvac.ts. If they come back, the harness
  // would be grading a prompt the app no longer uses - and the app would keep the
  // eleven-example cost forever.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'qvac.ts'), 'utf8')
  assert.match(src, /SHIPPED: AISLE_FEWSHOT/, 'the app must take the SHIPPED prompt')
  assert.doesNotMatch(src, /FULL: AISLE_FEWSHOT/, 'the app must not go back to the eleven-example prompt')
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
