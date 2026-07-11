// QVAC on-device AI, RN-shell side (hybrid categorization + consent/status).
// PearList sorts grocery items with the fast offline keyword classifier FIRST;
// only items it can't place ('Other') fall back to this LLM. QVAC runs as its
// own Bare worker via @qvac/sdk.
//
// CONSENT: the model is a ~0.8GB download, so nothing downloads until the user
// opts in (setConsent). `getAiStatus` powers the Settings row and the in-list
// prompt. Download progress is pushed through the sink the shell wires up.
// See proposals/2026-07-11-qvac-integration-notes.md.

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  completion,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from '@qvac/sdk'

const CONSENT_KEY = 'qvac:consent'
const READY_KEY = 'qvac:modelReady' // '1' once the model has finished downloading
const MODEL = { name: 'Llama 3.2 1B', sizeMB: 808, asset: LLAMA_3_2_1B_INST_Q4_0 }

// Kept in sync with src/aisles.js AISLES.
const AISLES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Pantry', 'Snacks', 'Beverages', 'Household', 'Personal Care', 'Other']
const AISLE_SCHEMA = {
  type: 'object',
  properties: { aisle: { type: 'string', enum: AISLES } },
  required: ['aisle'],
  additionalProperties: false,
}

type State = 'none' | 'downloading' | 'ready' | 'error'

let _consent = false
let _state: State = 'none'
let _pct = 0
let _error: string | null = null
let _modelId: string | null = null
let _readyPromise: Promise<string> | null = null
let _inited = false

// The shell sets this to push progress ticks to the WebView UI.
let _progressSink: ((s: AiStatus) => void) | null = null
export function setProgressSink (fn: (s: AiStatus) => void) { _progressSink = fn }

export interface AiStatus { consent: boolean, state: State, pct: number, error: string | null, model: { name: string, sizeMB: number } }
function status (): AiStatus { return { consent: _consent, state: _state, pct: _pct, error: _error, model: { name: MODEL.name, sizeMB: MODEL.sizeMB } } }
function emit () { try { _progressSink?.(status()) } catch {} }

async function init () {
  if (_inited) return
  _inited = true
  try {
    _consent = (await AsyncStorage.getItem(CONSENT_KEY)) === '1'
    if ((await AsyncStorage.getItem(READY_KEY)) === '1') _state = 'ready'
  } catch {}
}

// Download (if needed) + load, shared across concurrent callers.
function ensureReady (): Promise<string> {
  if (_modelId) return Promise.resolve(_modelId)
  if (!_readyPromise) {
    _readyPromise = (async () => {
      _state = 'downloading'; _error = null; _pct = 0; emit()
      await downloadAsset({
        assetSrc: MODEL.asset,
        onProgress: (p: any) => { _pct = Math.round(p?.percentage ?? 0); emit() },
      })
      await AsyncStorage.setItem(READY_KEY, '1').catch(() => {})
      const id = await loadModel({
        modelSrc: MODEL.asset,
        modelType: 'llm',
        modelConfig: { device: 'cpu', ctx_size: 1024, verbosity: VERBOSITY.ERROR },
      })
      _modelId = id; _state = 'ready'; _pct = 100; emit()
      return id
    })().catch((e) => { _readyPromise = null; _state = 'error'; _error = e?.message ?? String(e); emit(); throw e })
  }
  return _readyPromise
}

export async function getAiStatus (): Promise<AiStatus> { await init(); return status() }

// Opt in / out. Turning on kicks off the download in the BACKGROUND (progress
// via the sink) and returns immediately - never blocks the caller on ~0.8GB.
export async function setAiConsent (enabled: boolean): Promise<AiStatus> {
  await init()
  _consent = enabled
  await AsyncStorage.setItem(CONSENT_KEY, enabled ? '1' : '0').catch(() => {})
  if (enabled && _state !== 'ready') { ensureReady().catch(() => {}) }
  return status()
}

// Free the ~0.8GB: unload + clear the model's on-disk storage.
export async function removeAiModel (): Promise<AiStatus> {
  await init()
  try {
    const id = _modelId || (_state === 'ready' ? await ensureReady().catch(() => null) : null)
    if (id) await unloadModel({ modelId: id, clearStorage: true })
  } catch {}
  _modelId = null; _readyPromise = null; _state = 'none'; _pct = 0; _error = null
  await AsyncStorage.setItem(READY_KEY, '0').catch(() => {})
  emit()
  return status()
}

// Classify one item -> a KNOWN aisle or null. No consent = no download, no work.
export async function classifyAisleAI (item: string): Promise<string | null> {
  await init()
  if (!_consent) return null
  const text = String(item || '').trim()
  if (!text) return null
  try {
    const modelId = await ensureReady()
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
    return null
  }
}
