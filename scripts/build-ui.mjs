// Build the WebView UI bundle, and also emit a single self-contained
// assets/index.html (JS inlined) so the design preview opens from anywhere over
// file:// with no separate-file or MIME pitfalls. The shell uses
// src/ui/index.html + assets/app-ui.bundle separately; this index.html is the
// browser preview.

import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

// The version the Settings screen shows comes from app.json, the same field that
// becomes the Android versionName and the iOS marketing version. Baked in here so
// there is exactly one place to bump.
const APP_VERSION = JSON.parse(readFileSync('app.json', 'utf8')).expo.version
if (!/^\d+\.\d+\.\d+/.test(APP_VERSION)) throw new Error(`app.json expo.version is not a dotted version: ${APP_VERSION}`)

await build({
  entryPoints: ['src/ui/main.jsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(APP_VERSION) },
  outfile: 'assets/app-ui.bundle',
  legalComments: 'none',
})

const js = readFileSync('assets/app-ui.bundle', 'utf8').replace(/<\/script>/g, '<\\/script>')
const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#0d0d0d">
  <title>PearList preview</title>
  <style>html,body,#root{height:100%;margin:0;background:#0d0d0d}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>
`
writeFileSync('assets/index.html', html)
console.log(`built assets/app-ui.bundle + self-contained assets/index.html (v${APP_VERSION})`)
