// Screenshot-mode fixtures. Activated when the RN shell injects
// window.__PEARLIST_SCREENSHOT_SCENE (a scene number) into the WebView HTML
// before this bundle runs. The shell derives that number from a launch deep
// link (pear://pearlist/screenshot/<N>) driven by the capture scripts
// (scripts/ios-screenshots.sh, scripts/android-screenshots.sh).
//
// Unlike PearGuard (whose UI calls window.callBare directly, so fixtures swap
// that global), PearList's UI imports a bound `call` from ipc.js. So the swap
// lives in ipc.js: when a scene is set, ipc.js uses screenshotCall below instead
// of the real bridge, and installScreenshotEnv() freezes the clock, forces the
// dark theme, and marks the guided tour as seen so nothing overlays the frame.
//
// Scenes (all render against one deterministic household, "Family"):
//   1  Lists overview of the Family space (Groceries, Chores, Weekend Trip)
//   2  Groceries list detail (checked items, quantities, assignees, a note)
//   3  Chores list detail used as a chore board (items assigned to people)
//   4  Invite sheet (QR + share) for the Family space
//   5  Members sheet (the household roster)
//   6  Space switcher (Family + Party Crew - one app, many private groups)

const FROZEN_MS = new Date('2026-07-06T09:41:00').getTime()

// Stable member identities (hex pubkeys). Items/lists reference these so the
// assignee avatars resolve against member:getAll.
const SELF = '00'.repeat(32) // this device: Maya
const SAM = '5a'.repeat(32)
const ALEX = 'a1'.repeat(32)
const JORDAN = 'c3'.repeat(32)
const RILEY = 'd4'.repeat(32)

// Opaque invite blobs (ride in the URL fragment). Long enough to render a
// realistic, dense QR in the invite scene.
const INVITE_FAMILY = 'pl1KQZ4nR7xW2mB9tD6vY0aH3cJ8fL5gN1sU4pE7qO2iX6yA9zC3bV0dM8kT5wR2nG7hP4'
const INVITE_PARTY = 'pl1TmP9wKQ2xR7nB4vY6aH0cJ3fL8gN5sU1pE9qO7iX2yA4zC6bV3dM0kT8wR5nG2hP1oD'

const PROFILE = { displayName: 'Maya', avatar: null, updatedAt: FROZEN_MS, v: 1 }

// Spaces in insertion order; the shell boots into the first one (Family).
const SPACES = [
  { groupId: 'fam', name: 'Family', inviteKey: INVITE_FAMILY, owner: true },
  { groupId: 'party', name: 'Party Crew', inviteKey: INVITE_PARTY, owner: false },
]

const MEMBERS = {
  fam: [
    { pubkey: SELF, displayName: 'Maya', avatar: null },
    { pubkey: SAM, displayName: 'Sam', avatar: null },
    { pubkey: ALEX, displayName: 'Alex', avatar: null },
  ],
  party: [
    { pubkey: SELF, displayName: 'Maya', avatar: null },
    { pubkey: JORDAN, displayName: 'Jordan', avatar: null },
    { pubkey: RILEY, displayName: 'Riley', avatar: null },
  ],
}

const LISTS = {
  fam: [
    { id: 'groceries', name: 'Groceries', assignee: null },
    { id: 'chores', name: 'Chores', assignee: ALEX },
    { id: 'trip', name: 'Weekend Trip', assignee: null },
  ],
  party: [
    { id: 'supplies', name: 'Supplies', assignee: JORDAN },
  ],
}

// listId -> items (insertion order is display order).
const ITEMS = {
  groceries: [
    { id: 'g1', listId: 'groceries', text: 'Oat milk', qty: 2, checked: false, assignee: null },
    { id: 'g2', listId: 'groceries', text: 'Sourdough bread', qty: 1, checked: false, assignee: null },
    { id: 'g3', listId: 'groceries', text: 'Coffee beans', qty: 1, checked: true, assignee: null },
    { id: 'g4', listId: 'groceries', text: 'Spinach', qty: 1, checked: false, assignee: SAM },
    { id: 'g5', listId: 'groceries', text: 'Bananas', qty: 6, checked: false, assignee: null },
    { id: 'g6', listId: 'groceries', text: 'Olive oil', qty: 1, checked: true, assignee: null },
    { id: 'g7', listId: 'groceries', text: 'Cherry tomatoes', qty: 1, checked: false, assignee: ALEX, note: 'for the salad' },
  ],
  chores: [
    { id: 'c1', listId: 'chores', text: 'Water the plants', qty: 1, checked: false, assignee: ALEX },
    { id: 'c2', listId: 'chores', text: 'Take out the recycling', qty: 1, checked: true, assignee: null },
    { id: 'c3', listId: 'chores', text: 'Vacuum the living room', qty: 1, checked: false, assignee: SAM },
    { id: 'c4', listId: 'chores', text: 'Load the dishwasher', qty: 1, checked: true, assignee: null },
  ],
  trip: [
    { id: 't1', listId: 'trip', text: 'Sunscreen', qty: 1, checked: false, assignee: null },
    { id: 't2', listId: 'trip', text: 'Phone charger', qty: 1, checked: false, assignee: null },
    { id: 't3', listId: 'trip', text: 'Snacks', qty: 3, checked: false, assignee: null },
  ],
  supplies: [
    { id: 's1', listId: 'supplies', text: 'Cups + plates', qty: 1, checked: false, assignee: null },
    { id: 's2', listId: 'supplies', text: 'Ice', qty: 3, checked: false, assignee: null },
    { id: 's3', listId: 'supplies', text: 'Playlist', qty: 1, checked: true, assignee: RILEY },
  ],
}

// Per-scene routing the UI applies after boot (see App.jsx). openList is matched
// by name against the active space's lists; sheet/view name an overlay to open.
const ROUTES = {
  1: {},
  2: { openList: 'Groceries' },
  3: { openList: 'Chores' },
  4: { sheet: 'invite' },
  5: { sheet: 'members' },
  6: { sheet: 'spaces' },
}

const P = (v) => Promise.resolve(v)
const clone = (arr) => arr.map((x) => ({ ...x }))

// Deterministic replacement for ipc.js's real bridge. Read methods return canned
// data; mutations/shell calls are not exercised by a static capture, so they
// resolve to a benign null.
function screenshotCall (method, args = {}) {
  const g = args.groupId
  switch (method) {
    case 'init': return P({ ok: true })
    case 'identity:get': return P({ pubkey: SELF })
    case 'profile:get': return P({ ...PROFILE })
    case 'spaces:list': return P(clone(SPACES))
    case 'list:getAll': return P(clone(LISTS[g] || []))
    case 'item:getAll': return P(clone(ITEMS[args.listId] || []))
    case 'member:getAll': return P(clone(MEMBERS[g] || []))
    case 'member:publish': return P({ published: true })
    case 'donation:status': return P({ due: false, shown: true, firstUseAt: FROZEN_MS })
    case 'item:suggest': return P([])
    case 'shell:navState': return P({ ok: true })
    default: return P(null)
  }
}

// Freeze Date so any relative-time rendering (and future date-dependent UI) is
// deterministic across runs. Mirrors PearGuard's fixtures.
function freezeDate () {
  const OrigDate = window.Date
  const FrozenDate = function (...a) { return a.length === 0 ? new OrigDate(FROZEN_MS) : new OrigDate(...a) }
  FrozenDate.now = () => FROZEN_MS
  FrozenDate.parse = OrigDate.parse
  FrozenDate.UTC = OrigDate.UTC
  FrozenDate.prototype = OrigDate.prototype
  window.Date = FrozenDate
}

export const SCREENSHOT_SCENE =
  (typeof window !== 'undefined' && Number.isInteger(window.__PEARLIST_SCREENSHOT_SCENE))
    ? window.__PEARLIST_SCREENSHOT_SCENE
    : null

export const SCREENSHOT_ROUTE = SCREENSHOT_SCENE != null ? (ROUTES[SCREENSHOT_SCENE] || {}) : null

export { screenshotCall }

// Prepare the environment for a clean capture: force the dark theme, mark the
// guided tour as already seen (so it never overlays the frame), and freeze the
// clock. Called by ipc.js once, at import, when a scene is active.
export function installScreenshotEnv () {
  try { window.localStorage.setItem('pearlist:theme', 'dark') } catch {}
  try { window.localStorage.setItem('pearlist:tourSeen', '1') } catch {}
  freezeDate()
}
