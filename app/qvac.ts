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
import * as FileSystem from 'expo-file-system/legacy'
import {
  completion,
  deleteCache,
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
  'Pantry', 'Baking', 'Condiments', 'Snacks', 'Beverages', 'Alcohol', 'Household',
  'Personal Care', 'Pet', 'Other']
const AISLE_SCHEMA = {
  type: 'object',
  properties: { aisle: { type: 'string', enum: AISLES } },
  required: ['aisle'],
  additionalProperties: false,
}

// 'idle' = downloaded to disk but NOT loaded into memory (the resting state after
// an app restart). Loading it into RAM is deferred until the user asks (a prompt
// for the passive sorter, or tapping recipe Generate), so we never silently eat
// memory on launch. 'ready' = loaded in memory this session.
type State = 'none' | 'downloading' | 'loading' | 'ready' | 'idle' | 'error'

let _consent = false
let _state: State = 'none'
let _pct = 0
let _downloaded = 0 // bytes, for a smooth MB readout even when % is coarse
let _total = 0
let _error: string | null = null
let _modelId: string | null = null
let _readyPromise: Promise<string> | null = null
let _inited = false

// The shell sets this to push progress ticks to the WebView UI.
let _progressSink: ((s: AiStatus) => void) | null = null
export function setProgressSink (fn: (s: AiStatus) => void) { _progressSink = fn }

export interface AiStatus { consent: boolean, state: State, pct: number, downloadedMB: number, totalMB: number, error: string | null, model: { name: string, sizeMB: number } }
function status (): AiStatus {
  return {
    consent: _consent, state: _state, pct: _pct,
    downloadedMB: Math.round(_downloaded / 1e6), totalMB: Math.round((_total || MODEL.sizeMB * 1e6) / 1e6),
    error: _error, model: { name: MODEL.name, sizeMB: MODEL.sizeMB },
  }
}
function emit () { try { _progressSink?.(status()) } catch {} }

async function init () {
  if (_inited) return
  _inited = true
  try {
    _consent = (await AsyncStorage.getItem(CONSENT_KEY)) === '1'
    // Downloaded, but a fresh process hasn't loaded it into memory yet -> idle.
    if ((await AsyncStorage.getItem(READY_KEY)) === '1') _state = 'idle'
  } catch {}
}

// Download (if needed) + load, shared across concurrent callers.
function ensureReady (): Promise<string> {
  if (_modelId) return Promise.resolve(_modelId)
  if (!_readyPromise) {
    _readyPromise = (async () => {
      _error = null; _downloaded = 0; _total = 0
      // If the ~0.8GB is already on disk (READY_KEY persisted from a prior run,
      // e.g. after an app restart/update that only dropped it from MEMORY), skip
      // the download banner and go straight to "loading into memory". downloadAsset
      // is still called - a no-op when present - and only escalates back to the
      // download UI if a genuine, incomplete download actually happens (file gone).
      const onDisk = (await AsyncStorage.getItem(READY_KEY)) === '1'
      _state = onDisk ? 'loading' : 'downloading'; _pct = onDisk ? 100 : 0; emit()
      await downloadAsset({
        assetSrc: MODEL.asset,
        onProgress: (p: any) => {
          const pct = Math.round(p?.percentage ?? 0)
          if (pct < 100) {
            _state = 'downloading'; _pct = pct
            if (typeof p?.downloaded === 'number') _downloaded = p.downloaded
            if (typeof p?.total === 'number' && p.total > 0) _total = p.total
          }
          emit()
        },
      })
      await AsyncStorage.setItem(READY_KEY, '1').catch(() => {})
      // Distinct 'loading' state: on disk now, but loading it into memory still
      // takes a few seconds, so the UI shows "Loading…" not a stuck 100%.
      _state = 'loading'; _pct = 100; emit()
      const id = await loadModel({
        modelSrc: MODEL.asset,
        modelType: 'llm',
        modelConfig: { device: 'cpu', ctx_size: 1024, verbosity: VERBOSITY.ERROR },
      })
      _modelId = id; _state = 'ready'; emit()
      return id
    })().catch((e) => { _readyPromise = null; _state = 'error'; _error = e?.message ?? String(e); emit(); throw e })
  }
  return _readyPromise
}

export async function getAiStatus (): Promise<AiStatus> { await init(); return status() }

// Explicitly load the model into memory on demand (idle -> loading -> ready).
// Progress streams via the sink; returns the final status.
export async function loadModelNow (): Promise<AiStatus> {
  await init()
  if (!_consent) return status()
  try { await ensureReady() } catch {}
  return status()
}

// Drop the model from MEMORY but keep it on disk (idle). Frees RAM now; a later
// load re-reads from disk, no re-download. Distinct from removeAiModel (which
// deletes the ~0.8GB). No-op if not loaded.
export async function unloadFromMemory (): Promise<AiStatus> {
  await init()
  try { if (_modelId) await unloadModel({ modelId: _modelId, clearStorage: false }) } catch {}
  _modelId = null; _readyPromise = null
  if (_consent && _state === 'ready') _state = 'idle'
  emit()
  return status()
}

// Opt in / out. Turning ON kicks off the download in the BACKGROUND (progress via
// the sink) and returns immediately. Turning OFF fully removes the model + frees
// the ~0.8GB (re-enabling re-downloads) - "off" means gone, not just disabled.
export async function setAiConsent (enabled: boolean): Promise<AiStatus> {
  await init()
  _consent = enabled
  await AsyncStorage.setItem(CONSENT_KEY, enabled ? '1' : '0').catch(() => {})
  if (enabled) { if (_state !== 'ready') ensureReady().catch(() => {}) }
  else { await removeAiModel() }
  return status()
}

// Unload + delete the on-disk model to reclaim space.
export async function removeAiModel (): Promise<AiStatus> {
  await init()
  try { if (_modelId) await unloadModel({ modelId: _modelId, clearStorage: true }) } catch {}
  try { await (deleteCache as any)({ all: true }) } catch {}
  // The real ~0.8GB lives in the SDK's model store at <documentDirectory>.qvac/models
  // (HOME_DIR = the app document dir). unloadModel/deleteCache do NOT remove it, so
  // delete it directly - this is what actually reclaims the space.
  try { await FileSystem.deleteAsync(FileSystem.documentDirectory + '.qvac/models', { idempotent: true }) } catch {}
  _modelId = null; _readyPromise = null; _state = 'none'; _pct = 0; _downloaded = 0; _total = 0; _error = null
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
        { role: 'system', content: 'You assign a grocery item to the single best supermarket aisle. Items are often BRAND NAMES - map the brand to the product it sells (e.g. a chip brand -> Snacks). Reply with JSON only.' },
        // Few-shot: teaches the JSON shape + brand->product mapping, which a 1B
        // model badly needs for lesser-known brands (SunChips -> Snacks, etc).
        { role: 'user', content: 'Item: "SunChips"' }, { role: 'assistant', content: '{"aisle":"Snacks"}' },
        { role: 'user', content: 'Item: "La Croix"' }, { role: 'assistant', content: '{"aisle":"Beverages"}' },
        { role: 'user', content: 'Item: "Tide Pods"' }, { role: 'assistant', content: '{"aisle":"Household"}' },
        { role: 'user', content: 'Item: "Chobani"' }, { role: 'assistant', content: '{"aisle":"Dairy & Eggs"}' },
        { role: 'user', content: 'Item: "Advil"' }, { role: 'assistant', content: '{"aisle":"Personal Care"}' },
        { role: 'user', content: 'Item: "Eggo waffles"' }, { role: 'assistant', content: '{"aisle":"Frozen"}' },
        { role: 'user', content: 'Item: "vanilla extract"' }, { role: 'assistant', content: '{"aisle":"Baking"}' },
        { role: 'user', content: 'Item: "sriracha"' }, { role: 'assistant', content: '{"aisle":"Condiments"}' },
        { role: 'user', content: 'Item: "Cabernet Sauvignon"' }, { role: 'assistant', content: '{"aisle":"Alcohol"}' },
        // Pet food is neither for people (Meat/Pantry) nor cleaning - keep cat/dog
        // food etc. in the Pet aisle so it never lands in a human-food aisle.
        { role: 'user', content: 'Item: "cat food"' }, { role: 'assistant', content: '{"aisle":"Pet"}' },
        { role: 'user', content: 'Item: "dog food"' }, { role: 'assistant', content: '{"aisle":"Pet"}' },
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

const RECIPE_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' }, maxItems: 20 } },
  required: ['items'],
  additionalProperties: false,
}

// Expand a meal / recipe description into a grocery shopping list: short item
// names to buy, no quantities or steps. On-device generation; [] if not consented
// or on any failure. The UI shows the result for review before anything is added.
export async function expandToItems (description: string): Promise<string[]> {
  await init()
  if (!_consent) return []
  const text = String(description || '').trim()
  if (!text) return []
  try {
    const modelId = await ensureReady()
    const run = completion({
      modelId,
      history: [
        { role: 'system', content: 'You turn a meal or recipe into a grocery shopping list: the ingredients someone buys, as short item names. No quantities, no cooking steps, no duplicates. Reply with JSON only.' },
        { role: 'user', content: 'Make: "tacos"' }, { role: 'assistant', content: '{"items":["Ground beef","Taco shells","Shredded cheese","Lettuce","Tomatoes","Salsa","Sour cream","Taco seasoning"]}' },
        { role: 'user', content: 'Make: "spaghetti dinner"' }, { role: 'assistant', content: '{"items":["Spaghetti","Marinara sauce","Ground beef","Parmesan","Garlic","Onion","Garlic bread"]}' },
        { role: 'user', content: `Make: "${text}"` },
      ],
      stream: false,
      responseFormat: { type: 'json_schema', json_schema: { name: 'groceries', schema: RECIPE_SCHEMA, strict: true } },
    })
    const final = await run.final
    const raw = (final.contentText || '').trim()
    let items: any
    try { items = JSON.parse(raw).items } catch { return [] }
    if (!Array.isArray(items)) return []
    return [...new Set(items.map((s: any) => String(s || '').trim()).filter(Boolean))].slice(0, 20)
  } catch {
    return []
  }
}
