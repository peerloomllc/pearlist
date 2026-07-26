// Turn a harness .jsonl into a readable comparison table.
//
// Reads the [BENCH] lines from a run (see scripts/ios-aisle-bench.sh) and prints
// one row per prompt variant: majority-vote accuracy, how often the repeats agreed,
// prompt size and measured latency. Also prints which items each variant got wrong,
// because a variant that only fails the pet rule is a different proposition from one
// that fails across the board.
//
// Usage: node scripts/aisle-bench-report.mjs [metadata/bench/ios-aisle-bench.jsonl]

import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'metadata/bench/ios-aisle-bench.jsonl'
let lines
try {
  lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
} catch {
  console.error(`no harness output at ${file} - run scripts/aisle-bench.sh first`)
  process.exit(1)
}

const rows = []
const events = []
for (const l of lines) {
  try { events.push(JSON.parse(l)) } catch {}
}
const start = events.find((e) => e.type === 'start')
const model = events.find((e) => e.type === 'model')
for (const e of events) if (e.type === 'variant') rows.push(e)

if (start) console.log(`run: ${start.items} items x ${start.repeats} repeats x ${start.variants.length} variants = ${start.calls} calls`)
if (model) console.log(`model: ${model.model} (${model.state})`)
const aborted = events.find((e) => e.type === 'abort')
if (aborted) console.log(`ABORTED: ${aborted.why} (state=${aborted.state}${aborted.error ? ', ' + aborted.error : ''})`)
if (!rows.length) { console.log('no completed variants in this run'); process.exit(0) }

const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%'
const base = rows.find((r) => r.variant === 'v11') || rows[0]

console.log('')
console.log('variant  shots  chars  tokens   ms/item  ttft   accuracy  ceiling  agree  unusable  vs shipped')
for (const r of rows) {
  const speed = base && base.msPerItem && r.msPerItem ? (base.msPerItem / r.msPerItem).toFixed(2) + 'x' : '-'
  const acc = base ? ((r.accuracy - base.accuracy) * 100).toFixed(0) : '0'
  const delta = r === base ? 'baseline' : `${speed} speed, ${acc >= 0 ? '+' : ''}${acc}pt accuracy`
  console.log([
    r.variant.padEnd(7),
    String(r.shots).padStart(5),
    String(r.promptChars).padStart(6),
    String(r.promptTokens ?? '-').padStart(6),
    String(r.msPerItem).padStart(8),
    String(r.ttftPerItem ?? '-').padStart(6),
    pct(r.accuracy).padStart(9),
    pct(r.anyCorrect).padStart(8),
    pct(r.consistency).padStart(6),
    pct(r.nullRate).padStart(9),
    '  ' + delta,
  ].join(''))
}

console.log('')
console.log('accuracy = majority vote over repeats (the headline).  ceiling = right at least once.')
console.log('agree = share of repeats matching the item\'s own majority; low means unstable, not just wrong.')
console.log('unusable = calls that returned no valid aisle, which the app files as Other.')

for (const r of rows) {
  if (!r.wrong?.length) { console.log(`\n${r.variant}: nothing wrong`); continue }
  console.log(`\n${r.variant} got ${r.wrong.length} wrong:`)
  for (const w of r.wrong) console.log(`  ${w.item.padEnd(20)} expected ${String(w.expected).padEnd(15)} got ${w.got}`)
}
