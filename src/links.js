// Finding web links in free text (notes, item text and item notes), so the UI can
// make them tappable. Matches http(s):// and bare www. addresses. Trailing
// punctuation that usually ends a sentence is left out of the link, and a closing
// bracket is kept only when the link itself opened one (Wikipedia-style URLs).

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
const TRAILING = /[.,;:!?'"*_~]+$/

function trimLink (raw) {
  let s = raw.replace(TRAILING, '')
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (s.endsWith(close) && s.split(close).length > s.split(open).length) {
      s = s.slice(0, -1).replace(TRAILING, '')
    }
  }
  return s
}

// The address to open: bare www. gets https:// in front.
function hrefOf (link) {
  return /^https?:\/\//i.test(link) ? link : 'https://' + link
}

// Splits text into parts, in order: { text } for plain runs and { text, href } for
// links. Joining every part's text gives back the input exactly.
function splitLinks (text) {
  const s = String(text ?? '')
  const parts = []
  let at = 0
  LINK_RE.lastIndex = 0
  let m
  while ((m = LINK_RE.exec(s))) {
    const link = trimLink(m[0])
    if (!link.replace(/^(?:https?:\/\/|www\.)/i, '')) continue
    if (m.index > at) parts.push({ text: s.slice(at, m.index) })
    parts.push({ text: link, href: hrefOf(link) })
    at = m.index + link.length
    LINK_RE.lastIndex = at
  }
  if (at < s.length) parts.push({ text: s.slice(at) })
  return parts
}

// The first link in any of the given texts, as an address to open, or null.
function firstLink (...texts) {
  for (const t of texts) {
    const p = splitLinks(t).find((x) => x.href)
    if (p) return p.href
  }
  return null
}

module.exports = { splitLinks, firstLink }
