// Global import overrides for the worklet bundle, passed to bare-pack as
// `--imports`. bare-pack `require()`s this file at build time, so the map can be
// computed rather than hardcoded - which matters because bare-pack resolves an
// absolute target against the filesystem root, not against the project.
//
// This is the worklet-side equivalent of the Metro resolver stub that dropped
// tinyld in PR #82. Same reason: the bundle is NOT tree-shaken, so a `require`
// that is reachable-but-unused costs its full weight on every install.
//
// KEEP THIS MAP SMALL AND PINNED. A key here matches that specifier ANYWHERE in
// the module graph, so a broad key would silently hijack an unrelated package as
// dependencies change. test/bundleTrim.test.js asserts that each entry still has
// exactly one consumer and that the substitution actually happened.

const path = require('path')

module.exports = {
  // bip39-mnemonic/index.js -> `require('./wordlist')`, which pulls in twelve
  // wordlists and a 578 KB reverse lookup table so it can auto-detect the
  // language of a phrase. We only ever mint and read English. See
  // src/vendor/bip39-wordlist.js for why English-only is a correct answer here
  // and not merely a smaller one.
  './wordlist': path.join(__dirname, '..', 'src', 'vendor', 'bip39-wordlist.js')
}
