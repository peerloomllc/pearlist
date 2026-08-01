// SETTINGS SECTIONS COLLAPSE, like the rest of the suite.
//
// The page had grown to EIGHT static groups holding eleven rows, in an order nobody
// chose. Measured on the TCL (720x1600): "Linked devices" - pairing, the device
// roster, removal, i.e. everything the linking work built - sat BELOW THE FOLD and
// needed a scroll, while "Appearance", a single dark-mode toggle, was first.
// Collapsed, the whole page is a short list of headings and nothing is buried by
// position alone. Confirmed on the TCL: Linked devices is now on the first screen.
//
// The component already existed. `Collapsible` in this file is the suite's accordion
// (rotating caret, max-height body) and matches PearCal's and PearCircle's; the About
// page has used it all along. Settings simply never did.
//
// SOURCE-SHAPE PINS, as PROPERTIES not spellings, per test/noSpaceState.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
// ProfileView IS the settings page (it renders <FullScreen title='Settings'>).
function settingsBody (src) {
  const at = src.indexOf('function ProfileView ')
  assert.ok(at > 0, 'the settings page still exists')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

test('every settings section is collapsible, and none is a static group', () => {
  const body = settingsBody(app())
  const groups = body.match(/<Collapsible title='/g) || []
  assert.ok(groups.length >= 8, `all sections collapse (found ${groups.length})`)
  // The static Group component is gone. Left behind it would be dead code that the
  // next section quietly gets added to, undoing this one row at a time.
  assert.doesNotMatch(app(), /^function Group \(/m, 'the old static group is removed')
  assert.doesNotMatch(body, /<Group /, 'and nothing still renders one')
})

test('the open sections are remembered across launches', () => {
  const src = app()
  // Purely presentational and device-local, like the aisle view state. Settings is a
  // place you come back to; re-collapsing everything on every visit would make the
  // change a net loss for anyone who uses one section often.
  assert.match(src, /SETTINGS_OPEN_KEY/, 'there is a persistence key')
  assert.match(src, /function loadSettingsOpen/, 'read on mount')
  assert.match(src, /function saveSettingsOpen/, 'written on toggle')
  const body = settingsBody(src)
  assert.match(body, /useState\(loadSettingsOpen\)/, 'the page seeds its state from it')
  assert.match(body, /saveSettingsOpen\(next\)/, 'and persists every toggle')
})

test('sections open independently, unlike the About accordion', () => {
  const body = settingsBody(app())
  // About keeps exactly one section open (`section === 'how'`), which suits a document
  // read top to bottom. Settings is a workbench: closing Notifications because you
  // opened Backup is the kind of small rudeness that makes a page feel like it is
  // fighting you. So the state is a MAP of open flags, not a single current section.
  assert.match(body, /\[openSections, setOpenSections\]/, 'state is a set of sections')
  assert.match(body, /\{ \.\.\.cur, \[key\]: !cur\[key\] \}/,
    'a toggle flips one key and leaves the others alone')
})

test('sections whose content grows pass their own maxHeight', () => {
  const src = app()
  const body = settingsBody(src)
  // maxHeight is the animation bound AND a clip: content past it is cut off. 600 suits
  // prose, but Linked devices grows with every phone paired and Notifications with the
  // daily-reminder controls. A section silently losing its last row at seven devices
  // would be a miserable bug to track down.
  assert.match(body, /<Collapsible title='Linked devices'[^>]*maxHeight=/, 'devices sets one')
  assert.match(body, /<Collapsible title='Notifications'[^>]*maxHeight=/, 'notifications too')
  assert.match(src, /function Collapsible \(\{ title, open, onToggle, maxHeight = 600/,
    'and the component takes it, defaulting as PearCal does')
  // The prop must actually reach the body, not just sit in the signature.
  const at = src.indexOf('function Collapsible (')
  assert.match(src.slice(at, at + 900), /maxHeight: open \? maxHeight : 0/,
    'the clip uses the prop rather than a hardcoded 600')
})

test('nothing is expanded by default, which is the whole point', () => {
  const src = app()
  // loadSettingsOpen returns {} on a fresh device, so every `open` is false. If a
  // future change seeds some sections open, the page grows again and Linked devices
  // goes back below the fold - the exact thing this fixed.
  assert.match(src, /function loadSettingsOpen \(\) \{[^}]*\|\| '\{\}'/,
    'the stored default is an empty set of open sections')
})
