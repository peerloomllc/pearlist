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

// Ties are broken by WORD COUNT and then by table order, and Personal Care is
// last, so a one-word match in an earlier aisle used to swallow whole categories
// of everyday item: "potato chips" filed as Produce, "apple juice" as Produce,
// "chicken broth" as Meat & Seafood, "shaving cream" as Dairy & Eggs, "bar soap"
// as Snacks (via "bar"). 21 of 58 probed everyday items came back wrong.
//
// The fix is naming the two-word phrase, which outranks any single word without
// reordering the table (reordering would change every other tie at once). These
// are pinned as a table because the failure mode is silent - a misfiled item just
// shows up in an odd aisle and looks like the classifier being dim.
test('two-word phrases beat the single word they contain', () => {
  const cases = [
    // the word that used to win is in brackets
    ['potato chips', 'Snacks'],        // [potato] -> Produce
    ['tortilla chips', 'Snacks'],      // [tortilla] -> Bakery
    ['kettle chips', 'Snacks'],
    ['apple juice', 'Beverages'],      // [apple] -> Produce
    ['orange juice', 'Beverages'],     // [orange] -> Produce
    ['root beer', 'Beverages'],        // [beer] -> Alcohol
    ['chicken broth', 'Pantry'],       // [chicken] -> Meat & Seafood
    ['beef stock', 'Pantry'],          // [beef] -> Meat & Seafood
    ['wine vinegar', 'Pantry'],        // [wine] -> Alcohol
    ['egg noodles', 'Pantry'],         // [egg] -> Dairy & Eggs
    ['bar soap', 'Personal Care'],     // [bar] -> Snacks
    ['hand soap', 'Personal Care'],    // [soap] -> Household
    ['body wash', 'Personal Care'],
    ['shaving cream', 'Personal Care'],// [cream] -> Dairy & Eggs
    ['baby oil', 'Personal Care'],     // [oil] -> Pantry
    ['old spice', 'Personal Care'],    // [spice] -> Pantry
    ['bath salts', 'Personal Care'],   // [salt] -> Pantry
    ['ghirardelli chips', 'Baking'],   // [chips] -> Snacks
  ]
  for (const [item, expected] of cases) {
    assert.equal(classifyAisle(item), expected, `${item} should be ${expected}`)
  }
})

test('the single-word behaviour those phrases sit on top of is unchanged', () => {
  // The pairs above must not have cost us the plain words.
  const cases = [
    ['apple', 'Produce'], ['potato', 'Produce'], ['beer', 'Alcohol'], ['wine', 'Alcohol'],
    ['chicken', 'Meat & Seafood'], ['beef', 'Meat & Seafood'], ['cream', 'Dairy & Eggs'],
    ['eggs', 'Dairy & Eggs'], ['salt', 'Pantry'], ['oil', 'Pantry'], ['chips', 'Snacks'],
    ['dish soap', 'Household'], ['tortillas', 'Bakery'], ['chocolate chips', 'Baking'],
  ]
  for (const [item, expected] of cases) {
    assert.equal(classifyAisle(item), expected, `${item} should still be ${expected}`)
  }
})

test('brand + category together still resolve (real shopping-list wording)', () => {
  assert.equal(classifyAisle('Dove bar soap'), 'Personal Care')
  assert.equal(classifyAisle('Lays potato chips'), 'Snacks')
  assert.equal(classifyAisle('Swanson chicken broth'), 'Pantry')
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
