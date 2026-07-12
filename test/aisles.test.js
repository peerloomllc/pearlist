const test = require('node:test')
const assert = require('node:assert/strict')
const { AISLES, FALLBACK, normalizeAisle, sanitizeCustomAisle, bucketOf, classifyAisle, aisleOrder } = require('../src/aisles')

test('classifies common items into the expected aisle', () => {
  assert.equal(classifyAisle('Bananas'), 'Produce')
  assert.equal(classifyAisle('spinach'), 'Produce')
  assert.equal(classifyAisle('Whole milk'), 'Dairy & Eggs')
  assert.equal(classifyAisle('dozen eggs'), 'Dairy & Eggs')
  assert.equal(classifyAisle('chicken thighs'), 'Meat & Seafood')
  assert.equal(classifyAisle('Sourdough bread'), 'Bakery')
  assert.equal(classifyAisle('coffee'), 'Beverages')
  assert.equal(classifyAisle('toilet paper'), 'Household')
  assert.equal(classifyAisle('toothpaste'), 'Personal Care')
})

test('new aisles: baking, condiments, alcohol', () => {
  assert.equal(classifyAisle('all-purpose flour'), 'Baking')
  assert.equal(classifyAisle('vanilla extract'), 'Baking')
  assert.equal(classifyAisle('ketchup'), 'Condiments')
  assert.equal(classifyAisle('sriracha'), 'Condiments')
  assert.equal(classifyAisle('hot sauce'), 'Condiments') // beats bare "sauce" -> Pantry
  assert.equal(classifyAisle('red wine'), 'Alcohol') // "wine" moved out of Beverages
  assert.equal(classifyAisle('IPA'), 'Alcohol')
  assert.equal(classifyAisle('ginger ale'), 'Beverages') // stays put despite the new Alcohol aisle
})

test('pet food is deterministic (never a human-food aisle)', () => {
  assert.equal(classifyAisle('cat food'), 'Pet')
  assert.equal(classifyAisle('dog food'), 'Pet')
  assert.equal(classifyAisle('Purina'), 'Pet')
  assert.equal(classifyAisle('cat litter'), 'Pet')
})

test('multi-word phrases match on word boundaries', () => {
  assert.equal(classifyAisle('ice cream'), 'Frozen') // Frozen wins over Dairy "cream"
  assert.equal(classifyAisle('peanut butter'), 'Pantry')
  assert.equal(classifyAisle('paper towels'), 'Household')
})

test('unknown or empty items fall back to Other, never null', () => {
  assert.equal(classifyAisle('flux capacitor'), FALLBACK)
  assert.equal(classifyAisle(''), FALLBACK)
  assert.equal(classifyAisle(null), FALLBACK)
  assert.equal(classifyAisle(undefined), FALLBACK)
})

test('does not match a substring across word boundaries', () => {
  // "spear" contains "pear" but must not classify as Produce off a bare "pear".
  assert.equal(classifyAisle('spear'), FALLBACK)
})

test('every classified aisle is a known aisle', () => {
  for (const sample of ['milk', 'banana', 'chicken', 'bread', 'nonsense-xyz']) {
    assert.ok(AISLES.includes(classifyAisle(sample)))
  }
})

test('normalizeAisle keeps known aisles and rejects anything else', () => {
  assert.equal(normalizeAisle('Produce'), 'Produce')
  assert.equal(normalizeAisle('produce'), null) // exact match only
  assert.equal(normalizeAisle('Aisle 9'), null)
  assert.equal(normalizeAisle(42), null)
  assert.equal(normalizeAisle(null), null)
})

test('sanitizeCustomAisle trims, collapses, caps, rejects empty', () => {
  assert.equal(sanitizeCustomAisle('  Sushi  '), 'Sushi')
  assert.equal(sanitizeCustomAisle('deli   counter'), 'deli counter')
  assert.equal(sanitizeCustomAisle('   '), null)
  assert.equal(sanitizeCustomAisle(''), null)
  assert.equal(sanitizeCustomAisle(42), null)
  assert.equal(sanitizeCustomAisle('x'.repeat(40)).length, 24)
})

test('bucketOf: any non-empty label is its own section, blank -> Other', () => {
  assert.equal(bucketOf('Produce'), 'Produce')
  assert.equal(bucketOf('Sushi'), 'Sushi') // custom label keeps its own bucket
  assert.equal(bucketOf('Other'), 'Other')
  assert.equal(bucketOf(''), FALLBACK)
  assert.equal(bucketOf(undefined), FALLBACK)
  assert.equal(bucketOf(null), FALLBACK)
})

test('aisleOrder sorts Other last and unknowns past the end', () => {
  assert.equal(aisleOrder('Produce'), 0)
  assert.equal(aisleOrder('Other'), AISLES.length - 1)
  assert.equal(aisleOrder('Nope'), AISLES.length)
})
