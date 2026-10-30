// How a list looks on the Lists page: its card colour, whether it is pinned and
// its labels (proposals/2026-10-29-keep-style-notes.md). All three ride the shared
// `list:` row as plain signed fields, so every member sees the same ones.
//
// Additive, like `category` on items: applyListOp stores rows verbatim and every
// list:* method spreads the existing row, so an older build keeps both fields when
// it changes a list and simply does not show them. That also means a row can carry
// anything a peer wrote, so everything here is read through these normalizers and
// never trusted as stored.

const LIST_COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple']

function normalizeColor (v) {
  return LIST_COLORS.includes(v) ? v : 'default'
}

function isPinned (list) {
  return !!list && list.pinned === true
}

const LABELS_MAX = 10
const LABEL_MAX_LEN = 30

// A list's labels: trimmed, inner spaces squashed, cut to LABEL_MAX_LEN, the same
// name twice (ignoring case) kept once, at most LABELS_MAX.
function normalizeLabels (v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = x.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LEN).trim()
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
    if (out.length >= LABELS_MAX) break
  }
  return out
}

// Every label used in a space, A to Z. Two spellings that differ only in case
// show once, as the first one met.
function spaceLabels (lists) {
  const byKey = new Map()
  for (const l of lists || []) {
    if (!l || l.deleted) continue
    for (const s of normalizeLabels(l.labels)) if (!byKey.has(s.toLowerCase())) byKey.set(s.toLowerCase(), s)
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

// True when the list carries every one of `wanted` (ignoring case). No labels
// wanted matches every list.
function hasLabels (list, wanted) {
  if (!wanted || !wanted.length) return true
  const have = new Set(normalizeLabels(list && list.labels).map((s) => s.toLowerCase()))
  return wanted.every((w) => have.has(String(w).toLowerCase()))
}

module.exports = { LIST_COLORS, normalizeColor, isPinned, LABELS_MAX, LABEL_MAX_LEN, normalizeLabels, spaceLabels, hasLabels }
