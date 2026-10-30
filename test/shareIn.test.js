// Share into PearList on Android (proposals/2026-10-29-keep-style-notes.md, part 6).
// The native side cannot run here, so these check the wiring each layer relies on.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('the app offers itself for shared text and pictures', () => {
  const filters = JSON.parse(read('app.json')).expo.android.intentFilters
  const send = filters.find((f) => f.action === 'SEND')
  const multi = filters.find((f) => f.action === 'SEND_MULTIPLE')
  assert.deepEqual(send.data.map((d) => d.mimeType).sort(), ['image/*', 'text/plain'])
  assert.deepEqual(multi.data.map((d) => d.mimeType), ['image/*'])
  assert.ok(send.category.includes('DEFAULT'), 'a SEND filter without DEFAULT never matches')
})

test('the shell hands a share to the UI once, and tells it when a new one arrives', () => {
  const shell = read('app/index.tsx')
  assert.match(shell, /case 'shell:share:take':[\s\S]{0,300}takeShared\(\)/)
  assert.match(shell, /onShared\(\(\) => emitEvent\('shell:shared'\)\)/)
  const mod = read('modules/share-intent/android/src/main/java/expo/modules/shareintent/ShareIntentModule.kt')
  assert.match(mod, /intent\.action = Intent\.ACTION_MAIN/, 'a taken share is marked so it is not handed over twice')
})

test('the UI asks for a share at start and on each new one', () => {
  const ui = read('src/ui/App.jsx')
  assert.match(ui, /call\('shell:share:take'/)
  assert.match(ui, /on\('shell:shared', take\)/)
  assert.match(ui, /<ShareInSheet open=\{sheet === 'shareIn'\}/)
})
