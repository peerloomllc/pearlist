// Aisle-classifier prompt harness. Dev-only: it never runs unless a bench config
// file is placed in the app's Documents dir, which nothing in the app ever does.
//
// WHAT IT ANSWERS. The classifier is prefill-bound (81% of 5.9s/item is the ~350
// token few-shot, measured 2026-07-13), so the only lever left is a shorter prompt,
// which trades speed against accuracy. This runs the REAL production call path
// (app/qvac.ts) over a labelled set of items the keyword matcher cannot place, once
// per prompt variant, REPEATS times each, and prints a graded comparison.
//
// WHY REPEATS. The model is nondeterministic - the same item, same config, gave
// different aisles across runs - so a single-run accuracy comparison of this model
// is worthless. Every number here is a majority vote over repeats, and the harness
// also reports how often the repeats agreed with each other.
//
// Output goes to the console as [BENCH] <json> lines, one per call plus a summary
// per variant, so a driver script can read it out of `xcrun simctl ... log stream`
// (iOS) or `adb logcat` (Android) without a UI. See scripts/ios-aisle-bench.sh.

import { classifyAisleVariant, setAiConsent, getAiStatus, loadModelNow } from './qvac'

const { VARIANTS, ITEMS, history, score } = require('../src/aisleFewshot.js')

export interface BenchConfig {
  variants?: string[]   // names from VARIANTS; default all of them, shipped prompt first
  repeats?: number      // runs per item per variant; default 5
  items?: number        // cap the labelled set (first N) for a quick smoke run
}

const log = (obj: any) => console.log('[BENCH] ' + JSON.stringify(obj))

// Rough token estimate for the prompt, so a variant's cost is visible even when
// the SDK reports no promptTokens. Deliberately crude (chars/4): the SDK's own
// count is what gets reported when present, and this is only a fallback.
const estTokens = (text: string) => Math.round(text.length / 4)
const promptChars = (fewshot: any) => history('placeholder', fewshot).map((m: any) => m.content).join('\n').length

export async function runAisleBench (cfg: BenchConfig = {}): Promise<void> {
  const names: string[] = cfg.variants?.length ? cfg.variants : Object.keys(VARIANTS)
  const repeats = Math.max(1, cfg.repeats ?? 5)
  const items: Array<[string, string]> = cfg.items ? ITEMS.slice(0, cfg.items) : ITEMS

  log({ type: 'start', variants: names, repeats, items: items.length, calls: names.length * items.length * repeats })

  // The bench must not sit waiting on a consent tap, so opt in here. It also has to
  // be in memory before the first timing, or that call absorbs the model load.
  await setAiConsent(true)
  await loadModelNow()
  const status = await getAiStatus()
  log({ type: 'model', state: status.state, model: status.model.name, error: status.error })
  if (status.state !== 'ready') { log({ type: 'abort', why: 'model not ready', state: status.state, error: status.error }); return }

  const summaries: any[] = []
  for (const variant of names) {
    if (!VARIANTS[variant]) { log({ type: 'skip', variant, why: 'unknown variant' }); continue }
    const chars = promptChars(VARIANTS[variant])
    log({ type: 'variant-start', variant, shots: VARIANTS[variant].length, promptChars: chars, promptTokensEst: estTokens(' '.repeat(chars)) })

    const runs: Array<{ item: string, expected: string, answers: Array<string | null> }> = []
    let msTotal = 0; let ttftTotal = 0; let ttftSeen = 0; let promptTokens = 0; let promptSeen = 0

    for (const [item, expected] of items) {
      const answers: Array<string | null> = []
      for (let r = 0; r < repeats; r++) {
        const { aisle, meta, ms } = await classifyAisleVariant(item, variant)
        answers.push(aisle)
        msTotal += ms
        // The SDK reports its own numbers under `stats` (verified on 0.14.1: the
        // completion result exposes toolCalls / stats / raw / cacheableAssistantContent).
        // Names are still read defensively across both levels, since a version bump
        // moving them would otherwise silently zero the latency column.
        const s = meta?.stats ?? {}
        const ttft = s.timeToFirstToken ?? s.ttft ?? meta?.timeToFirstToken
        if (typeof ttft === 'number') { ttftTotal += ttft; ttftSeen++ }
        const pt = s.promptTokens ?? s.inputTokens ?? meta?.promptTokens
        if (typeof pt === 'number') { promptTokens += pt; promptSeen++ }
        log({ type: 'call', variant, item, expected, got: aisle, ms, ttft, promptTokens: pt, run: r + 1 })
        // Dump the whole stats object once per variant, so a run always records what
        // the SDK actually offered rather than only the fields we thought to read.
        if (runs.length === 0 && r === 0) log({ type: 'meta-keys', variant, keys: Object.keys(meta || {}), stats: s })
      }
      runs.push({ item, expected, answers })
    }

    const graded = score(runs)
    const calls = items.length * repeats
    const summary = {
      type: 'variant', variant,
      shots: VARIANTS[variant].length,
      promptChars: chars,
      accuracy: +graded.accuracy.toFixed(3),
      anyCorrect: +graded.anyCorrect.toFixed(3),
      consistency: +graded.consistency.toFixed(3),
      nullRate: +graded.nullRate.toFixed(3),
      msPerItem: Math.round(msTotal / calls),
      ttftPerItem: ttftSeen ? Math.round(ttftTotal / ttftSeen) : null,
      promptTokens: promptSeen ? Math.round(promptTokens / promptSeen) : null,
      wrong: graded.wrong,
    }
    summaries.push(summary)
    log(summary)
  }

  log({ type: 'summary', rows: summaries.map((s) => ({ variant: s.variant, shots: s.shots, accuracy: s.accuracy, consistency: s.consistency, msPerItem: s.msPerItem, ttftPerItem: s.ttftPerItem, promptTokens: s.promptTokens })) })
  log({ type: 'done' })
}
