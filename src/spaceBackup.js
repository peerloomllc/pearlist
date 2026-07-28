// Backup export / import: the pure half.
//
// WHY IT EXISTS. Everything in PearList lives in one place - the household's own
// phones - and there is no server to fall back on. Two ways that bites:
//   - a phone dies, or is wiped, and its lists are the only copy on that device.
//   - a device that joined a space but was never admitted holds a space it cannot
//     read, cannot write and (until 2026-07-28) could not even leave.
// A file is the escape hatch for both, and unlike everything else here it needs no
// peer to be reachable.
//
// EVERY SPACE, not the one on screen. "Back up my lists" means the phone, not
// whichever space happens to be selected - a one-space file silently leaves the
// others unprotected, and the person who finds that out is the one whose phone has
// already died. (Tim's call, 2026-07-28, correcting the first cut.)
//
// DELIBERATELY UNSIGNED, unlike PearGuard's device-backup. That file carries an
// IDENTITY, so a signature is what stops someone restoring themselves as you.
// This one carries no authority at all: importing writes BRAND NEW spaces that
// this device founds and signs, so a signature could only ever refuse an import,
// never grant one. What it would cost is real - a rescue file you cannot open in a
// text editor and fix by hand is a worse rescue file.
//
// WHAT IS AND IS NOT CARRIED. The shape and state of the lists, not the household:
// no identities, no writer keys, no invites, no member rosters. `assignee` is
// dropped on purpose - it names a pubkey that does not exist in the new space, so
// carrying it would render as a permanently unknown person.
//
// REMINDERS ARE DROPPED, all three kinds and each for its own reason. An item's
// `remindAt` is an absolute instant, so restoring a month-old file would hand the
// OS a pile of past-dated reminders to fire in a burst or discard - re-setting one
// you still want is a tap. The daily nudge and the notification toggles were never
// in here to drop: they are device-local shell settings, not space data.
//
// A recurring chore's CYCLE is not a reminder and is carried: see lastDoneAt in
// exportItem.

// FIELD AUDIT (2026-07-28). Every field applyListOp accepts on a list or item
// row, and the decision for each. Two omissions in the first cut were found by
// writing this out rather than by anyone noticing: `repeat` (guarded on the wrong
// type, so recurring chores were never carried) and `notifyOnComplete`. Keep this
// table in step with the row shapes at the top of listWire.js - a field added
// there and not decided here is dropped silently, which is exactly the failure
// mode this exists to prevent.
//
// ITEM ROW
//   text, qty, checked, category, ord, note, url   CARRY - the item itself
//   catBy                                          CARRY - pins a hand-chosen aisle
//   repeat, lastDoneAt                             CARRY - the chore and its cycle
//   assignee                                       DROP  - a pubkey with no meaning
//                                                          in a space that has one
//                                                          member: the importer
//   remindAt, remindBy                             DROP  - absolute time + identity
//   id, listId                                     DROP  - regenerated on import
//   createdBy, pubkey, updatedAt                   DROP  - identity / signing
//   createdAt                                      DROP  - deliberately. It is the
//                                                          tie-break for item order,
//                                                          and the import writes in
//                                                          file order with a stable
//                                                          sort, so the original
//                                                          order survives anyway
//   deleted                                        DROP  - tombstones are not exported
//
// LIST ROW
//   name, kind                                     CARRY
//   notifyOnComplete                               CARRY - the user chose it
//   assignee                                       DROP  - as above
//   id, createdBy, createdAt, pubkey, updatedAt    DROP  - as above
//   deleted                                        DROP  - not exported
//
// SPACE ROW
//   name                                           CARRY - as the space's name
//   owner                                          DROP  - the importer becomes owner
//   evicted, revokeV1                              DROP  - membership and trust state
//                                                          about people who are not
//                                                          in the new space
//
// MEMBER ROWS are not exported at all: they are the household, not the lists.

const KIND = 'pearlist-backup'
// The one-space shape this replaced (`kind: 'pearlist-space'`) never shipped, but
// reading it is a few lines and the format is meant to be forgiving.
const KIND_LEGACY_SINGLE = 'pearlist-space'
const VERSION = 1

// Bounds. An import writes one signed op per row into a live Autobase, so a
// hand-edited or hostile file must not be able to ask for unbounded work.
const MAX_SPACES = 50
const MAX_LISTS = 200   // per space
const MAX_ITEMS = 5000  // across the whole file

const str = (v) => typeof v === 'string' ? v : ''
const clean = (v) => str(v).trim()

// One item, reduced to what survives the trip. Mirrors template:save's entry
// shape plus the state a backup (unlike a template) is expected to keep.
function exportItem (row) {
  const out = { text: str(row.text) }
  if (Number.isFinite(row.qty) && row.qty !== 1) out.qty = row.qty
  if (row.checked === true) out.checked = true
  if (clean(row.category)) out.category = clean(row.category)
  // Marks an aisle the USER chose by hand rather than one the keyword pass
  // guessed. It is a pin: the auto-categorizer skips catBy:'user' items. Carrying
  // `category` without it restored the aisle but not the decision, so a later
  // pass could quietly move an item the user had deliberately filed. (Audit,
  // 2026-07-28. template:save has always carried it; the backup had not.)
  if (clean(row.catBy)) out.catBy = clean(row.catBy)
  if (clean(row.ord)) out.ord = clean(row.ord)
  if (clean(row.note)) out.note = clean(row.note)
  if (clean(row.url)) out.url = clean(row.url)
  // A STRING - 'daily' | 'weekly' | 'monthly' (listWire REPEAT_KINDS), not an
  // object. The first cut guarded on `typeof === 'object'`, so recurring chores
  // were silently never carried; the round-trip test added 2026-07-28 is what
  // caught it. Left permissive here on purpose: the import side already runs
  // normalizeRepeat, so an unknown value is rejected in exactly one place.
  if (clean(row.repeat)) out.repeat = clean(row.repeat)
  // The done-state of a RECURRING item, and the one field that decides it. For a
  // repeating item `checked` is ignored entirely - effectiveChecked derives it
  // from lastDoneAt against the current period - so carrying `checked` without
  // this made every chore come back due, however recently it was done. Dropping
  // it was accidental, not a decision (found 2026-07-28 when Tim asked whether
  // reminders were in the backup).
  //
  // Unlike remindAt this is safe to carry across time: it is a record of when
  // something WAS done, not an instruction to fire at an absolute moment, so a
  // stale one simply reads as "that period has passed" and the chore is due again.
  if (Number.isFinite(row.lastDoneAt)) out.lastDoneAt = row.lastDoneAt
  return out
}

// Shared by the writer and the reader, so a file we emit and a file someone
// hand-edited go through exactly the same shaping and the same caps. `budget` is
// the remaining whole-file item allowance, spent as it goes.
function takeLists (lists, budget) {
  const out = []
  for (const l of (lists || [])) {
    if (!l || typeof l !== 'object') continue
    if (out.length >= MAX_LISTS) break
    const entries = []
    for (const it of (Array.isArray(l.items) ? l.items : [])) {
      if (!it || typeof it !== 'object') continue
      if (budget.left <= 0) break
      const text = str(it.text)
      if (!text) continue // a row with no text is not an item
      entries.push(exportItem({ ...it, text }))
      budget.left--
    }
    // notifyOnComplete ('off' | 'each' | 'done') is a setting the user chose for
    // this list, not identity and not time-bound, so it belongs in a backup.
    // Missed in the first cut; found by the 2026-07-28 field audit.
    out.push({
      name: clean(l.name) || 'List',
      kind: clean(l.kind) || null,
      ...(clean(l.notifyOnComplete) ? { notifyOnComplete: clean(l.notifyOnComplete) } : {}),
      items: entries,
    })
  }
  return out
}

// `spaces` is [{ name, lists: [{ name, kind, items: [row] }] }] straight off the
// views.
function buildBackup ({ spaces, exportedAt }) {
  const budget = { left: MAX_ITEMS }
  const out = []
  for (const s of (spaces || [])) {
    if (out.length >= MAX_SPACES) break
    out.push({ name: clean(s && s.name) || 'Space', lists: takeLists(s && s.lists, budget) })
  }
  return {
    kind: KIND,
    version: VERSION,
    exportedAt: Number.isFinite(exportedAt) ? exportedAt : 0,
    spaces: out,
  }
}

// Parse + validate a file a human may have edited. Throws with a message meant
// for a person, because it is shown to one: "that file is not a PearList backup"
// is actionable, a JSON syntax error dump is not.
function parseBackup (jsonString) {
  let doc
  try {
    doc = JSON.parse(String(jsonString ?? ''))
  } catch {
    throw new Error('that file is not readable as JSON')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('that file is not a PearList backup')
  const legacy = doc.kind === KIND_LEGACY_SINGLE
  if (doc.kind !== KIND && !legacy) throw new Error('that file is not a PearList backup')
  // Forward-compatible on purpose: a NEWER file is refused with a clear reason
  // rather than half-imported, because we cannot know what we would be dropping.
  if (!Number.isFinite(doc.version) || doc.version > VERSION) throw new Error('that backup was made by a newer version of PearList')

  // A legacy one-space file is simply a backup with a single space in it.
  const raw = legacy ? [{ name: doc.space && doc.space.name, lists: doc.lists }] : doc.spaces
  if (!Array.isArray(raw)) throw new Error('that backup has nothing in it')

  const budget = { left: MAX_ITEMS }
  const spaces = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    if (spaces.length >= MAX_SPACES) break
    const lists = takeLists(s.lists, budget)
    if (!lists.length) continue // an empty space is not worth recreating
    spaces.push({ name: clean(s.name) || 'Imported space', lists })
  }
  if (!spaces.length) throw new Error('that backup has nothing in it')

  const lists = spaces.reduce((n, s) => n + s.lists.length, 0)
  const items = spaces.reduce((n, s) => n + s.lists.reduce((m, l) => m + l.items.length, 0), 0)
  return { spaces, counts: { spaces: spaces.length, lists, items } }
}

// The filename the shell saves under. Dated, so a folder of these is readable
// without opening any of them. No space name any more: it covers all of them.
function backupFilename (at) {
  const d = new Date(Number.isFinite(at) ? at : 0)
  return `pearlist-backup-${d.toISOString().slice(0, 10)}.json`
}

module.exports = { buildBackup, parseBackup, backupFilename, KIND, KIND_LEGACY_SINGLE, VERSION, MAX_SPACES, MAX_LISTS, MAX_ITEMS }
