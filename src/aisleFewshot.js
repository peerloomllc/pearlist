// The aisle classifier's few-shot prompt, its trimmed variants, and the labelled
// set we measure them against. Pure data + scoring, so the harness (app/bench.ts,
// which runs the real model on a device) and the unit tests share one source.
//
// WHY THIS EXISTS. The classifier costs 5.9s/item and 81% of that is PREFILL:
// ~350 prompt tokens re-processed to emit 8 tokens of JSON (measured 2026-07-13,
// see DONE.md). Batching and kvCache are both dead ends because they target
// decode. The only lever left is making the prompt shorter, which is a straight
// speed/accuracy trade - the few-shot is there precisely because a 1B model needs
// brand -> product mapping.
//
// WHY REPEATS ARE NOT OPTIONAL. The model is nondeterministic: the same item with
// the same config returned different aisles across runs (2026-07-13). Every
// single-run accuracy number we have, including the 7/10 from the 2026-07-12
// model A/B, is therefore soft. Anything measured here goes through repeats plus a
// majority vote, which is what `score()` below implements.

const AISLES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Pantry', 'Baking', 'Condiments', 'Snacks', 'Beverages', 'Alcohol', 'Household',
  'Personal Care', 'Pet', 'Other']

// The ELEVEN-example few-shot the app shipped from 2026-07-11 to 2026-07-26. Kept
// verbatim as the reference point every variant is a subset of, and as what the
// measurements below were taken against. It is NO LONGER what ships - see SHIPPED.
const FULL = [
  ['SunChips', 'Snacks'],
  ['La Croix', 'Beverages'],
  ['Tide Pods', 'Household'],
  ['Chobani', 'Dairy & Eggs'],
  ['Advil', 'Personal Care'],
  ['Eggo waffles', 'Frozen'],
  ['vanilla extract', 'Baking'],
  ['sriracha', 'Condiments'],
  ['Cabernet Sauvignon', 'Alcohol'],
  // Pet food is neither for people (Meat/Pantry) nor cleaning - keep cat/dog food
  // etc. in the Pet aisle so it never lands in a human-food aisle.
  ['cat food', 'Pet'],
  ['dog food', 'Pet'],
]

const pick = (...names) => FULL.filter(([item]) => names.includes(item))

// Variants to measure, cheapest prompt last. Each keeps the examples carrying the
// most distinct signal: the JSON shape, one brand -> product mapping, and the
// pet rule (the one instruction the taxonomy cannot infer). v0 leans entirely on
// the system prompt plus the json_schema enum.
const VARIANTS = {
  v11: FULL,                                                                  // shipped until 2026-07-26
  v6: pick('SunChips', 'Tide Pods', 'Chobani', 'Eggo waffles', 'sriracha', 'cat food'),
  v4: pick('SunChips', 'Tide Pods', 'Chobani', 'cat food'),                   // SHIPPED from 2026-07-26
  v2: pick('SunChips', 'cat food'),
  v0: [],
}

// WHAT SHIPS, and why it is four examples rather than eleven.
//
// Two runs, both on the iOS Simulator, majority vote over 5 repeats:
//
//   26 items (retired set, 652 calls)   11: 871ms 50%   4: 526ms 54%   2: 427ms 58%
//   70 items (current set, 1050 calls)  11: 854ms 37%   4: 519ms 34%   2: 418ms 41%
//
// and the winner re-timed on the TCL, the phone the 5.9s/item baseline came from:
//   11 examples  349 tokens  6494ms/item  prefill 5237ms
//    4 examples  180 tokens  3985ms/item  prefill 2790ms   = 1.63x faster
//
// SPEED IS THE WHOLE CASE. Prefill falls in proportion to the prompt, which is the
// mechanism: 81% of the cost was re-reading the few-shot to emit 8 tokens of JSON.
// ACCURACY IS A WASH and the wider run says so plainly - 4 examples measured net +1
// item on 26 and net -2 on 70. At n=70 one standard error is 5.9 points, so nothing
// under ~20 points is resolvable. Do not read those deltas as a finding; the honest
// statement is that 11, 4 and 2 examples cannot be told apart on accuracy.
//
// FOUR rather than two, given they cannot be separated: four keeps one example of
// each thing the prompt must teach - brand->product (SunChips), a NON-food brand
// (Tide Pods), a dairy brand (Chobani) and the pet rule, the one instruction the
// taxonomy cannot infer. Zero examples DOES collapse (19%, net -8 on 26 items), so
// the few-shot earns its place; it just did not need eleven.
//
// THE NUMBER THAT MATTERS IS 37%. On the current set, 36 of 70 items are wrong in
// every variant. These are brands that survived a 346-entry keyword list, so they
// are genuinely obscure - but it means the model is guessing, not classifying, and
// no prompt fixes that. See TODO.md.
const SHIPPED = VARIANTS.v4

const SYSTEM = 'You assign a grocery item to the single best supermarket aisle. Items are often BRAND NAMES - map the brand to the product it sells (e.g. a chip brand -> Snacks). Reply with JSON only.'

// The completion history for one item. Lives here rather than in app/qvac.ts so
// test/aisleBench.test.js can assert the SHIPPED prompt is byte-identical to what
// it was before the harness refactor - a silent change to it would invalidate every
// number the harness produces and quietly alter what users get.
function history (text, fewshot) {
  const shots = []
  for (const [example, aisle] of fewshot) {
    shots.push({ role: 'user', content: `Item: "${example}"` })
    shots.push({ role: 'assistant', content: `{"aisle":"${aisle}"}` })
  }
  return [{ role: 'system', content: SYSTEM }, ...shots, { role: 'user', content: `Item: "${text}"` }]
}

// The items to grade on. Every one of these FALLS THROUGH the keyword matcher
// (test/aisleBench.test.js enforces it), because those are the only items the
// model is ever asked about - grading it on items the matcher already places
// would measure work the model never does. Two per aisle, deliberately excluding
// items whose "right" aisle is arguable (pasta sauce, canned tuna, syrup), so a
// wrong answer means the model was wrong and not that the label was.
// The items to grade on: 70 brands, 5 per aisle across 14 aisles.
//
// Every one FALLS THROUGH the keyword pass (test/aisleBench.test.js enforces it),
// because those are the only items the model is ever asked about. Grading it on
// items the keyword pass already handles would measure work it never does.
//
// REBUILT 2026-07-26 after the keyword list gained 346 brands. The previous
// 26-item set was retired because 25 of its 26 items are now answered instantly
// by keywords - which is the good outcome, and exactly why the fixture test that
// caught it exists. It also means these numbers cannot be compared item-for-item
// with the 26-item run; what carries over is the method, not the score.
//
// 70 rather than 26 because 26 could not separate an 8-point accuracy difference
// from chance, which left the v4-vs-v2 comparison unresolved.
//
// Brands whose right aisle is arguable are deliberately excluded (Tillamook is
// cheese and ice cream, Turkey Hill is milk and ice cream, Bolthouse is juice and
// carrots), so a wrong answer means the model was wrong and not that the label was.
const ITEMS = [
  ["Kite Hill", "Dairy & Eggs"],
  ["Good Culture", "Dairy & Eggs"],
  ["Stonyfield", "Dairy & Eggs"],
  ["Belgioioso", "Dairy & Eggs"],
  ["Crystal Farms", "Dairy & Eggs"],
  ["Boars Head", "Meat & Seafood"],
  ["Wellshire", "Meat & Seafood"],
  ["Niman Ranch", "Meat & Seafood"],
  ["Bell & Evans", "Meat & Seafood"],
  ["Aidells", "Meat & Seafood"],
  ["Franz", "Bakery"],
  ["Rudis", "Bakery"],
  ["Alpine Valley", "Bakery"],
  ["Aunt Millies", "Bakery"],
  ["Brownberry", "Bakery"],
  ["Michelinas", "Frozen"],
  ["Banquet", "Frozen"],
  ["Devour", "Frozen"],
  ["Evol", "Frozen"],
  ["Alexia", "Frozen"],
  ["Waterloo", "Beverages"],
  ["Bubly", "Beverages"],
  ["Canada Dry", "Beverages"],
  ["Schweppes", "Beverages"],
  ["Jarritos", "Beverages"],
  ["Pabst", "Alcohol"],
  ["Natural Light", "Alcohol"],
  ["Rolling Rock", "Alcohol"],
  ["New Belgium", "Alcohol"],
  ["Shiner", "Alcohol"],
  ["Funyuns", "Snacks"],
  ["Bugles", "Snacks"],
  ["Pop Secret", "Snacks"],
  ["Orville Redenbacher", "Snacks"],
  ["Late July", "Snacks"],
  ["Tasty Bite", "Pantry"],
  ["Seeds of Change", "Pantry"],
  ["Thai Kitchen", "Pantry"],
  ["San-J", "Pantry"],
  ["Eden Foods", "Pantry"],
  ["Swans Down", "Baking"],
  ["White Lily", "Baking"],
  ["Hodgson Mill", "Baking"],
  ["Arrowhead Mills", "Baking"],
  ["Guittard", "Baking"],
  ["Lea & Perrins", "Condiments"],
  ["Maille", "Condiments"],
  ["Cattlemans", "Condiments"],
  ["Texas Pete", "Condiments"],
  ["El Yucateco", "Condiments"],
  ["Zep", "Household"],
  ["Goo Gone", "Household"],
  ["Bon Ami", "Household"],
  ["Soft Scrub", "Household"],
  ["Formula 409", "Household"],
  ["Curel", "Personal Care"],
  ["St Ives", "Personal Care"],
  ["Ponds", "Personal Care"],
  ["Noxzema", "Personal Care"],
  ["Biore", "Personal Care"],
  ["Alpo", "Pet"],
  ["Nutrish", "Pet"],
  ["Merrick", "Pet"],
  ["Instinct", "Pet"],
  ["Orijen", "Pet"],
  ["NatureSweet", "Produce"],
  ["Ocean Mist", "Produce"],
  ["Grimmway", "Produce"],
  ["Melissas", "Produce"],
  ["Manns", "Produce"],
]

// The answer a run of repeats settles on: most frequent, ties broken by first
// seen so the result is deterministic. null (an unusable answer, which the app
// turns into 'Other') counts as its own vote - it is a real outcome, not a gap.
function majorityVote (answers) {
  const counts = new Map()
  for (const a of answers) counts.set(a, (counts.get(a) || 0) + 1)
  let best = null; let bestN = -1
  for (const a of answers) {
    const n = counts.get(a)
    if (n > bestN) { best = a; bestN = n }
  }
  return { answer: best, votes: bestN, total: answers.length }
}

// Grade one variant. `runs` is [{ item, expected, answers: [...] }].
//   accuracy    - majority vote correct, the headline number
//   anyCorrect   - at least one repeat correct: the ceiling a better sampler could reach
//   consistency - mean share of repeats agreeing with the item's own majority, so a
//                 low number means the variant is unstable, not just wrong
//   nullRate    - share of ALL calls that came back unusable (-> 'Other' in the app)
function score (runs) {
  let correct = 0; let any = 0; let consist = 0; let calls = 0; let nulls = 0
  const wrong = []
  for (const r of runs) {
    const { answer, votes, total } = majorityVote(r.answers)
    if (answer === r.expected) correct++; else wrong.push({ item: r.item, expected: r.expected, got: answer })
    if (r.answers.includes(r.expected)) any++
    consist += total ? votes / total : 0
    calls += r.answers.length
    nulls += r.answers.filter((a) => a == null).length
  }
  const n = runs.length || 1
  return {
    items: runs.length,
    accuracy: correct / n,
    anyCorrect: any / n,
    consistency: consist / n,
    nullRate: calls ? nulls / calls : 0,
    wrong,
  }
}

module.exports = { AISLES, SYSTEM, FULL, SHIPPED, VARIANTS, ITEMS, history, majorityVote, score }
