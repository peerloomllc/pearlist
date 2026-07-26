// Guards the single source for the version shown on the Settings screen. It used
// to be a literal in App.jsx ('0.0.1' while the app shipped as 1.0.3, GH #89) and
// nothing failed, because no build step reads it. These are source-level checks:
// the UI bundle is built after the tests run, so it cannot be inspected here.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('App.jsx takes the version from the build-time define, not a literal', () => {
  const src = read('src/ui/App.jsx')
  const line = src.split('\n').find((l) => l.startsWith('const APP_VERSION'))
  assert.ok(line, 'App.jsx should still declare APP_VERSION')
  assert.match(line, /__APP_VERSION__/, 'APP_VERSION must come from the __APP_VERSION__ define')
  assert.doesNotMatch(line, /'\d+\.\d+\.\d+'/, 'APP_VERSION must not hardcode a version number')
})

test('build-ui defines __APP_VERSION__ from app.json expo.version', () => {
  const src = read('scripts/build-ui.mjs')
  assert.match(src, /__APP_VERSION__: JSON\.stringify\(APP_VERSION\)/)
  assert.match(src, /JSON\.parse\(readFileSync\('app\.json', 'utf8'\)\)\.expo\.version/)
})

test('app.json expo.version and android versionCode agree', () => {
  const { expo } = JSON.parse(read('app.json'))
  const [maj, min, pat] = expo.version.split('.').map(Number)
  assert.equal(expo.android.versionCode, maj * 1000000 + min * 1000 + pat,
    `versionCode should be ${maj}*1000000 + ${min}*1000 + ${pat} for version ${expo.version}`)
})
