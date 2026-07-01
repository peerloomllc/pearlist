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
    if (set) for (const fn of set) { try { fn(data) } catch {} }
  }
}

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
  return () => listeners.get(event)?.delete(fn)
}

// --- browser mock ---------------------------------------------------------
// Preview helper: index.html?ios simulates an iPhone so you can review the
// iOS-hidden donation state. The real shell sets window.__pearPlatform itself.
if (typeof window !== 'undefined' && !window.__pearPlatform && /(?:\?|&)ios/.test(window.location.search || '')) {
  window.__pearPlatform = 'ios'
}

const rid = (n = 16) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
const MOCK_SELF = 'ab'.repeat(32) // this preview device's pubkey
const mock = { groups: new Map(), profile: null }
function mockGroup (groupId) {
  const g = mock.groups.get(groupId)
  if (!g) throw new Error('unknown group: ' + groupId)
  return g
}
const newGroup = (groupId, name, inviteKey) => ({ groupId, name, inviteKey, lists: new Map(), items: new Map(), members: new Map() })
const mockMethods = {
  init: async () => ({ ok: true }),
  'identity:get': async () => ({ pubkey: MOCK_SELF }),
  'group:create': async ({ name }) => {
    const groupId = rid(22)
    const inviteKey = 'mock-' + groupId
    mock.groups.set(groupId, newGroup(groupId, name || 'Household', inviteKey))
    return { groupId, inviteKey }
  },
  'group:join': async ({ inviteKey }) => {
    const groupId = rid(22)
    mock.groups.set(groupId, newGroup(groupId, 'Household', inviteKey))
    return { groupId }
  },
  'household:get': async () => {
    const g = mock.groups.values().next().value
    return g ? { groupId: g.groupId, name: g.name, inviteKey: g.inviteKey } : null
  },
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
    return { itemId: id }
  },
  'item:toggle': async ({ groupId, listId, itemId, checked }) => { mockGroup(groupId).items.get(itemId).checked = !!checked; return { ok: true } },
  'item:edit': async ({ groupId, listId, itemId, text, qty }) => {
    const it = mockGroup(groupId).items.get(itemId); if (text !== undefined) it.text = text; if (qty !== undefined) it.qty = qty; return { ok: true }
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
  const gid = rid(22)
  const g = newGroup(gid, 'The Nest', 'mock-' + gid)
  const SAM = '5a'.repeat(32); const ALEX = 'a1'.repeat(32)
  g.members.set(MOCK_SELF, { pubkey: MOCK_SELF, displayName: mock.profile?.displayName || 'You', avatar: mock.profile?.avatar || null })
  g.members.set(SAM, { pubkey: SAM, displayName: 'Sam', avatar: null })
  g.members.set(ALEX, { pubkey: ALEX, displayName: 'Alex', avatar: null })
  const groceries = rid(); g.lists.set(groceries, { id: groceries, name: 'Groceries', assignee: null, deleted: false })
  const chores = rid(); g.lists.set(chores, { id: chores, name: 'Chores', assignee: ALEX, deleted: false })
  const mk = (listId, text, extra = {}) => { const id = rid(); g.items.set(id, { id, listId, text, qty: 1, checked: false, assignee: null, deleted: false, ...extra }) }
  mk(groceries, 'Oat milk', { qty: 2 }); mk(groceries, 'Sourdough'); mk(groceries, 'Coffee beans', { checked: true })
  mk(groceries, 'Spinach', { assignee: SAM }); mk(groceries, 'Lemons', { qty: 6, checked: true })
  mk(chores, 'Water the plants', { assignee: ALEX }); mk(chores, 'Take out recycling', { checked: true })
  mock.groups.set(gid, g)
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
