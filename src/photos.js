// Photos on list items (proposals/2026-09-23-item-photos.md).
//
// The BYTES live in the engine's content blob store (ctx.blobs, the same Hyperblobs
// core avatars use), never in the Autobase log. The item row carries only a small
// reference:
//   photo?: { key, id, tkey, tid, hash, type, w, h }
// full-size image at { key, id }, 192 px thumbnail at { key: tkey, id: tid }, both
// in the author's blob core. Additive like `category`: old peers store it verbatim.
//
// What this device HOLDS is tracked in localDb under `photoref:{hash}`:
//   { key, id, tkey, tid, size, tsize, groups: [groupId], items: [itemRef], deadSince? }
// `items` are the rows this device has seen use the photo, as groupId/listId/itemId.
// The cleanup sweep clears ONLY ranges recorded there. It never walks the blob core,
// so it cannot touch an avatar in the same core or anything a later feature adds.
//
// NOTHING HERE MAY BLOCK THE IPC LOOP. Core dispatches methods one at a time, so a
// method that waited 8 s on a peer's blob would freeze every other call behind it.
// Fetches from peers run in the background and the UI polls again, the way
// resolveAvatarCached already works.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const { itemKey, listKey } = require('./listWire')

const PHOTO_MAX_BYTES = 1024 * 1024
const THUMB_MAX_BYTES = 64 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
// A replaced or removed photo on a live item waits this long before its bytes are
// cleared: last writer wins on the whole row, so a housemate's concurrent edit made
// from the older row can bring the old reference back. Decided 2026-09-23.
const REPLACED_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const MAINTAIN_FIRST_MS = 60 * 1000
const MAINTAIN_EVERY_MS = 10 * 60 * 1000
const LOCAL_READ_TIMEOUT_MS = 1500
const PEER_FETCH_TIMEOUT_MS = 8000
const PREFIX = 'photoref:'
const ALL_ITEMS = { gt: 'item:', lt: 'item:~' }
const ALL_LISTS = { gt: 'list:', lt: 'list:~' }

function hashOf (buf) { const out = b4a.alloc(32); sodium.crypto_generichash(out, buf); return b4a.toString(out, 'hex') }

function parseImage (dataUrl, maxBytes, what) {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error(what + ' must be a base64 data URL')
  if (!PHOTO_TYPES.includes(m[1])) throw new Error(what + ' must be a JPEG, PNG or WebP image')
  const bytes = b4a.from(m[2], 'base64')
  if (!bytes.length) throw new Error(what + ' is empty')
  if (bytes.length > maxBytes) throw new Error(what + ' too large')
  return { type: m[1], bytes }
}

const isRef = (key, id) => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key) && !!id && typeof id === 'object'
function isPhoto (p) {
  return !!p && typeof p === 'object' && typeof p.hash === 'string' && isRef(p.key, p.id) && isRef(p.tkey, p.tid)
}

// Small LRU of data URLs, keyed `${hash}:${size}`. The avatar cache is an unbounded
// Map, which is fine for a dozen avatars and not for hundreds of photos.
function lru (cap) {
  const m = new Map()
  return {
    get (k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v },
    set (k, v) { m.delete(k); m.set(k, v); while (m.size > cap) m.delete(m.keys().next().value) },
    del (k) { m.delete(k) },
    clear () { m.clear() },
  }
}
const thumbCache = lru(40)
const fullCache = lru(6)
const cacheFor = (size) => (size === 'full' ? fullCache : thumbCache)
const toDataUrl = (type, bytes) => `data:${type || 'image/jpeg'};base64,${b4a.toString(bytes, 'base64')}`

const itemRef = (groupId, listId, itemId) => `${groupId}/${listId}/${itemId}`
const ITEMS_CAP = 50

async function readRef (ctx, hash) {
  try { return (await ctx.localDb.get(PREFIX + hash))?.value || null } catch { return null }
}

// Record that this device holds a photo for `groupId`. Merges groups so the same
// bytes on items in two spaces stay alive while either space still uses them.
// Drops any deadSince mark: every caller is handling a photo that is in use.
async function recordRef (ctx, photo, groupId, extra = {}, at = null) {
  const prev = await readRef(ctx, photo.hash)
  const groups = new Set(prev?.groups || [])
  if (groupId) groups.add(groupId)
  const items = new Set(prev?.items || [])
  if (at) items.add(at)
  const next = {
    key: photo.key, id: photo.id, tkey: photo.tkey, tid: photo.tid,
    size: extra.size ?? prev?.size ?? 0, tsize: extra.tsize ?? prev?.tsize ?? 0,
    groups: [...groups], items: [...items].slice(-ITEMS_CAP),
  }
  await ctx.localDb.put(PREFIX + photo.hash, next)
  return next
}

// ---------------------------------------------------------------------------
// The live set. Pure over a snapshot so the rules are testable on their own.
//
// `spaces` is [{ groupId, mounted, lists: [row], items: [row] }] for every JOINED
// space. A hash is LIVE if a non-deleted item in a list that is not deleted uses it.
// `list:delete` tombstones only the list row, so its items still read as
// deleted:false and have to be excluded here. An item whose list row has not
// replicated yet counts as live: not knowing is never a reason to clear.
//
// A hash is FINAL (safe to clear with no grace) when it is not live and every
// reference to it we can see is on a tombstoned item or inside a deleted list.
// Tombstones cannot be undone (the no-resurrection rule), so nothing can bring
// those rows back.
//
// `deadItems` holds every tombstoned item and every item in a deleted list, photo
// or not, as an itemRef. A photo that was REPLACED on an item that has since been
// deleted is no longer on any row, so only this can tell the sweep it is final.
function liveSet (spaces) {
  const live = new Map()   // hash -> { photo, groupId, listId, itemId }
  const final = new Set()
  const deadItems = new Set()
  const unknownGroups = new Set()
  for (const s of spaces) {
    if (!s.mounted) { unknownGroups.add(s.groupId); continue }
    const deletedLists = new Set()
    for (const l of s.lists) if (l && l.deleted && l.id) deletedLists.add(l.id)
    for (const it of s.items) {
      if (!it) continue
      const dead = it.deleted === true || deletedLists.has(it.listId)
      if (dead && it.id) deadItems.add(itemRef(s.groupId, it.listId, it.id))
      if (!isPhoto(it.photo)) continue
      if (dead) { final.add(it.photo.hash); continue }
      if (!live.has(it.photo.hash)) live.set(it.photo.hash, { photo: it.photo, groupId: s.groupId, listId: it.listId, itemId: it.id })
    }
  }
  for (const h of live.keys()) final.delete(h)
  return { live, final, deadItems, unknownGroups }
}

// What the sweep does with one recorded photo. Pure.
//   'keep'   - live, or we cannot tell (a space it belongs to is joined but not
//              mounted, so its rows are unreadable right now)
//   'revive' - live again after being marked dead: drop the mark
//   'mark'   - newly dead, start the grace period
//   'wait'   - dead, grace period still running
//   'clear'  - clear the bytes now
function sweepDecision (ref, hash, { live, final, deadItems = new Set(), unknownGroups, joined }, now, graceMs) {
  if (live.has(hash)) return ref.deadSince ? 'revive' : 'keep'
  const groups = ref.groups || []
  if (groups.some((g) => unknownGroups.has(g))) return 'keep'
  // Every item seen using it is gone for good, or in a space this phone left.
  const items = ref.items || []
  if (items.length && items.every((k) => deadItems.has(k) || !joined.has(k.split('/')[0]))) return 'clear'
  // Every space it belonged to is gone from this device: nothing here can use it.
  const allLeft = groups.length > 0 && groups.every((g) => !joined.has(g))
  if (allLeft || final.has(hash)) return 'clear'
  if (!ref.deadSince) return 'mark'
  return now - ref.deadSince >= graceMs ? 'clear' : 'wait'
}

async function snapshotSpaces (ctx) {
  const out = []
  for await (const { value } of ctx.localDb.createReadStream({ gt: 'groups:joined:', lt: 'groups:joined:~' })) {
    if (!value || !value.groupId) continue
    const base = ctx.bases.get(value.groupId)
    const s = { groupId: value.groupId, mounted: false, lists: [], items: [] }
    if (base && base.view) {
      try {
        await base.update()
        for await (const { value: l } of base.view.createReadStream(ALL_LISTS)) s.lists.push(l)
        for await (const { value: it } of base.view.createReadStream(ALL_ITEMS)) s.items.push(it)
        s.mounted = true
      } catch { s.mounted = false; s.lists = []; s.items = [] }
    }
    out.push(s)
  }
  return out
}

async function clearRange (ctx, key, id) {
  if (!isRef(key, id) || typeof id.blockOffset !== 'number' || typeof id.blockLength !== 'number') return
  const core = ctx.store.get(b4a.from(key, 'hex'))
  try {
    await core.ready()
    await core.clear(id.blockOffset, id.blockOffset + id.blockLength)
  } finally { await core.close().catch(() => {}) }
}

// Fetch a photo's bytes from wherever they are (this device or a peer) and record
// that we now hold them. Background use only: it can wait PEER_FETCH_TIMEOUT_MS.
const inflight = new Map() // `${hash}:${size}` -> Promise
function fetchInBackground (ctx, photo, groupId, size, at = null) {
  const k = photo.hash + ':' + size
  if (inflight.has(k)) return inflight.get(k)
  const p = (async () => {
    const ref = size === 'full' ? { key: photo.key, id: photo.id } : { key: photo.tkey, id: photo.tid }
    const bytes = await ctx.blobs.get(ref, { timeout: PEER_FETCH_TIMEOUT_MS })
    if (!bytes) return false
    cacheFor(size).set(k, toDataUrl(photo.type, bytes))
    await recordRef(ctx, photo, groupId, size === 'full' ? { size: bytes.length } : { tsize: bytes.length }, at)
    return true
  })().catch(() => false).finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

// Download whichever of the thumbnail and full image this device lacks, thumbnail
// first. Returns how many it fetched.
async function fetchMissing (ctx, photo, groupId, at = null) {
  const ref = await readRef(ctx, photo.hash)
  if (ref && ref.tsize && ref.size) {
    if (!(ref.groups || []).includes(groupId) || (at && !(ref.items || []).includes(at))) await recordRef(ctx, photo, groupId, {}, at)
    return 0
  }
  let n = 0
  if (!(ref && ref.tsize) && await fetchInBackground(ctx, photo, groupId, 'thumb', at)) n++
  if (!(ref && ref.size) && await fetchInBackground(ctx, photo, groupId, 'full', at)) n++
  return n
}

// Download every live photo this device does not hold yet, then sweep. One photo
// at a time, thumbnail first, so a big backlog does not flood the connection.
async function maintain (ctx, { now = Date.now(), graceMs = REPLACED_GRACE_MS } = {}) {
  const spaces = await snapshotSpaces(ctx)
  const sets = liveSet(spaces)
  const joined = new Set(spaces.map((s) => s.groupId))
  let fetched = 0
  for (const [, { photo, groupId, listId, itemId }] of sets.live) fetched += await fetchMissing(ctx, photo, groupId, itemRef(groupId, listId, itemId))
  let cleared = 0
  const refs = []
  for await (const { key, value } of ctx.localDb.createReadStream({ gt: PREFIX, lt: PREFIX + '~' })) refs.push([key.slice(PREFIX.length), value])
  for (const [hash, ref] of refs) {
    const d = sweepDecision(ref, hash, { ...sets, joined }, now, graceMs)
    if (d === 'mark') await ctx.localDb.put(PREFIX + hash, { ...ref, deadSince: now })
    else if (d === 'revive') { const { deadSince, ...rest } = ref; await ctx.localDb.put(PREFIX + hash, rest) } // eslint-disable-line no-unused-vars
    else if (d === 'clear') {
      try {
        await clearRange(ctx, ref.key, ref.id)
        await clearRange(ctx, ref.tkey, ref.tid)
        await ctx.localDb.del(PREFIX + hash)
        thumbCache.del(hash + ':thumb'); fullCache.del(hash + ':full')
        cleared++
      } catch (e) { try { ctx.emit('photo:clear:failed', { hash, error: e?.message }) } catch {} }
    }
  }
  return { live: sets.live.size, fetched, cleared, held: refs.length - cleared }
}

// One background timer per engine: first run a minute after the first photo-aware
// call, then every 10 minutes. unref'd so it never keeps a process (or a test) alive.
const timers = new WeakMap()
let running = false
function ensureMaintainTimer (ctx) {
  const owner = ctx.engine || ctx.localDb
  if (!owner || timers.has(owner)) return
  const run = () => {
    if (running) return
    running = true
    maintain(ctx).catch(() => {}).finally(() => { running = false })
  }
  const first = setTimeout(() => {
    run()
    const every = setInterval(run, MAINTAIN_EVERY_MS)
    if (every.unref) every.unref()
    timers.set(owner, every)
  }, MAINTAIN_FIRST_MS)
  if (first.unref) first.unref()
  timers.set(owner, first)
}

// Download the photos on rows the UI just read, in the background, so a photo a
// housemate added arrives while the app is open instead of on the next timer run.
// One pass per space at a time; rows already in hand, so no extra view reads.
const prefetching = new Set()
function prefetchRows (ctx, groupId, rows) {
  ensureMaintainTimer(ctx)
  const withPhotos = rows.filter((it) => it && !it.deleted && isPhoto(it.photo))
  if (!withPhotos.length || prefetching.has(groupId)) return
  prefetching.add(groupId)
  ;(async () => { for (const it of withPhotos) await fetchMissing(ctx, it.photo, groupId, itemRef(groupId, it.listId, it.id)) })()
    .catch(() => {}).finally(() => prefetching.delete(groupId))
}

function photoMethods ({ viewFor, readRow, putRow }) {
  return {
    // Set, replace or remove (photo: null) the photo on an item. `photo` and
    // `thumb` are data URLs, already compressed by the UI (1600 px q0.85 and
    // 192 px q0.75, see the proposal). The caps only catch a UI bug.
    'item:setPhoto': async ({ groupId, listId, itemId, photo, thumb, w, h }, ctx) => {
      ensureMaintainTimer(ctx)
      const base = viewFor(ctx, groupId)
      const list = await readRow(base, listKey(listId))
      if (list && list.kind === 'note') throw new Error('notes do not take photos')
      const existing = await readRow(base, itemKey(listId, itemId))
      if (!existing || existing.deleted) throw new Error('item not found')
      if (photo === null) {
        const { photo: _old, ...rest } = existing // eslint-disable-line no-unused-vars
        await putRow(ctx, groupId, itemKey(listId, itemId), rest)
        return { ok: true, photo: null }
      }
      const full = parseImage(photo, PHOTO_MAX_BYTES, 'photo')
      const small = parseImage(thumb, THUMB_MAX_BYTES, 'thumbnail')
      const hash = hashOf(full.bytes)
      // Same bytes already held (on another item, or fetched from a housemate):
      // point at the copy we have rather than appending them again.
      // Only when BOTH are held: a thumbnail-only copy would record the full image as
      // held, and the download pass would never fetch it.
      let ref = await readRef(ctx, hash)
      if (!ref || !ref.size || !ref.tsize) {
        const a = await ctx.blobs.put(full.bytes)
        const b = await ctx.blobs.put(small.bytes)
        ref = { key: a.key, id: a.id, tkey: b.key, tid: b.id }
      }
      const value = {
        key: ref.key, id: ref.id, tkey: ref.tkey, tid: ref.tid, hash, type: full.type,
        w: Number.isFinite(w) ? Math.round(w) : undefined, h: Number.isFinite(h) ? Math.round(h) : undefined,
      }
      await recordRef(ctx, value, groupId, { size: full.bytes.length, tsize: small.bytes.length }, itemRef(groupId, listId, itemId))
      fullCache.set(hash + ':full', String(photo))
      thumbCache.set(hash + ':thumb', String(thumb))
      await putRow(ctx, groupId, itemKey(listId, itemId), { ...existing, photo: value })
      return { ok: true, photo: value }
    },

    // A data URL, or null when the bytes are not on this device yet. A null kicks
    // a background download, so the UI shows a placeholder and asks again.
    'item:getPhoto': async ({ groupId, listId, itemId, size = 'thumb' }, ctx) => {
      ensureMaintainTimer(ctx)
      const sz = size === 'full' ? 'full' : 'thumb'
      const row = await readRow(viewFor(ctx, groupId), itemKey(listId, itemId))
      if (!row || row.deleted || !isPhoto(row.photo)) return null
      const p = row.photo
      const k = p.hash + ':' + sz
      const hit = cacheFor(sz).get(k)
      if (hit) return hit
      const held = await readRef(ctx, p.hash)
      if (held && (sz === 'full' ? held.size : held.tsize)) {
        const refp = sz === 'full' ? { key: p.key, id: p.id } : { key: p.tkey, id: p.tid }
        const bytes = await ctx.blobs.get(refp, { timeout: LOCAL_READ_TIMEOUT_MS })
        if (bytes) { const url = toDataUrl(p.type, bytes); cacheFor(sz).set(k, url); return url }
      }
      fetchInBackground(ctx, p, groupId, sz, itemRef(groupId, listId, itemId))
      return null
    },

    // Run the download pass and the cleanup sweep now. The timer calls the same
    // function; tests pass `now` and `graceMs` to move the clock.
    'photo:maintain': async ({ now, graceMs } = {}, ctx) => maintain(ctx, {
      now: Number.isFinite(now) ? now : Date.now(),
      graceMs: Number.isFinite(graceMs) ? graceMs : REPLACED_GRACE_MS,
    }),

    // For the Settings storage line. Logical bytes: the file on disk shrinks later,
    // when RocksDB compacts.
    'photo:stats': async (_args, ctx) => {
      let count = 0; let bytes = 0
      for await (const { value } of ctx.localDb.createReadStream({ gt: PREFIX, lt: PREFIX + '~' })) {
        count++; bytes += (value?.size || 0) + (value?.tsize || 0)
      }
      return { count, bytes }
    },
  }
}

module.exports = {
  photoMethods, prefetchRows, liveSet, sweepDecision, parseImage, isPhoto,
  PHOTO_MAX_BYTES, THUMB_MAX_BYTES, REPLACED_GRACE_MS,
  _resetCaches () { thumbCache.clear(); fullCache.clear() },
}
