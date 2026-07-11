// QVAC on-device smoke test (spike, 2026-07-11) - the supported-path equivalent
// of the earlier worklet probe. Runs QVAC via @qvac/sdk (its own Bare worker,
// managed by the SDK over bare-rpc), downloads + loads a small LLM, and asks it
// to classify a few grocery items into aisles. Logs every stage to
// Documents/qvac-smoke.log (pullable from a debug build via `adb run-as`) and to
// console (logcat), so we can see exactly how far it reaches even if a later
// stage fails. Guarded behind QVAC_SMOKE in index.tsx; fully try/catch'd so it
// never breaks app boot. Remove once categorization is wired for real.
// See proposals/2026-07-11-qvac-integration-notes.md.

import * as FileSystem from 'expo-file-system/legacy'
import {
  completion,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from '@qvac/sdk'

const AISLES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Pantry', 'Snacks', 'Beverages', 'Household', 'Personal Care', 'Other']
const SAMPLES = ['cilantro', 'whole milk', 'chicken thighs', 'toilet paper', 'ice cream',
  'bananas', 'cheddar cheese', 'dish soap', 'sourdough bread', 'orange juice']

// Grammar-constrained decoding: force the reply to be JSON whose `aisle` is one
// of the exact aisle strings. llama.cpp compiles the enum into a decode-time
// grammar, so the model physically cannot emit an off-list answer.
const AISLE_SCHEMA = {
  type: 'object',
  properties: { aisle: { type: 'string', enum: AISLES } },
  required: ['aisle'],
  additionalProperties: false,
}

const LOG = FileSystem.documentDirectory + 'qvac-smoke.log'

async function log (line: string) {
  const s = `[qvac-smoke] ${line}`
  console.warn(s)
  try {
    const prev = await FileSystem.readAsStringAsync(LOG).catch(() => '')
    await FileSystem.writeAsStringAsync(LOG, prev + s + '\n')
  } catch {}
}

async function classify (modelId: string, item: string): Promise<string> {
  const run = completion({
    modelId,
    history: [
      { role: 'system', content: 'You assign a grocery item to the single best supermarket aisle. Reply with JSON only.' },
      { role: 'user', content: `Item: "${item}"` },
    ],
    stream: false,
    responseFormat: { type: 'json_schema', json_schema: { name: 'aisle', schema: AISLE_SCHEMA, strict: true } },
  })
  const final = await run.final
  const txt = (final.contentText || '').trim()
  try { return String(JSON.parse(txt).aisle) } catch { return txt }
}

export async function runQvacSmoke (): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(LOG, '').catch(() => {})
    await log('start (device=cpu, model=LLAMA_3_2_1B_INST_Q4_0, grammar-constrained json_schema enum)')

    let lastPct = -1
    await log('downloading model...')
    await downloadAsset({
      assetSrc: LLAMA_3_2_1B_INST_Q4_0,
      onProgress: (p: any) => {
        const pct = Math.round(p?.percentage ?? 0)
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; void log(`download ${pct}%`) }
      },
    })
    await log('download complete')

    await log('loading model...')
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: 'llm',
      modelConfig: { device: 'cpu', ctx_size: 1024, verbosity: VERBOSITY.ERROR },
    })
    await log('model loaded: ' + modelId)

    for (const item of SAMPLES) {
      const t0 = Date.now()
      const answer = await classify(modelId, item)
      await log(`classify "${item}" -> "${answer}" (${Date.now() - t0}ms)`)
    }

    await unloadModel({ modelId, clearStorage: false }).catch(() => {})
    await log('DONE OK')
  } catch (e: any) {
    await log('ERROR ' + (e?.message ?? String(e)))
  }
}
