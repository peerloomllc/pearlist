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
// Measured 2026-07-26 on the iOS Simulator: 652 calls, 26 labelled items the
// keyword pass cannot place, 5 repeats each, graded on the majority vote.
//
//   examples  tokens  ms/call  prefill   accuracy   paired vs 11 examples
//   11 (old)     349      871    714ms        50%   baseline
//    6           229      623    466ms        50%   net  0 items
//    4           180      526    373ms        54%   net +1 item     <- this one
//    2           130      427    272ms        58%   net +2 items
//    0            84      412    176ms        19%   net -8 items    <- collapse
//
// Prefill fell almost exactly in proportion to the prompt, which is the whole
// mechanism: 81% of the cost was re-reading the few-shot to emit 8 tokens of JSON.
//
// FOUR, not two, even though two measured slightly faster and no worse: with 26
// items a +2 difference is well inside noise, so the accuracy column cannot
// separate them, and four keeps one example of each thing the prompt has to
// teach - a brand mapping to a product (SunChips), a non-food brand (Tide Pods),
// a dairy brand (Chobani) and the pet rule, which is the one instruction the
// taxonomy cannot infer. Zero examples is a genuine collapse, so the few-shot is
// doing real work; it just does not need eleven.
//
// The number the model gets right is 50-58% either way. That is the more
// important finding and it is NOT a prompt problem: eight items (Sargento,
// Modelo, Barefoot, Progresso, Stouffers, Applegate, Kikkoman, RXBAR) are wrong
// in EVERY variant. A 1B model does not know those brands. See TODO.md.
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
const ITEMS = [
  ['Sargento', 'Dairy & Eggs'],
  ['Kerrygold', 'Dairy & Eggs'],
  ['Modelo', 'Alcohol'],
  ['Barefoot', 'Alcohol'],
  ['Folgers', 'Beverages'],
  ['Spindrift', 'Beverages'],
  ['Neutrogena', 'Personal Care'],
  ['Claritin', 'Personal Care'],
  ['Mrs Meyers', 'Household'],
  ['Seventh Generation', 'Household'],
  ['Barilla', 'Pantry'],
  ['Progresso', 'Pantry'],
  ['Krusteaz', 'Baking'],
  ['Duncan Hines', 'Baking'],
  ['Stouffers', 'Frozen'],
  ['Ore-Ida', 'Frozen'],
  ["King's Hawaiian", 'Bakery'],
  ['Sara Lee', 'Bakery'],
  ['Butterball', 'Meat & Seafood'],
  ['Applegate', 'Meat & Seafood'],
  ['Cholula', 'Condiments'],
  ['Kikkoman', 'Condiments'],
  ['RXBAR', 'Snacks'],
  ['Clif', 'Snacks'],
  ['Fresh Step', 'Pet'],
  ['Kong', 'Pet'],
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
