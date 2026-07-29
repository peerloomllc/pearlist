// Pins how a failure is worded for a user.
//
// The app used to build these as `'Could not join: ' + e.message`, which rendered
// "Could not join: that does not look like an invite link" - capitalised, then
// not. Formatting at DISPLAY time rather than at the throw is deliberate: most of
// these errors originate in the worklet, where they are technical strings that
// logs and callers also read.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { sentence, terminated, problem } = require('../src/userText.js')

test('sentence capitalises the first character and nothing else', () => {
  assert.equal(sentence('that file is empty'), 'That file is empty')
  assert.equal(sentence('  padded  '), 'Padded')
  // Must not lower-case the rest: acronyms and product names have to survive.
  assert.equal(sentence('PearList could not start'), 'PearList could not start')
  assert.equal(sentence('GIF is too large'), 'GIF is too large')
  assert.equal(sentence('already capital'), 'Already capital')
})

test('sentence is safe on empty and non-string input', () => {
  for (const bad of ['', '   ', null, undefined]) assert.equal(sentence(bad), '')
  assert.equal(sentence(42), '42')
})

test('terminated adds a full stop only when one is needed', () => {
  assert.equal(terminated('that file is empty'), 'That file is empty.')
  assert.equal(terminated('That file is empty.'), 'That file is empty.')
  assert.equal(terminated('Really?'), 'Really?')
  assert.equal(terminated('Stop!'), 'Stop!')
  // An ellipsis is a status, not a sentence wanting a stop.
  assert.equal(terminated('Linking…'), 'Linking…')
  assert.equal(terminated(''), '')
})

test('problem joins prefix and message as two sentences', () => {
  assert.equal(
    problem('Could not join', new Error('that does not look like an invite link')),
    'Could not join. That does not look like an invite link.'
  )
  // Accepts a bare string as well as an Error.
  assert.equal(problem('Could not save', 'disk full'), 'Could not save. Disk full.')
})

test('problem strips punctuation the caller left on the prefix', () => {
  for (const p of ['Could not join', 'Could not join:', 'Could not join: ', 'Could not join.']) {
    assert.equal(problem(p, new Error('nope')), 'Could not join. Nope.')
  }
})

// A worklet error with no message, or a rejection carrying nothing useful, must
// not render as "Could not leave. ." - the prefix alone is a complete thought.
test('problem degrades to the prefix when there is no message', () => {
  assert.equal(problem('Could not leave', new Error('')), 'Could not leave.')
  assert.equal(problem('Could not leave', null), 'Could not leave.')
  assert.equal(problem('Could not leave', undefined), 'Could not leave.')
  assert.equal(problem('Could not leave', {}), 'Could not leave.')
})

test('problem with no prefix still returns a formed sentence', () => {
  assert.equal(problem('', new Error('something broke')), 'Something broke.')
})

// The guard against regressing to hand-built strings. This is the shape that
// caused the original inconsistency, and it is easy to reintroduce.
test('App.jsx does not hand-build "prefix: " + message strings', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/ui/App.jsx'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
  const handBuilt = src.match(/'[^']*: '\s*\+\s*(e\.message|\(e\?\.message)/g) || []
  assert.deepEqual(handBuilt, [], 'route user-facing failures through problem() instead')
})
