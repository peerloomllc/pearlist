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

test('iOS: the Share Extension is set up and uses the App Group the app reads', () => {
  const app = JSON.parse(read('app.json')).expo
  assert.ok(app.plugins.includes('./plugins/with-ios-share-extension'))
  const plugin = read('plugins/with-ios-share-extension.js')
  assert.match(plugin, /`group\.\$\{config\.ios\.bundleIdentifier\}`/)
  assert.match(plugin, /`\$\{c\.ios\.bundleIdentifier\}\.share`/)
  // The extension finds the group from its own id minus ".share"; the app from its own id.
  const ext = read('plugins/ios-share-extension/ShareViewController.swift')
  assert.match(ext, /"group\." \+ me\.split\(separator: "\."\)\.dropLast\(\)/)
  assert.match(ext, /URL\(string: "pearlist:\/\/share"\)/)
  assert.ok(require('../app.json').expo.scheme.includes('pearlist'), 'the app answers pearlist:// links')
  assert.match(read('modules/share-intent/index.ts'), /\^pearlist:\\\/\\\/share/)
  const mod = read('modules/share-intent/ios/ShareIntentModule.swift')
  assert.match(mod, /"group\." \+ \(Bundle\.main\.bundleIdentifier/)
  const plist = read('plugins/ios-share-extension/Info.plist')
  assert.match(plist, /com\.apple\.share-services/)
  assert.match(plist, /NSExtensionActivationSupportsImageWithMaxCount<\/key>\s*<integer>10</)
})

test('iOS: the App Store export signs the extension with its own profile', () => {
  const conf = read('scripts/app.conf')
  assert.match(conf, /^IOS_SHARE_PROVISIONING_PROFILE=/m)
  assert.match(read('scripts/ios-appstore.sh'), /<key>\$\{BUNDLE_ID\}\.share<\/key>\s*<string>\$\{IOS_SHARE_PROVISIONING_PROFILE\}/)
})

test('iOS: both build scripts sign each target with its own profile before archiving', () => {
  const store = read('scripts/ios-appstore.sh')
  assert.ok(store.indexOf('scripts/ios-signing.rb') !== -1 && store.indexOf('scripts/ios-signing.rb') < store.indexOf('archive 2>&1'))
  const dev = read('scripts/ios-dev-install.sh')
  assert.match(dev, /ios-signing\.rb PearList\.xcodeproj \\"Apple Development\\" \\"PearList Development\\" \\"PearList Share Development\\"/)
  assert.doesNotMatch(dev, /CODE_SIGN_STYLE=Automatic/)
  assert.match(read('scripts/ios-signing.rb'), /'PearListShare' => share_profile/)
})
