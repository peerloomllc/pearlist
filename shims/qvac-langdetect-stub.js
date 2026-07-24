// Metro-only stub for @qvac/langdetect-text (see metro.config.js).
//
// The QVAC SDK's root export reaches its `translate` API, which imports
// @qvac/langdetect-text, which pulls in tinyld/heavy - a 2 MB language-detection
// model table. PearList only ever calls `completion` / `loadModel`, so that table
// was 2 MB of the Android JS bundle serving a code path we never run. Metro does
// not tree-shake, so the only way to drop it is to resolve the module to this.
//
// The functions throw rather than returning a fake answer: a silent wrong language
// would be far worse to debug than an immediate, explicit failure. If PearList ever
// wants translation, delete this shim and the resolver entry in metro.config.js.
//
// NB this affects the RN shell bundle only. The QVAC worker bundle carries its own
// copy of tinyld inside the Bare bundle, which we do not generate and cannot trim
// from here.

const message = 'QVAC language detection is stubbed out in PearList (see shims/qvac-langdetect-stub.js)'

function unavailable () { throw new Error(message) }

module.exports = {
  detectOne: unavailable,
  detectMultiple: unavailable,
  getLangName: unavailable,
  getISO2FromName: unavailable,
}
