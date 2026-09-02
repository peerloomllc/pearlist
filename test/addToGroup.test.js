// THE "+" ON A GROUP HEADER, which files an item as it is typed instead of
// leaving it to be classified and then dragged back.
//
// Two halves are tested two different ways, on purpose:
//
//  - The decision (which category a new item is written with) is pure, lives in
//    src/addToGroup.js and is exercised directly. It is the part with rules.
//  - The wiring inside App.jsx is pinned as PROPERTIES, per the convention in
//    test/noSpaceState.test.js and test/settingsSections.test.js: that the header
//    offers the button at all, that the composer says where the item is going,
//    and that the write goes down the same signed path a drag already uses. A
//    pinned SPELLING would break on the next legitimate edit.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { pinnedCategory, addCategory } = require('../src/addToGroup')
const { FALLBACK } = require('../src/aisles')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
function componentBody (src, name) {
  const at = src.indexOf(`function ${name} (`)
  assert.ok(at > 0, `${name} still exists`)
  const end = src.indexOf('\n}\n', at)
  return src.slice(at, end > 0 ? end : undefined)
}

test('a tapped group is what the item is filed under', () => {
  assert.equal(addCategory({ aisle: 'Produce', isGrocery: true }), 'Produce')
  assert.equal(addCategory({ aisle: 'Snacks', isGrocery: true }), 'Snacks')
  // Non-grocery lists have no built-in taxonomy; a user-made section is still a
  // section and is written the same way.
  assert.equal(addCategory({ aisle: 'Garage', isGrocery: false }), 'Garage')
})

test("the group the user tapped beats what the app learned", () => {
  // The learned override is a guess about text typed into the ordinary composer.
  // A tap on the Produce header a second ago is not a guess.
  assert.equal(addCategory({ aisle: 'Produce', isGrocery: true, override: 'Frozen' }), 'Produce')
  // With no tap, the override still decides, exactly as it did before the "+".
  assert.equal(addCategory({ isGrocery: true, override: 'Frozen' }), 'Frozen')
  assert.equal(addCategory({ isGrocery: true }), null)
})

test("'Other' is a real aisle on a grocery list and only there", () => {
  // Groceries: pin it, or ai:categorizeList files the item somewhere else and the
  // user has to drag it back - the whole thing this feature exists to avoid.
  assert.equal(addCategory({ aisle: FALLBACK, isGrocery: true }), FALLBACK)
  assert.equal(pinnedCategory(FALLBACK, true), FALLBACK)
  // Every other kind of list: the fallback group means "no section", so nothing
  // is written, and no learned override may quietly re-file it either.
  assert.equal(addCategory({ aisle: FALLBACK, isGrocery: false }), null)
  assert.equal(addCategory({ aisle: FALLBACK, isGrocery: false, override: 'Garage' }), null)
  assert.equal(pinnedCategory(FALLBACK, false), null)
})

test('no group tapped is the ordinary add, unchanged', () => {
  assert.equal(addCategory(), null)
  assert.equal(addCategory({ aisle: null, isGrocery: true }), null)
  assert.equal(pinnedCategory(null, true), null)
})

test('every group header offers the "+", labelled with its own group', () => {
  const body = componentBody(app(), 'AisleGroupedItems')
  assert.match(body, /onAddTo\(aisle\)/, 'the grouped view takes an add-to-this-group handler')
  // Inside the header block, next to the collapse toggle and the drag handle.
  const header = body.slice(body.indexOf('data-aisle-header'))
  assert.match(header, /aria-label=\{`Add to \$\{label\}`\}/,
    'the header renders a control that names the group it adds to')
  // A long-press on a header starts a drag; the tap that ends it must not also
  // fire the "+", the same guard the collapse toggle uses.
  assert.match(header, /didDrag\?\.\(\)/, 'a drag that ends over the "+" does not add')
})

test('the composer says which group the next item is going into', () => {
  const body = componentBody(app(), 'ComposerBar')
  assert.match(body, /\{into \?/, 'the composer takes the aimed-at group')
  assert.match(body, /into\.onClear/, 'and the user can back out of it without adding')
})

test('a pinned add is written down the same signed path a drag uses', () => {
  const src = app()
  const at = src.indexOf('async function fileInto (')
  assert.ok(at > 0, 'the pinned add has one place it writes from')
  const body = src.slice(at, src.indexOf('\n  }\n', at))
  assert.match(body, /addCategory\(/, 'it asks the pure rule which category to write')
  // by: 'user' sets catBy, which is what stops the keyword classifier re-sorting
  // the item afterwards. Without it the pin would not survive the next load.
  assert.match(body, /'ai:setCategory'/, 'the same synced method the drag calls')
  assert.match(body, /by: 'user'/, "pinned as a user choice, so nothing re-sorts it")
})

test('the aim is momentary: it clears on add and on leaving the list', () => {
  const src = app()
  // Cleared when the item is added...
  const add = src.slice(src.indexOf('async function addItemText ('))
  assert.match(add.slice(0, 900), /setAddTo\(null\)/, 'adding an item clears the aim')
  // ...and when the list is closed, so it cannot leak into the next list opened.
  assert.match(src, /useEffect\(\(\) => \{ setAddTo\(null\) \}, \[openListId\]\)/,
    'closing the list clears the aim')
})
