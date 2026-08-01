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

// A component's WHOLE body, rather than a fixed-size slice after its name.
//
// Four pins in this file's short life have broken on legitimate edits: an exact
// section count, a title that got reworded, a parameter list that gained a prop, and
// a 900-character window the component simply outgrew. Every one of them described
// the current formatting instead of the property. Slicing to the next top-level
// closing brace removes the last of those failure modes.
function componentBody (src, name) {
  const at = src.indexOf(`function ${name} (`)
  assert.ok(at > 0, `${name} still exists`)
  const end = src.indexOf('\n}\n', at)
  return src.slice(at, end > 0 ? end : undefined)
}
// ProfileView IS the settings page (it renders <FullScreen title='Settings'>).
function settingsBody (src) {
  const at = src.indexOf('function ProfileView ')
  assert.ok(at > 0, 'the settings page still exists')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

test('every settings section is collapsible, and none is a static group', () => {
  const body = settingsBody(app())
  const groups = body.match(/<Collapsible title='/g) || []
  // A LOOSE FLOOR, not an exact count. This pin asserted `>= 8` and went red the
  // moment two single-row groups were deliberately merged - a test failing because
  // the change it was written alongside did exactly what it set out to do. The
  // property worth holding is "sections exist and none of them is static"; how many
  // there are is a design decision that will move again.
  assert.ok(groups.length >= 5, `sections are collapsible (found ${groups.length})`)
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
  //
  // MATCHED ON THE SECTION KEY, not the title. The first version keyed off
  // `title='Linked devices'` and broke when the section was renamed to "You & your
  // devices" - a copy edit failing a test about clipping. `sect('devices')` is the
  // identifier; the title is prose. Same lesson as the stale "Stronger removal" pin
  // and the comment that shadowed the empty-state copy, both hit the same week.
  assert.match(body, /sect\('devices'\)[^>]*maxHeight=/, 'the devices section sets one')
  assert.match(body, /sect\('notifications'\)[^>]*maxHeight=/, 'notifications too')
  // THE DEFAULT, not the whole parameter list. This spelled out
  // `({ title, open, onToggle, maxHeight = 600` and broke when `icon` was added -
  // the third pin this week to fail because it described the current formatting
  // rather than the property. What matters is that the prop exists and defaults to
  // PearCal's 600, so the three apps' Collapsibles stay interchangeable.
  const comp = componentBody(src, 'Collapsible')
  assert.match(comp, /maxHeight = 600/, 'the component takes it, defaulting as PearCal does')
  // The prop must actually reach the body, not just sit in the signature.
  assert.match(comp, /maxHeight: open \? maxHeight : 0/,
    'the clip uses the prop rather than a hardcoded 600')
})

test('every section carries an icon, as the sibling apps do', () => {
  const src = app()
  const body = settingsBody(src)
  const titles = body.match(/<Collapsible title='[^']*'/g) || []
  const withIcon = body.match(/<Collapsible title='[^']*' icon=\{/g) || []
  assert.equal(withIcon.length, titles.length,
    `every settings section passes an icon (${withIcon.length} of ${titles.length})`)

  // The prop NAME matters as much as its presence: PearCal and PearCircle both pass
  // `icon={...}` to their Collapsible. Diverging here would leave three components
  // that look identical and cannot be moved between apps.
  const comp = componentBody(src, 'Collapsible')
  assert.match(comp, /icon: Icon/, 'the component destructures it the way the siblings do')
  assert.match(comp, /\{Icon \? <Icon /, 'and renders it only when given one')

  // Every icon must actually be imported, or the section renders blank with a
  // ReferenceError that only shows up when that section is on screen.
  const imported = (src.match(/^import \{([^}]*)\} from '@phosphor-icons\/react'/m) || [, ''])[1]
    .split(',').map((n) => n.trim())
  for (const m of body.matchAll(/<Collapsible title='[^']*' icon=\{(\w+)\}/g)) {
    assert.ok(imported.includes(m[1]), `${m[1]} is imported`)
  }
})

test('the profile block is a compact row, not three stacked blocks', () => {
  const body = settingsBody(app())
  // It was a 96px centred avatar, a full-width photo button under it, and a labelled
  // name field on its own row - roughly 40% of the TCL's screen before a single
  // setting. Collapsing the sections was half the fix; this is the other half, and
  // the two together are what put every section on one screen.
  assert.match(body, /<Avatar[^>]*size=\{64\}/, 'the avatar is smaller')
  assert.doesNotMatch(body, /<Avatar[^>]*size=\{96\}/, 'and the old large one is gone')

  // The avatar IS the photo control now, which is what buys back the button's height.
  const at = body.indexOf('<Avatar')
  const before = body.slice(Math.max(0, at - 400), at)
  assert.match(before, /fileRef\.current\?\.click\(\)/, 'tapping the avatar picks a photo')
  assert.match(before, /aria-label=/, 'and it is labelled, since it is now a control')

  // Remove must still appear when a photo is set - shrinking a block is not a licence
  // to quietly drop what it could do.
  assert.match(body, /hasAvatar \?/, 'the remove control is still conditional on a photo')
})

test('nothing is expanded by default, which is the whole point', () => {
  const src = app()
  // loadSettingsOpen returns {} on a fresh device, so every `open` is false. If a
  // future change seeds some sections open, the page grows again and Linked devices
  // goes back below the fold - the exact thing this fixed.
  assert.match(src, /function loadSettingsOpen \(\) \{[^}]*\|\| '\{\}'/,
    'the stored default is an empty set of open sections')
})
