// Turning a prefix plus an error into one properly-formed sentence for a user.
//
// The app used to build these by hand as `'Could not join: ' + e.message`, which
// produced "Could not join: that does not look like an invite link" - a sentence
// that starts capitalised, then does not. Fixing it at every call site would
// have meant capitalising errors at the point they are THROWN, and most of them
// are thrown in the worklet (listMethods.js) where they are technical strings
// with other readers: logs, traces, and callers that match on them. Capitalising
// at the point of DISPLAY fixes the whole class without touching any of that.
//
// Rules, deliberately few:
//   - the prefix is capitalised and stripped of trailing punctuation
//   - the message is capitalised and given a full stop if it lacks one
//   - the two are joined with '. ', not ': ', so each half is a real sentence
//   - a missing or empty message degrades to just the prefix, never "Prefix. ."
//
// Its own module so the formatting is unit-tested rather than eyeballed across
// ~18 call sites, same reasoning as syncStatus.js.

// Capitalise the first character, leaving the rest alone. NOT a title-caser and
// not a lower-caser: "That is a space invite" and "PearList could not start"
// must both survive unchanged, and so must an all-caps acronym mid-string.
function sentence (text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return ''
  return s[0].toUpperCase() + s.slice(1)
}

// Add a full stop unless the text already ends in terminal punctuation. Ellipses
// are left alone: "Linking…" is a status, not a sentence needing a stop.
function terminated (text) {
  const s = sentence(text)
  if (!s) return ''
  return /[.!?…]$/.test(s) ? s : s + '.'
}

// `problem('Could not join', err)` -> "Could not join. That does not look like an
// invite link." Takes an Error, a string, or anything with a .message.
function problem (prefix, err) {
  const head = sentence(prefix).replace(/[\s.:;,-]+$/, '')
  // Objects contribute ONLY their .message. Falling back to String(err) for an
  // object renders "[object Object]" in front of a user, which is worse than
  // saying nothing - a rejection carrying a bare {} should degrade to the prefix.
  const raw = err == null ? '' : typeof err === 'object' ? (err.message || '') : err
  const body = terminated(raw)
  if (!head) return body
  if (!body) return terminated(head)
  return head + '. ' + body
}

module.exports = { sentence, terminated, problem }
