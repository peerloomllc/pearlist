// Space export / import: the pure half.
//
// WHY IT EXISTS. Everything in PearList lives in one place - the household's own
// phones - and there is no server to fall back on. Two ways that bites:
//   - a phone dies, or is wiped, and its lists are the only copy on that device.
//   - a device that joined a space but was never admitted holds a space it cannot
//     read, cannot write and (until 2026-07-28) could not even leave.
// A file is the escape hatch for both, and unlike everything else here it needs no
// peer to be reachable.
//
// DELIBERATELY UNSIGNED, unlike PearGuard's device-backup. That file carries an
// IDENTITY, so a signature is what stops someone restoring themselves as you.
// This one carries no authority at all: importing writes a BRAND NEW space that
// this device founds and signs, so a signature could only ever refuse an import,
// never grant one. What it would cost is real - a rescue file you cannot open in a
// text editor and fix by hand is a worse rescue file.
//
// WHAT IS AND IS NOT CARRIED. The shape and state of the lists, not the household:
// no identities, no writer keys, no invite, no member roster. `assignee` is
// dropped on purpose - it names a pubkey that does not exist in the new space, so
// carrying it would render as a permanently unknown person. Reminders are dropped
// too: they are wall-clock times that would arrive in the past.

const KIND = 'pearlist-space'
const VERSION = 1

// Bounds. An import writes one signed op per row into a live Autobase, so a
// hand-edited or hostile file must not be able to ask for unbounded work.
const MAX_LISTS = 200
const MAX_ITEMS = 5000

const str = (v) => typeof v === 'string' ? v : ''
const clean = (v) => str(v).trim()

// One item, reduced to what survives the trip. Mirrors template:save's entry
// shape plus the state a backup (unlike a template) is expected to keep.
function exportItem (row) {
  const out = { text: str(row.text) }
  if (Number.isFinite(row.qty) && row.qty !== 1) out.qty = row.qty
  if (row.checked === true) out.checked = true
  if (clean(row.category)) out.category = clean(row.category)
  if (clean(row.ord)) out.ord = clean(row.ord)
  if (clean(row.note)) out.note = clean(row.note)
  if (clean(row.url)) out.url = clean(row.url)
  if (row.repeat && typeof row.repeat === 'object') out.repeat = row.repeat
  return out
}

// `lists` is [{ name, kind, items: [row] }] straight off the view.
function buildBackup ({ spaceName, lists, exportedAt }) {
  const out = []
  let items = 0
  for (const l of (lists || [])) {
    if (out.length >= MAX_LISTS) break
    const entries = []
    for (const it of (l.items || [])) {
      if (items >= MAX_ITEMS) break
      entries.push(exportItem(it || {}))
      items++
    }
    out.push({ name: clean(l.name) || 'List', kind: clean(l.kind) || null, items: entries })
  }
  return {
    kind: KIND,
    version: VERSION,
    exportedAt: Number.isFinite(exportedAt) ? exportedAt : 0,
    space: { name: clean(spaceName) || 'Space' },
    lists: out,
  }
}

// Parse + validate a file a human may have edited. Throws with a message meant
// for a person, because it is shown to one: "that file is not a PearList export"
// is actionable, a JSON syntax error dump is not.
function parseBackup (jsonString) {
  let doc
  try {
    doc = JSON.parse(String(jsonString ?? ''))
  } catch {
    throw new Error('that file is not readable as JSON')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('that file is not a PearList export')
  if (doc.kind !== KIND) throw new Error('that file is not a PearList export')
  // Forward-compatible on purpose: a NEWER file is refused with a clear reason
  // rather than half-imported, because we cannot know what we would be dropping.
  if (!Number.isFinite(doc.version) || doc.version > VERSION) throw new Error('that export was made by a newer version of PearList')
  if (!Array.isArray(doc.lists)) throw new Error('that export has no lists in it')

  const lists = []
  let items = 0
  for (const l of doc.lists) {
    if (!l || typeof l !== 'object') continue
    if (lists.length >= MAX_LISTS) break
    const entries = []
    for (const it of (Array.isArray(l.items) ? l.items : [])) {
      if (!it || typeof it !== 'object') continue
      if (items >= MAX_ITEMS) break
      const text = str(it.text)
      if (!text) continue // a row with no text is not an item
      entries.push(exportItem({ ...it, text }))
      items++
    }
    lists.push({ name: clean(l.name) || 'List', kind: clean(l.kind) || null, items: entries })
  }
  if (!lists.length) throw new Error('that export has no lists in it')

  return {
    name: clean(doc.space && doc.space.name) || 'Imported space',
    lists,
    counts: { lists: lists.length, items },
  }
}

// The filename the shell saves under. Dated, and carrying the space name so a
// folder of these is readable without opening any of them.
function backupFilename (spaceName, at) {
  const safe = clean(spaceName).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'space'
  const d = new Date(Number.isFinite(at) ? at : 0)
  const stamp = d.toISOString().slice(0, 10)
  return `pearlist-${safe}-${stamp}.json`
}

module.exports = { buildBackup, parseBackup, backupFilename, KIND, VERSION, MAX_LISTS, MAX_ITEMS }
