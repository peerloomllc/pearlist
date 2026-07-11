// QVAC on-device AI, RN-shell side (hybrid categorization, 2026-07-11).
// PearList categorizes grocery items with the fast offline keyword classifier
// (src/aisles.js) FIRST; only items it can't place (category 'Other') fall back
// to this LLM. Runs QVAC as its own Bare worker via @qvac/sdk. The model is
// downloaded (~0.8GB, once) and loaded LAZILY on the first fallback, so a list
// the keyword classifier fully handles never triggers a download.
//
// classifyAisleAI returns a KNOWN aisle or null (never throws). Decoding is
// grammar-constrained to the aisle enum, so the model cannot answer off-list.
// See proposals/2026-07-11-qvac-integration-notes.md.

import {
  completion,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  VERBOSITY,
} from '@qvac/sdk'

// Kept in sync with src/aisles.js AISLES (RN can't import the CJS worklet module
// cleanly, and the suite already duplicates small display constants).
const AISLES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Pantry', 'Snacks', 'Beverages', 'Household', 'Personal Care', 'Other']

const AISLE_SCHEMA = {
  type: 'object',
  properties: { aisle: { type: 'string', enum: AISLES } },
  required: ['aisle'],
  additionalProperties: false,
}

// Load the model once. On failure, clear the promise so a later call can retry
// (e.g. a transient download error) rather than wedging forever.
let _modelIdPromise: Promise<string> | null = null
function getModel (): Promise<string> {
  if (!_modelIdPromise) {
    _modelIdPromise = (async () => {
      await downloadAsset({ assetSrc: LLAMA_3_2_1B_INST_Q4_0 })
      return loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: 'llm',
        modelConfig: { device: 'cpu', ctx_size: 1024, verbosity: VERBOSITY.ERROR },
      })
    })().catch((e) => { _modelIdPromise = null; throw e })
  }
  return _modelIdPromise
}

export async function classifyAisleAI (item: string): Promise<string | null> {
  const text = String(item || '').trim()
  if (!text) return null
  try {
    const modelId = await getModel()
    const run = completion({
      modelId,
      history: [
        { role: 'system', content: 'You assign a grocery item to the single best supermarket aisle. Reply with JSON only.' },
        { role: 'user', content: `Item: "${text}"` },
      ],
      stream: false,
      responseFormat: { type: 'json_schema', json_schema: { name: 'aisle', schema: AISLE_SCHEMA, strict: true } },
    })
    const final = await run.final
    const raw = (final.contentText || '').trim()
    let aisle: string
    try { aisle = String(JSON.parse(raw).aisle) } catch { aisle = raw }
    return AISLES.includes(aisle) ? aisle : null
  } catch {
    return null // model unavailable / OOM / parse fail -> leave the item as-is
  }
}
