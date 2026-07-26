// Turn harness output into a readable comparison table.
//
// Aggregates from the PER-CALL lines, not the harness's own end-of-variant
// summaries, because a variant is rarely finished by one process: the app exits
// silently mid-run (2026-07-26, clean exit 0 about 50 calls in) and the driver
// relaunches it with whatever is missing. Every launch appends to the same log, so
// rebuilding the grades here is what makes a run whole - and it also means a run
// that is still in flight can be read at any point.
//
// Usage: node scripts/aisle-bench-report.mjs [metadata/bench/ios-aisle-bench.jsonl]

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { VARIANTS, ITEMS, history, score } = require('../src/aisleFewshot.js')

const file = process.argv[2] || 'metadata/bench/ios-aisle-bench.jsonl'
let events
try {
  events = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
} catch {
  console.error(`no harness output at ${file} - run scripts/aisle-bench.sh first`)
  process.exit(1)
}

const calls = events.filter((e) => e.type === 'call')
if (!calls.length) {
  const aborted = events.find((e) => e.type === 'abort')
  console.log(aborted
    ? `ABORTED: ${aborted.why} (state=${aborted.state}${aborted.error ? ', ' + aborted.error : ''})`
    : 'no calls recorded in this run')
  process.exit(0)
}

// variant -> item -> { expected, answers[] }, plus the timing samples per variant.
const byVariant = new Map()
const msBy = new Map()
const ttftBy = new Map()
const tokBy = new Map()
for (const c of calls) {
  if (!byVariant.has(c.variant)) { byVariant.set(c.variant, new Map()); msBy.set(c.variant, []); ttftBy.set(c.variant, []); tokBy.set(c.variant, []) }
  const items = byVariant.get(c.variant)
  if (!items.has(c.item)) items.set(c.item, { expected: c.expected, answers: [] })
  items.get(c.item).answers.push(c.got ?? null)
  if (typeof c.ms === 'number') msBy.get(c.variant).push(c.ms)
  if (typeof c.ttft === 'number') ttftBy.get(c.variant).push(c.ttft)
  if (typeof c.promptTokens === 'number') tokBy.get(c.variant).push(c.promptTokens)
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
const promptChars = (v) => history('placeholder', VARIANTS[v] || []).map((m) => m.content).join('\n').length
const launches = events.filter((e) => e.type === 'start').length

const rows = []
for (const [variant, items] of byVariant) {
  const runs = [...items].map(([item, r]) => ({ item, expected: r.expected, answers: r.answers }))
  const graded = score(runs)
  const repeats = runs.map((r) => r.answers.length)
  rows.push({
    variant,
    shots: (VARIANTS[variant] || []).length,
    promptChars: promptChars(variant),
    items: runs.length,
    minRepeats: Math.min(...repeats),
    maxRepeats: Math.max(...repeats),
    accuracy: graded.accuracy,
    anyCorrect: graded.anyCorrect,
    consistency: graded.consistency,
    nullRate: graded.nullRate,
    msPerCall: mean(msBy.get(variant)),
    ttft: mean(ttftBy.get(variant)),
    promptTokens: mean(tokBy.get(variant)),
    wrong: graded.wrong,
  })
}
rows.sort((a, b) => b.shots - a.shots)

console.log(`${calls.length} calls across ${launches} launch(es) of the app`)
const partial = rows.filter((r) => r.items < ITEMS.length)
if (partial.length) {
  console.log(`INCOMPLETE - these variants have not covered all ${ITEMS.length} labelled items:`)
  for (const r of partial) console.log(`  ${r.variant}: ${r.items}/${ITEMS.length} items, ${r.minRepeats}-${r.maxRepeats} repeats each`)
  console.log('  The numbers below are real but provisional. Re-run to fill the gaps.')
}

const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%'
const base = rows.find((r) => r.variant === 'v11')

console.log('')
console.log('variant  shots  chars  tokens  ms/call   ttft  accuracy  ceiling  agree  unusable   vs shipped')
for (const r of rows) {
  const speed = base?.msPerCall && r.msPerCall ? (base.msPerCall / r.msPerCall).toFixed(2) + 'x' : '-'
  const accDelta = base ? Math.round((r.accuracy - base.accuracy) * 100) : 0
  const delta = r === base ? 'baseline' : `${speed}, ${accDelta >= 0 ? '+' : ''}${accDelta}pt`
  console.log([
    r.variant.padEnd(9),
    String(r.shots).padStart(3),
    String(r.promptChars).padStart(7),
    String(r.promptTokens ?? '-').padStart(7),
    String(r.msPerCall ?? '-').padStart(8),
    String(r.ttft ?? '-').padStart(7),
    pct(r.accuracy).padStart(9),
    pct(r.anyCorrect).padStart(8),
    pct(r.consistency).padStart(7),
    pct(r.nullRate).padStart(9),
    '   ' + delta,
  ].join(''))
}

console.log('')
console.log('accuracy = majority vote over repeats.  ceiling = right at least once.')
console.log("agree = share of repeats matching the item's own majority; low means unstable, not just wrong.")
console.log('unusable = calls returning no valid aisle, which the app files as Other.')

for (const r of rows) {
  if (!r.wrong.length) { console.log(`\n${r.variant}: nothing wrong`); continue }
  console.log(`\n${r.variant} got ${r.wrong.length}/${r.items} wrong:`)
  for (const w of r.wrong) console.log(`  ${w.item.padEnd(20)} expected ${String(w.expected).padEnd(15)} got ${w.got}`)
}
