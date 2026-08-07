// "Clear when checked". The interesting part is not "delete when ticked off" - it
// is everything the rule REFUSES to delete, because this is the one tap in the app
// that destroys shared data. Each exception below exists for its own reason and
// each would be silent if it regressed: a chore list quietly empties, or turning
// the setting on wipes what was already checked.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { shouldClear } = require('../src/clearOnChecked.js')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
// The whole function body, not a fixed-size slice - the lesson from the four pins
// audited in test/settingsSections.test.js.
function fnBody (src, name) {
  const at = src.indexOf(`function ${name} (`)
  assert.ok(at > 0, `${name} still exists`)
  const end = src.indexOf('\n  }\n', at)
  return src.slice(at, end > 0 ? end : undefined)
}

test('ticking an item off clears it when the setting is on', () => {
  assert.equal(shouldClear({ on: true, checked: true, listKind: 'shopping' }), true)
  assert.equal(shouldClear({ on: true, checked: true, listKind: 'todo' }), true)
  assert.equal(shouldClear({ on: true, checked: true, listKind: 'note' }), true)
  // No kind at all (an older row, or a list still loading) behaves like any other
  // non-chore list rather than throwing.
  assert.equal(shouldClear({ on: true, checked: true, listKind: undefined }), true)
})

test('the default is off, and off means nothing changes', () => {
  assert.equal(shouldClear({ on: false, checked: true, listKind: 'shopping' }), false)
  assert.equal(shouldClear({}), false)
})

test('unchecking never deletes', () => {
  // The rule fires on the transition INTO checked. This is also what stops a
  // settings change from destroying data: items already checked when the setting
  // goes on are never re-evaluated, only the next tick is.
  assert.equal(shouldClear({ on: true, checked: false, listKind: 'shopping' }), false)
})

test('chore lists are left alone', () => {
  // Chores are recurring and parent-owned, and Reset re-opens them for next week.
  // Clearing them would mean retyping the chores every time a child ticked one off.
  assert.equal(shouldClear({ on: true, checked: true, listKind: 'chore' }), false)
})

// SOURCE-SHAPE PINS, as PROPERTIES not spellings.

test('the setting is remembered across launches and defaults off', () => {
  const src = app()
  assert.match(src, /CLEAR_ON_CHECKED_KEY/, 'there is a persistence key')
  assert.match(src, /function loadClearOnChecked/, 'read on mount')
  assert.match(src, /function saveClearOnChecked/, 'written on toggle')
  // A missing key must read as OFF. Anything else turns an update into a behaviour
  // change nobody asked for, on the one setting that deletes things.
  assert.match(src, /function loadClearOnChecked[^\n]*=== '1'/,
    'an unset key is off, not on')
})

test('the decision is the module, not a condition inlined in the toggle', () => {
  const src = app()
  assert.match(src, /shouldClear/, 'App.jsx uses the shared rule')
  const body = fnBody(src, 'toggleItem')
  assert.match(body, /shouldClear\(/, 'the item toggle asks it')
  assert.match(body, /item:delete/, 'and deletes through the ordinary delete method')
})

test('a cleared item is undoable, like a swipe-delete', () => {
  // Three seconds of undo is the whole safety net for a destructive tap, and the
  // toast already exists. Restoring UNCHECKED is the point: you cleared the wrong
  // item, so what you want back is something still to buy.
  const body = fnBody(app(), 'toggleItem')
  assert.match(body, /setPendingUndo\(/, 'the undo toast is armed')
  assert.match(body, /checked: false/, 'and the restored item is not checked again')
})

test('the settings page carries the switch', () => {
  const src = app()
  const at = src.indexOf('function ProfileView ')
  const body = src.slice(at, src.indexOf('\nfunction ', at + 1))
  assert.match(body, /title='Clear when checked'/, 'the row is on the page')
  assert.match(body, /clearOnChecked/, 'wired to the setting')
  // Every row on that page explains itself through the About sheet, and this one
  // has the most to explain: it is permanent and it is not just your phone.
  assert.match(body, /ABOUT\['Clear when checked'\]/, 'with an explanation')
  const about = src.slice(src.indexOf('const ABOUT = {'))
  const copy = (about.match(/'Clear when checked': "([^"]*)"/) || [, ''])[1]
  assert.ok(/everyone/.test(copy), 'the copy says it affects everyone, not just this phone')
  assert.ok(/undo/i.test(copy), 'and that there is an undo')
  assert.doesNotMatch(copy, /—/, 'no em dashes in user-facing copy')
})
