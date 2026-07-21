// PearList note lists: the pure text <-> row plumbing.
//
// A note (a list with kind 'note') is NOT one blob of text. Its body is stored
// as one ordinary `item:` row per LINE, and this module is the whole translation
// layer between "a textarea full of text" and "a set of signed rows".
//
// WHY LINES AND NOT ONE FIELD (proposals/2026-07-20-note-lists.md). Every row in
// this app is last-writer-wins (see rowApplyDecision in listWire.js). A note kept
// as a single `body` string on the list row makes the unit of conflict the ENTIRE
// document, so two people editing the same note at once means the later save
// silently erases the earlier one's paragraphs. A shared household note is
// precisely the thing two people type into simultaneously. One row per line keeps
// LWW but shrinks the conflict unit back to a line, which is the same exposure a
// checklist item already has and which users already tolerate. Only a genuine
// same-line collision can now lose text.
//
// WHY THE `item:` NAMESPACE. applyListOp drops any key outside NAMESPACES, so a
// dedicated `para:` prefix would make an old peer SKIP the op while a new peer
// put()s it. Divergent views, and Autobase indexers sign the view, so a released
// space would fork. Note lines therefore ride the existing item rows, reusing
// `text` and leaving qty/checked/assignee/category at their defaults.
//
// Everything here is pure, so it unit-tests without standing up an Autobase, the
// same way listWire.js does.

// --- ordering ---------------------------------------------------------------
//
// Item order elsewhere in the app is a DEVICE-LOCAL preference (`itemOrder`, the
// 2026-07-11 hybrid decision) with createdAt as the shared fallback. That is fine
// for a shopping list and wrong for a note, where inserting a line in the middle
// must look the same on every device. So note rows carry `ord`: a fractional
// index, an ASCII-sortable string chosen to sit strictly between its neighbours.
//
// The point of a fractional index is that inserting a line touches ONE row. The
// obvious alternative - an integer position on every row, renumbered on insert -
// would rewrite every row in the note on every save, which is exactly the
// whole-document clobber the line split exists to avoid.
//
// `ord` is optional and additive: an old peer ignores it and keeps sorting by
// createdAt, so a mid-note insert can look out of order there until it upgrades.
// Cosmetic, and it self-corrects.

// ASCII-ordered, so plain string comparison IS the sort order.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
// The middle digit. Also the ord of the first line of a fresh note, so a note
// grows in both directions without ever needing to renumber.
const MID = DIGITS[Math.round(BASE / 2)]

// The string strictly between `a` and `b`, treating each as a base-62 fraction.
// `a` is '' for "before everything", `b` is null for "after everything".
// Invariant it both requires and preserves: an ord never ends in the zero digit
// (otherwise there is no room left below it).
function midpoint (a, b) {
  if (b !== null && a >= b) throw new Error('midpoint: ' + a + ' >= ' + b)
  if (b !== null) {
    // Skip a shared prefix and solve the remainder, e.g. midpoint('49','5') is
    // '4' + midpoint('9', null).
    let n = 0
    while (n < b.length && (a[n] || '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : BASE
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]
  // The first digits are adjacent, so there is no room at this depth: borrow one.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

// Safe public wrapper. Never throws: a corrupt or out-of-order neighbour (an ord
// written by something that did not respect the invariant) falls back to "sit
// just after `prev`", which is always a valid, larger string.
function ordBetween (prev, next) {
  const a = typeof prev === 'string' ? prev : ''
  const b = (typeof next === 'string' && next) ? next : null
  if (b !== null && !(a < b)) return a + MID
  try { return midpoint(a, b) } catch { return a + MID }
}

// Rows with no ord sort after rows with one: an old peer (or the generic list UI)
// can add an item to a note list without one, and it has to land somewhere
// defined. createdAt then id break ties, so two peers that concurrently insert at
// the same spot - computing the SAME midpoint - still converge on one order.
const ORD_LAST = '￿'
function ordOf (row) { return (row && typeof row.ord === 'string' && row.ord) ? row.ord : ORD_LAST }
function compareNoteRows (x, y) {
  const ox = ordOf(x)
  const oy = ordOf(y)
  if (ox !== oy) return ox < oy ? -1 : 1
  const cx = (x && x.createdAt) || 0
  const cy = (y && y.createdAt) || 0
  if (cx !== cy) return cx - cy
  const ix = String((x && x.id) || '')
  const iy = String((y && y.id) || '')
  return ix < iy ? -1 : (ix > iy ? 1 : 0)
}
function sortNoteRows (rows) { return (rows || []).slice().sort(compareNoteRows) }

// --- text <-> lines ---------------------------------------------------------

// Bounds, so a stray paste cannot turn one save into thousands of signed rows.
// The per-line cap matches the existing item `note` field cap in listMethods.js.
const MAX_LINES = 1000
const MAX_LINE_CHARS = 2000

function splitLines (text) {
  const s = String(text == null ? '' : text)
  return s === '' ? [] : s.split('\n')
}
function joinLines (lines) { return (lines || []).join('\n') }
function clampLines (lines) {
  return (lines || []).slice(0, MAX_LINES).map((l) => String(l == null ? '' : l).slice(0, MAX_LINE_CHARS))
}

// The note's text as it should appear in the editor, from its rows.
function noteTextOf (rows) { return joinLines(sortNoteRows(rows).map((r) => String((r && r.text) || ''))) }

// --- diff -------------------------------------------------------------------

// Longest common subsequence over two arrays of lines, returned as matched index
// pairs. Anything not matched is a change block, paired up positionally by the
// caller so that EDITING a line updates its existing row (keeping its identity
// and its ord) instead of deleting and re-adding it.
//
// Quadratic, so it is capped. Past the cap every line counts as changed and the
// positional pairing still produces a correct note, just with less row reuse.
const LCS_CELL_CAP = 250000
function lcsPairs (a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n * m > LCS_CELL_CAP) return []
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) i++
    else j++
  }
  return out
}

// The three-way merge, and the reason a save cannot clobber a peer.
//
//   baseline    - the rows as this editor LOADED them: [{ id, text }]
//   lines       - what the user has now typed, split to lines
//   currentRows - the note's rows as they are RIGHT NOW, re-read at save time
//
// Operations are derived from `baseline -> lines` and applied to `currentRows`.
// A line a peer added while I was typing is not in my baseline, so nothing in my
// plan refers to it and my save cannot tombstone it. That is the entire point of
// diffing rather than writing the textarea over the top of whatever is there.
//
// Returns { updates: [{ id, text }], deletes: [id], inserts: [{ text, ord }] }.
function planNoteSave (baseline, lines, currentRows) {
  const given = (baseline || []).filter((b) => b && typeof b.id === 'string')
  const next = clampLines(lines)

  const cur = new Map()
  for (const row of (currentRows || [])) {
    if (row && typeof row.id === 'string' && !row.deleted) cur.set(row.id, row)
  }

  // The baseline is supposed to arrive in DOCUMENT order. If it does not - say a
  // caller passes item:getAll's output straight through, which comes back in
  // Hyperbee key order - the diff below degenerates into "delete every line, then
  // re-insert every line". No text is lost, but every row is rewritten and every
  // line loses its identity and its ord, which is exactly what this design exists
  // to avoid. It would also be silent.
  //
  // The stored ords ARE the document order and never change once assigned, so
  // whenever every baseline line still resolves to a stored row we can just
  // re-derive the order rather than trust the caller.
  const resolved = given.map((b) => cur.get(b.id))
  const base = resolved.every((row) => row && typeof row.ord === 'string' && row.ord)
    ? given.slice().sort((x, y) => compareNoteRows(cur.get(x.id), cur.get(y.id)))
    : given

  const seq = []      // the note's final line order: { id } or { text, isNew: true }
  const updates = []
  const deletes = []

  // One change block: baseline[b0,b1) went away, next[n0,n1) arrived. Pair them
  // positionally so an in-place edit reuses its row; the surplus on either side
  // is a real insert or a real delete.
  const flush = (b0, b1, n0, n1) => {
    const dels = base.slice(b0, b1)
    const ins = next.slice(n0, n1)
    const paired = Math.min(dels.length, ins.length)
    for (let k = 0; k < paired; k++) {
      updates.push({ id: dels[k].id, text: ins[k] })
      seq.push({ id: dels[k].id })
    }
    for (let k = paired; k < ins.length; k++) seq.push({ text: ins[k], isNew: true })
    for (let k = paired; k < dels.length; k++) deletes.push(dels[k].id)
  }

  let bi = 0
  let ni = 0
  for (const [pi, pj] of lcsPairs(base.map((b) => String(b.text || '')), next)) {
    flush(bi, pi, ni, pj)
    seq.push({ id: base[pi].id })
    bi = pi + 1
    ni = pj + 1
  }
  flush(bi, base.length, ni, next.length)

  // Resolve each surviving existing line to its CURRENT ord, so inserts are
  // positioned against what is really stored, not against the stale baseline.
  const ords = seq.map((e) => (e.isNew ? null : (cur.has(e.id) ? ordOf(cur.get(e.id)) : null)))
  for (let k = 0; k < ords.length; k++) if (ords[k] === ORD_LAST) ords[k] = null

  const inserts = []
  let prev = ''
  for (let k = 0; k < seq.length; k++) {
    if (!seq[k].isNew) {
      if (ords[k] !== null) prev = ords[k]
      continue
    }
    let after = null
    for (let m = k + 1; m < seq.length; m++) {
      if (!seq[m].isNew && ords[m] !== null) { after = ords[m]; break }
    }
    const ord = ordBetween(prev, after)
    ords[k] = ord
    prev = ord
    inserts.push({ text: seq[k].text, ord })
  }

  return {
    // Drop updates whose row is gone (a peer deleted it: no-resurrection means
    // the write would be rejected anyway) or already says what we were going to
    // say (a peer made the same edit first).
    updates: updates.filter((u) => cur.has(u.id) && String(cur.get(u.id).text || '') !== u.text),
    deletes: deletes.filter((id) => cur.has(id)),
    inserts,
  }
}

module.exports = {
  DIGITS,
  MID,
  MAX_LINES,
  MAX_LINE_CHARS,
  ordBetween,
  compareNoteRows,
  sortNoteRows,
  splitLines,
  joinLines,
  clampLines,
  noteTextOf,
  planNoteSave,
}
