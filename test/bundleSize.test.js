// Guards the Metro-level bundle trim. Losing the resolver entry silently regrows
// the Android JS bundle by ~3.3 MB of Hermes bytecode, and nothing else would fail.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const config = require('../metro.config')
const stub = require('../shims/qvac-langdetect-stub')

test('metro resolves @qvac/langdetect-text to the stub', () => {
  const context = { resolveRequest: () => ({ type: 'sourceFile', filePath: 'THE-REAL-ONE' }) }
  const resolved = config.resolver.resolveRequest(context, '@qvac/langdetect-text', 'android')
  assert.equal(resolved.filePath, path.resolve(__dirname, '..', 'shims/qvac-langdetect-stub.js'))
})

test('every other module still resolves normally', () => {
  const context = { resolveRequest: (_c, name) => ({ type: 'sourceFile', filePath: 'resolved:' + name }) }
  const resolved = config.resolver.resolveRequest(context, 'react-native', 'android')
  assert.equal(resolved.filePath, 'resolved:react-native')
})

test('the stub throws rather than returning a wrong language', () => {
  for (const fn of ['detectOne', 'detectMultiple', 'getLangName', 'getISO2FromName']) {
    assert.throws(() => stub[fn]('hola'), /stubbed out/, `${fn} should throw`)
  }
})
