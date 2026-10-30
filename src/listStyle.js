// How a list looks on the Lists page: its card colour and whether it is pinned
// (proposals/2026-10-29-keep-style-notes.md). Both ride the shared `list:` row as
// plain signed fields, so every member sees the same colour and pins.
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

module.exports = { LIST_COLORS, normalizeColor, isPinned }
