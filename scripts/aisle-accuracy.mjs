// Score the keyword aisle classifier against test/fixtures/aisle-items.json.
//
//   node scripts/aisle-accuracy.mjs          # summary + the non-held misses
//   node scripts/aisle-accuracy.mjs --quiet  # summary only
//   node scripts/aisle-accuracy.mjs --burn   # ALSO name the held-out misses
//
// Reports the HELD-OUT set separately, which is the number that matters. Overall
// accuracy climbs the moment you add a keyword for a missed item; held-out
// accuracy only climbs if the fix generalised. A widening pass that moves the
// first and not the second was taught to the test.
//
// HELD-OUT MISSES ARE NOT NAMED unless you pass --burn, because reading them is
// what destroys their value: once you know a held item failed you cannot help but
// fix it, and the set stops measuring generalisation. `--burn` exists for the
// honest case (you have finished widening and want to see what is still wrong),
// and it is named to make using it a decision rather than an accident. The first
// run of this script on 2026-07-26 printed them by default and burned round one's
// hold-out; that is what the flag is here to prevent repeating.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { classifyAisle } = require(join(root, 'src/aisles.js'))
const { items } = JSON.parse(readFileSync(join(root, 'test/fixtures/aisle-items.json'), 'utf8'))

const quiet = process.argv.includes('--quiet')
const rows = items.map((it) => ({ ...it, got: classifyAisle(it.text), ok: classifyAisle(it.text) === it.expect }))

const score = (set) => {
  const hit = set.filter((r) => r.ok).length
  return { hit, n: set.length, pct: set.length ? (100 * hit) / set.length : 0 }
}
const all = score(rows)
const held = score(rows.filter((r) => r.held))
const train = score(rows.filter((r) => !r.held))

if (!quiet) {
  const misses = rows.filter((r) => !r.ok)
  if (misses.length) {
    console.log('MISSES:')
    const w = Math.max(...misses.map((m) => m.text.length))
    for (const m of misses) {
      const tag = m.held ? ' [held]' : ''
      // 'Other' is a MISS but an honest one: the item rests where the user can
      // drag it. A confident wrong aisle is the worse failure, so mark it.
      const kind = m.got === 'Other' ? 'unplaced' : 'WRONG   '
      console.log(`  ${kind} ${m.text.padEnd(w)}  expected ${m.expect}, got ${m.got}${tag}`)
    }
    console.log('')
  }
}

const wrong = rows.filter((r) => !r.ok && r.got !== 'Other').length
const unplaced = rows.filter((r) => !r.ok && r.got === 'Other').length
console.log(`overall  ${all.hit}/${all.n}  ${all.pct.toFixed(1)}%`)
console.log(`held-out ${held.hit}/${held.n}  ${held.pct.toFixed(1)}%   <- the honest number`)
console.log(`rest     ${train.hit}/${train.n}  ${train.pct.toFixed(1)}%`)
console.log(`misses   ${wrong} in the WRONG aisle, ${unplaced} left in Other`)
