// IPC bridge to the worklet, matching the suite's window.pear = { call, on }
// shape. In a real shell, ReactNativeWebView carries { id, method, args } to the
// worklet and the shell calls window.__pearResponse / window.__pearEvent back.
// In a plain browser (design/dev preview) we fall back to an in-memory mock that
// mirrors the worklet methods, so the screens are fully clickable without a phone.

const inShell = typeof window !== 'undefined' && !!window.ReactNativeWebView

// --- real bridge ----------------------------------------------------------
const pending = new Map()
let nextId = 1
const listeners = new Map()

if (typeof window !== 'undefined') {
  window.__pearResponse = (msg) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }
  window.__pearEvent = (name, data) => {
    const set = listeners.get(name)
    if (set && set.size) { for (const fn of set) { try { fn(data) } catch {} } }
    // No listener yet (e.g. a deep link delivered before React mounted): buffer
    // it and replay when a listener for this event subscribes.
    else earlyEvents.push([name, data])
  }
}

// Events that arrived before any listener was registered.
const earlyEvents = []

function realCall (method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args: args || {} }))
  })
}

export function on (event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(fn)
  // Replay any events that arrived for this name before a listener existed.
  for (let i = earlyEvents.length - 1; i >= 0; i--) {
    if (earlyEvents[i][0] === event) { const [, data] = earlyEvents.splice(i, 1)[0]; try { fn(data) } catch {} }
  }
  return () => listeners.get(event)?.delete(fn)
}

// Fire-and-forget haptic tap. The shell maps `kind` to expo-haptics; in the
// browser preview it is a no-op. Never throws or blocks the UI.
export function haptic (kind = 'light') {
  try { const p = call('shell:haptic', { kind }); if (p && p.catch) p.catch(() => {}) } catch {}
}

// --- browser mock ---------------------------------------------------------
// Preview helper: index.html?ios simulates an iPhone so you can review the
// iOS-hidden donation state. The real shell sets window.__pearPlatform itself.
if (typeof window !== 'undefined' && !window.__pearPlatform && /(?:\?|&)ios/.test(window.location.search || '')) {
  window.__pearPlatform = 'ios'
}

const rid = (n = 16) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
const MOCK_SELF = 'ab'.repeat(32) // this preview device's pubkey
// A few common groceries so the preview shows suggestions before you add anything.
const MOCK_RECENTS = ['Milk', 'Eggs', 'Bread', 'Bananas', 'Coffee beans', 'Butter', 'Chicken', 'Spinach']
  .map((text, i) => ({ norm: text.toLowerCase(), text, count: 10 - i, lastAt: 0 }))
const mock = { groups: new Map(), profile: null, recents: MOCK_RECENTS.slice() }
function mockGroup (groupId) {
  const g = mock.groups.get(groupId)
  if (!g) throw new Error('unknown group: ' + groupId)
  return g
}
const newGroup = (groupId, name, inviteKey, owner = true) => ({ groupId, name, inviteKey, owner, lists: new Map(), items: new Map(), members: new Map() })
const mockMethods = {
  init: async () => ({ ok: true }),
  'identity:get': async () => ({ pubkey: MOCK_SELF }),
  'group:create': async ({ name }) => {
    const groupId = rid(22)
    const inviteKey = 'mock-' + groupId
    mock.groups.set(groupId, newGroup(groupId, name || 'Household', inviteKey, true))
    return { groupId, inviteKey }
  },
  'group:join': async ({ inviteKey }) => {
    const groupId = rid(22)
    mock.groups.set(groupId, newGroup(groupId, 'Household', inviteKey, false))
    return { groupId }
  },
  'spaces:list': async () => [...mock.groups.values()].map((g) => ({ groupId: g.groupId, name: g.name, inviteKey: g.inviteKey, owner: g.owner })),
  'space:init': async () => ({ ok: true }),
  'space:retain': async () => ({ ok: true, cleared: 0, cores: 0 }),
  'space:delete': async ({ groupId }) => { mock.groups.delete(groupId); return { ok: true } },
  'space:forget': async ({ groupId }) => { mock.groups.delete(groupId); return { ok: true } },
  'member:publish': async ({ groupId }) => {
    mockGroup(groupId).members.set(MOCK_SELF, { pubkey: MOCK_SELF, displayName: mock.profile?.displayName || 'You', avatar: mock.profile?.avatar || null })
    return { published: true }
  },
  'member:getAll': async ({ groupId }) => [...mockGroup(groupId).members.values()],
  'list:create': async ({ groupId, name }) => {
    const id = rid(); mockGroup(groupId).lists.set(id, { id, name: name || '', assignee: null, deleted: false }); return { listId: id }
  },
  'list:rename': async ({ groupId, listId, name }) => { mockGroup(groupId).lists.get(listId).name = name; return { ok: true } },
  'list:delete': async ({ groupId, listId }) => { mockGroup(groupId).lists.get(listId).deleted = true; return { ok: true } },
  'list:assign': async ({ groupId, listId, assignee }) => { mockGroup(groupId).lists.get(listId).assignee = assignee || null; return { ok: true } },
  'list:getAll': async ({ groupId }) => [...mockGroup(groupId).lists.values()].filter(l => !l.deleted),
  'item:add': async ({ groupId, listId, text, qty }) => {
    const id = rid()
    mockGroup(groupId).items.set(id, { id, listId, text: text || '', qty: qty || 1, checked: false, assignee: null, deleted: false })
    const t = String(text || '').trim()
    if (t) { const norm = t.toLowerCase(); const ex = mock.recents.find((x) => x.norm === norm); if (ex) { ex.count++; ex.text = t } else mock.recents.push({ norm, text: t, count: 1, lastAt: 0 }) }
    return { itemId: id }
  },
  'item:suggest': async ({ prefix, limit } = {}) => {
    const p = String(prefix || '').trim().toLowerCase()
    let items = mock.recents
    if (p) items = items.filter((x) => x.norm !== p && (x.norm.startsWith(p) || x.norm.split(/\s+/).some((w) => w.startsWith(p))))
    return items.slice().sort((a, b) => b.count - a.count).slice(0, Math.max(1, Math.min(limit || 5, 10))).map((x) => x.text)
  },
  'item:toggle': async ({ groupId, listId, itemId, checked }) => { mockGroup(groupId).items.get(itemId).checked = !!checked; return { ok: true } },
  'item:edit': async ({ groupId, listId, itemId, text, qty, note, url }) => {
    const it = mockGroup(groupId).items.get(itemId)
    if (text !== undefined) it.text = text
    if (qty !== undefined) it.qty = qty
    if (note !== undefined) it.note = note ? String(note) : ''
    if (url !== undefined) it.url = url ? (/^https?:\/\//i.test(url) ? url : 'https://' + url) : ''
    return { ok: true }
  },
  'item:assign': async ({ groupId, listId, itemId, assignee }) => { mockGroup(groupId).items.get(itemId).assignee = assignee || null; return { ok: true } },
  'item:delete': async ({ groupId, listId, itemId }) => { mockGroup(groupId).items.get(itemId).deleted = true; return { ok: true } },
  'item:getAll': async ({ groupId, listId }) => [...mockGroup(groupId).items.values()].filter(i => i.listId === listId && !i.deleted),
  'profile:get': async () => mock.profile,
  'profile:set': async ({ displayName, ...rest }) => {
    if (!displayName || !displayName.trim()) throw new Error('displayName required')
    const p = { ...(mock.profile || {}), displayName: displayName.trim().slice(0, 64), updatedAt: Date.now(), v: 1 }
    if ('avatar' in rest) { if (rest.avatar) p.avatar = rest.avatar; else delete p.avatar }
    mock.profile = p
    for (const g of mock.groups.values()) if (g.members.has(MOCK_SELF)) g.members.set(MOCK_SELF, { pubkey: MOCK_SELF, displayName: p.displayName, avatar: p.avatar || null })
    return p
  },
  // Donation reminder: ?donate forces "due" so it can be previewed on demand.
  'donation:status': async () => ({ due: /(?:\?|&)donate/.test(window.location.search || ''), shown: false, firstUseAt: 0 }),
  'donation:dismiss': async () => ({ ok: true }),
  // Shell actions (real shell intercepts these; here we approximate for preview).
  'shell:openUrl': async ({ url }) => { try { window.open(url, '_blank', 'noopener') } catch {} return { ok: true } },
  'shell:share': async ({ title, text }) => { try { if (navigator.share) await navigator.share({ title, text }); else alert('Share:\n\n' + text) } catch {} return { ok: true } },
  'shell:canOpenURL': async () => ({ can: false }),
  'shell:haptic': async () => ({ ok: true }),
  'shell:navState': async () => ({ ok: true }),
  'shell:notifications:get': async () => ({ enabled: false }),
  'shell:notifications:set': async ({ enabled }) => ({ enabled: !!enabled }),
  'shell:scanQr': async () => { const code = window.prompt ? window.prompt('Paste an invite code (camera scan on device):') : null; return { code: code || null } },
}
// Browser design preview: open index.html?seed to land on a populated list
// instead of onboarding. Seeds lazily on the first mock call (after all module
// state is initialized), so it is order-independent. No effect in a real shell.
let seeded = false
function seedIfRequested () {
  if (seeded) return
  seeded = true
  if (typeof window === 'undefined') return
  if (!/(?:\?|&)seed/.test(window.location.search || '')) return
  const me = (g) => g.members.set(MOCK_SELF, { pubkey: MOCK_SELF, displayName: mock.profile?.displayName || 'You', avatar: mock.profile?.avatar || null })
  const member = (g, pk, name) => g.members.set(pk, { pubkey: pk, displayName: name, avatar: null })
  const list = (g, name, assignee = null) => { const id = rid(); g.lists.set(id, { id, name, assignee, deleted: false }); return id }
  const item = (g, listId, text, extra = {}) => { const id = rid(); g.items.set(id, { id, listId, text, qty: 1, checked: false, assignee: null, deleted: false, ...extra }) }

  // Space 1: Family
  const SAM = '5a'.repeat(32); const ALEX = 'a1'.repeat(32)
  const fam = newGroup(rid(22), 'Family', 'mock-fam')
  me(fam); member(fam, SAM, 'Sam'); member(fam, ALEX, 'Alex')
  const groceries = list(fam, 'Groceries'); const chores = list(fam, 'Chores', ALEX)
  item(fam, groceries, 'Oat milk', { qty: 2 }); item(fam, groceries, 'Sourdough'); item(fam, groceries, 'Coffee beans', { checked: true })
  item(fam, groceries, 'Spinach', { assignee: SAM }); item(fam, groceries, 'Lemons', { qty: 6, checked: true })
  item(fam, chores, 'Water the plants', { assignee: ALEX }); item(fam, chores, 'Take out recycling', { checked: true })
  mock.groups.set(fam.groupId, fam)

  // Space 2: Party Crew (different people, separate)
  const JORDAN = 'c3'.repeat(32); const RILEY = 'd4'.repeat(32)
  const party = newGroup(rid(22), 'Party Crew', 'mock-party')
  me(party); member(party, JORDAN, 'Jordan'); member(party, RILEY, 'Riley')
  const supplies = list(party, 'Supplies', JORDAN)
  item(party, supplies, 'Cups + plates'); item(party, supplies, 'Ice', { qty: 3 }); item(party, supplies, 'Playlist', { assignee: RILEY, checked: true })
  mock.groups.set(party.groupId, party)
}

async function mockCall (method, args) {
  seedIfRequested()
  const fn = mockMethods[method]
  if (!fn) throw new Error('unknown method: ' + method)
  return fn(args || {})
}

export const call = inShell ? realCall : mockCall
export const isMock = !inShell

if (typeof window !== 'undefined') window.pear = { call, on }
