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

// THE PATH REAL USERS WALK. The on-device model only ever sees items the keyword
// pass leaves as 'Other', and the model is right about half the time on those. But
// people write "Kikkoman soy sauce", not "Kikkoman" - and with the noun present the
// keyword pass places it instantly, correctly, and the model is never asked.
//
// Measured while grading the model (2026-07-26): of 26 brand items written the way
// someone actually writes a list, 23 are placed here and only 3 reach the model.
// That is the whole argument for spending effort on this list rather than on the
// prompt, so it is pinned: a regression here silently pushes work onto a 4-second
// coin flip.
test('cleaning brands are not drinks or snacks', () => {
  // Found while building the model's test set: "Scotch-Brite" matched 'scotch' and
  // filed under Alcohol, "Bar Keepers Friend" matched 'bar' and filed under Snacks.
  // Same class as the misfires above - one everyday word inside a brand name.
  assert.equal(classifyAisle('Scotch-Brite'), 'Household')
  assert.equal(classifyAisle('Bar Keepers Friend'), 'Household')
  assert.equal(classifyAisle('scotch'), 'Alcohol')      // the word itself is untouched
  assert.equal(classifyAisle('granola bar'), 'Snacks')
})

test('brand + the actual product resolves without the model', () => {
  const cases = [
    ['Sargento cheese', 'Dairy & Eggs'],
    ['Kerrygold butter', 'Dairy & Eggs'],
    ['Modelo beer', 'Alcohol'],
    ['Barefoot wine', 'Alcohol'],
    ['Folgers coffee', 'Beverages'],
    ['Spindrift sparkling water', 'Beverages'],
    ['Neutrogena face wash', 'Personal Care'],
    // Hand soap is Personal Care; DISH soap is Household. Mrs Meyers makes both,
    // which is exactly why the noun decides it and the brand cannot.
    ['Mrs Meyers hand soap', 'Personal Care'],
    ['Mrs Meyers dish soap', 'Household'],
    ['Seventh Generation detergent', 'Household'],
    ['Barilla pasta', 'Pantry'],
    ['Progresso soup', 'Pantry'],
    ['Duncan Hines cake mix', 'Baking'],
    ['Stouffers frozen lasagna', 'Frozen'],
    ['Ore-Ida frozen fries', 'Frozen'],
    ['Kings Hawaiian rolls', 'Bakery'],
    ['Sara Lee bread', 'Bakery'],
    ['Butterball turkey', 'Meat & Seafood'],
    ['Applegate deli ham', 'Meat & Seafood'],
    ['Cholula hot sauce', 'Condiments'],
    ['Kikkoman soy sauce', 'Condiments'],
    ['RXBAR protein bar', 'Snacks'],
    ['Clif bar', 'Snacks'],
    ['Fresh Step cat litter', 'Pet'],
  ]
  for (const [item, expected] of cases) {
    assert.equal(classifyAisle(item), expected, `${item} should be ${expected} without asking the model`)
  }
})

test('the brand ALONE now resolves too, instead of going to the model', () => {
  // These seven were measured wrong by the on-device model in EVERY prompt variant
  // on BOTH hosts (2026-07-26): Barefoot wine filed under Baking, Folgers under
  // Household, an RXBAR under Produce. Four seconds each to get them wrong. They
  // are keywords now, so the model is never asked.
  const cases = [
    ['Sargento', 'Dairy & Eggs'],
    ['Modelo', 'Alcohol'],
    ['Barefoot', 'Alcohol'],
    ['Folgers', 'Beverages'],
    ['Progresso', 'Pantry'],
    ['Kikkoman', 'Condiments'],
    ['RXBAR', 'Snacks'],
    ['Stouffers', 'Frozen'],
    ['Applegate', 'Meat & Seafood'],
  ]
  for (const [brand, expected] of cases) {
    assert.equal(classifyAisle(brand), expected, `${brand} should resolve without the model`)
  }
})

test('a brand never outranks the product noun next to it', () => {
  // The reason BRANDS is a separate, lower-priority table. A brand can sell across
  // aisles, so when both are present the noun is the one that knows what was bought.
  assert.equal(classifyAisle('Mrs Meyers hand soap'), 'Personal Care')  // brand says Household
  assert.equal(classifyAisle('Mrs Meyers dish soap'), 'Household')
  assert.equal(classifyAisle('Mrs Meyers'), 'Household')                // brand alone decides
  assert.equal(classifyAisle('Dole pineapple juice'), 'Beverages')      // brand says Produce
  assert.equal(classifyAisle('Dole'), 'Produce')
  assert.equal(classifyAisle('Seventh Generation diapers'), 'Personal Care') // brand says Household
})

test('unknown or empty items fall back to Other, never null', () => {
  assert.equal(classifyAisle('flux capacitor'), FALLBACK)
  assert.equal(classifyAisle(''), FALLBACK)
  assert.equal(classifyAisle(null), FALLBACK)
  assert.equal(classifyAisle(undefined), FALLBACK)
})

test("possessive brands match, apostrophe or not", () => {
  // The tokenizer used to split on the apostrophe, so "King's Hawaiian" became
  // "king s hawaiian" and could never match a keyword. Several entries in the
  // tables were dead on arrival for exactly this reason - "lay's", "campbell's",
  // "hellmann's", "reese's", "totino's", "ben & jerry's" - and only worked at all
  // because someone had also written the apostrophe-free spelling next to them.
  assert.equal(classifyAisle("King's Hawaiian"), 'Bakery')
  assert.equal(classifyAisle('Kings Hawaiian'), 'Bakery')
  assert.equal(classifyAisle("Lay's"), 'Snacks')
  assert.equal(classifyAisle("Campbell's soup"), 'Pantry')
  assert.equal(classifyAisle("Ben & Jerry's"), 'Frozen')
  assert.equal(classifyAisle("Hellmann's mayo"), 'Condiments')
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

// ── Fixture-driven accuracy guard ───────────────────────────────────────────
// The keyword table is the WHOLE classifier since the on-device model was
// removed (DECISIONS.md 2026-07-26), so its coverage is a shipping property and
// belongs in the verify gate rather than in a script someone remembers to run.
//
// Two assertions, and the second is the important one:
//
//   1. Accuracy stays above a floor. Catches vocabulary rotting away.
//   2. NOTHING is filed into a confidently WRONG aisle. An item left in 'Other'
//      is a miss the user fixes with one drag, and PearList then remembers it.
//      An item filed wrongly is not noticed until they are standing in the wrong
//      part of the shop. So a regression that moves an item correct -> Other is
//      tolerable and one that moves it correct -> wrong aisle is not, and only
//      the second fails the build.
//
// Both fixtures currently score 100%. The floor is deliberately BELOW that, so
// adding a genuinely hard item to a fixture does not break the build - but if it
// lands in the wrong aisle rather than Other, assertion 2 still catches it.
const FIXTURES = ['./fixtures/aisle-items.json', './fixtures/aisle-phrasing.json']
const ACCURACY_FLOOR = 0.9

for (const path of FIXTURES) {
  const { items } = require(path)
  const name = path.split('/').pop()

  test(`${name}: nothing lands in a confidently WRONG aisle`, () => {
    const misfiled = items
      .map((it) => ({ ...it, got: classifyAisle(it.text) }))
      .filter((r) => r.got !== r.expect && r.got !== FALLBACK)
      .map((r) => `${r.text}: expected ${r.expect}, got ${r.got}`)
    assert.deepEqual(misfiled, [], `misfiled items (Other would be acceptable, a wrong aisle is not):\n  ${misfiled.join('\n  ')}`)
  })

  test(`${name}: accuracy stays above the floor`, () => {
    const hit = items.filter((it) => classifyAisle(it.text) === it.expect).length
    const pct = hit / items.length
    assert.ok(pct >= ACCURACY_FLOOR, `${name} accuracy ${(100 * pct).toFixed(1)}% fell below the ${100 * ACCURACY_FLOOR}% floor (${hit}/${items.length})`)
  })
}

// ── Precedence probes ───────────────────────────────────────────────────────
// The 2026-07-26 widening roughly 2.5x'd the keyword table, and every word added
// is a chance to STEAL an item from a phrase that was working. These pairs are
// the collisions that widening created or narrowly avoided: each left-hand item
// must beat a shorter rule pointing somewhere else, and each right-hand one must
// still reach the shorter rule. They fail as a pair, which is the point - fixing
// a steal by reordering the table usually breaks its partner.
test('longest-match precedence survives the widened table', () => {
  const probes = [
    ['pie crust', 'Bakery'], ['pot pie', 'Frozen'], ['pie filling', 'Pantry'],
    ['butternut squash', 'Produce'], ['fig bars', 'Snacks'],
    ['pepper jack', 'Dairy & Eggs'], ['bell pepper', 'Produce'],
    ['blue cheese dressing', 'Condiments'], ['blue cheese', 'Dairy & Eggs'],
    ['sour cream dip', 'Condiments'], ['sour cream', 'Dairy & Eggs'],
    ['ice pack', 'Personal Care'], ['ice cream', 'Frozen'],
    ['fish food', 'Pet'], ['fish sauce', 'Condiments'], ['fish sticks', 'Frozen'], ['salmon', 'Meat & Seafood'],
    ['pet wipes', 'Pet'], ['baby wipes', 'Personal Care'], ['disinfecting wipes', 'Household'],
    ['rice cakes', 'Snacks'], ['rice krispies', 'Pantry'], ['rice krispie treats', 'Snacks'], ['brown rice', 'Pantry'],
    ['hot chocolate', 'Beverages'], ['chocolate chips', 'Baking'], ['chocolate bar', 'Snacks'],
    ['coconut milk', 'Pantry'], ['whole milk', 'Dairy & Eggs'],
    ['tomato paste', 'Pantry'], ['tomatoes', 'Produce'],
    ['beef jerky', 'Snacks'], ['ground beef', 'Meat & Seafood'],
    ['pizza dough', 'Bakery'], ['frozen pizza', 'Frozen'],
    ['hand soap', 'Personal Care'], ['dish soap', 'Household'], ['laundry soap', 'Household'],
    ['red wine', 'Alcohol'], ['red wine vinegar', 'Pantry'],
    // 'corn' is deliberately NOT a rule - fresh, canned and frozen are three
    // aisles - so all four of these have to come from the qualified phrase.
    ['corn on the cob', 'Produce'], ['canned corn', 'Pantry'], ['frozen corn', 'Frozen'], ['corn chips', 'Snacks'],
  ]
  const wrong = probes.filter(([text, want]) => classifyAisle(text) !== want)
    .map(([text, want]) => `${text}: expected ${want}, got ${classifyAisle(text)}`)
  assert.deepEqual(wrong, [], `precedence broken:\n  ${wrong.join('\n  ')}`)
})
