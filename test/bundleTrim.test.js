// Pins the worklet bundle's import overrides (scripts/bare-imports.js).
//
// These tests exist because the thing they protect fails SILENTLY in both
// directions. If the override stops matching - bip39-mnemonic reorganises, or a
// dependency bump moves the file - the build still succeeds and the bundle just
// quietly regrows by 821 KB. If the override starts matching something ELSE, an
// unrelated package gets handed a BIP39 wordlist and breaks at runtime, on a
// device, in the worklet, which is the worst place to find out.
//
// Same lesson as PR #82's resolver-entry tests: losing a size win breaks nothing
// that anyone would notice, so it has to be asserted rather than remembered.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const imports = require('../scripts/bare-imports.js')

const BIP39 = path.join(ROOT, 'node_modules', '@peerloom', 'device-link', 'node_modules', 'bip39-mnemonic')

test('every import override points at a file that exists', () => {
  for (const [specifier, target] of Object.entries(imports)) {
    assert.ok(path.isAbsolute(target), `${specifier} must map to an absolute path, got ${target}`)
    assert.ok(fs.existsSync(target), `${specifier} maps to a missing file: ${target}`)
  }
})

// The map is GLOBAL: a key matches that specifier anywhere in the graph. A key
// with two consumers is hijacking one of them, and a key with none is dead weight
// that is no longer buying the size it claims to.
test('the ./wordlist override has exactly one consumer, and it is bip39-mnemonic', () => {
  const Bundle = require('bare-bundle')
  const bundle = Bundle.from(fs.readFileSync(path.join(ROOT, 'assets', 'bare-universal.bundle')))

  const consumers = []
  for (const [key, file] of bundle._files) {
    if (/require\(['"]\.\/wordlist['"]\)/.test(file._data.toString())) consumers.push(key)
  }

  assert.deepStrictEqual(consumers, ['/node_modules/@peerloom/device-link/node_modules/bip39-mnemonic/index.js'])
})

test('the bundle carries our wordlist and none of upstream twelve', () => {
  const Bundle = require('bare-bundle')

  for (const name of ['bare-universal.bundle', 'bare-ios.bundle']) {
    const bundle = Bundle.from(fs.readFileSync(path.join(ROOT, 'assets', name)))
    const keys = [...bundle._files.keys()]

    assert.ok(keys.includes('/src/vendor/bip39-wordlist.js'), `${name} is missing our wordlist shim`)
    assert.ok(keys.includes('/src/vendor/bip39-english.json'), `${name} is missing the English wordlist`)

    // lookup.json alone is 578 KB of the 821 KB this override removes.
    const upstream = keys.filter((k) => k.includes('bip39-mnemonic/wordlist/'))
    assert.deepStrictEqual(upstream, [], `${name} still carries upstream wordlists: ${upstream.join(', ')}`)
  }
})

// The wordlist is a frozen standard - changing it would invalidate every phrase
// ever generated - so a mismatch here means the vendored copy was edited or the
// installed package is not what we think it is, either of which is worth failing
// on rather than shipping a list that silently disagrees.
test('the vendored English list still matches the installed package', () => {
  const ours = require('../src/vendor/bip39-english.json')
  const theirs = require(path.join(BIP39, 'wordlist', 'english.json'))

  assert.strictEqual(ours.length, 2048)
  assert.deepStrictEqual(ours, theirs)
})

// The substitution has to be semantically identical for English, not merely
// smaller. This runs the REAL bip39 arithmetic against both wordlist modules and
// compares the outputs, so any divergence in `loadWordlist` or `detectLanguage`
// shows up as a different phrase or a different verdict.
test('English phrases behave identically through our wordlist and upstream', async () => {
  const Module = require('module')
  const ours = require('../src/vendor/bip39-wordlist.js')
  const theirs = require(path.join(BIP39, 'wordlist'))

  // Load bip39's index.js twice, handing each copy a different wordlist module.
  const load = (wordlist) => {
    const src = fs.readFileSync(path.join(BIP39, 'index.js'), 'utf8')
    const m = new Module(path.join(BIP39, 'index.js'), null)
    m.filename = m.path = path.join(BIP39, 'index.js')
    m.paths = Module._nodeModulePaths(BIP39)
    const req = (spec) => (spec === './wordlist' ? wordlist : m.require(spec))
    new Function('module', 'exports', 'require', src)(m, m.exports, req)
    return m.exports
  }

  const mine = load(ours)
  const upstream = load(theirs)

  // Same entropy must produce the same twelve words.
  const entropy = Buffer.from('0c1e24e5917779d297e14d45f14e1a1a', 'hex')
  const phrase = mine.entropyToMnemonic(entropy)
  assert.strictEqual(phrase, upstream.entropyToMnemonic(entropy))
  assert.strictEqual(phrase.split(' ').length, 12)

  // ...and read back to the same entropy, through detectLanguage.
  assert.deepStrictEqual(Buffer.from(mine.mnemonicToEntropy(phrase)), entropy)
  assert.strictEqual(mine.validateMnemonic(phrase), true)

  // A freshly minted phrase round-trips (the path device-link actually takes).
  const fresh = mine.generateMnemonic({ entropy: mine.generateEntropy(16) })
  assert.strictEqual(mine.validateMnemonic(fresh), true)
  assert.strictEqual(upstream.validateMnemonic(fresh), true)

  // Rejections agree: a bad checksum and a non-word are false either way.
  const badChecksum = phrase.split(' ').slice(0, 11).concat('zoo').join(' ')
  assert.strictEqual(mine.validateMnemonic(badChecksum), upstream.validateMnemonic(badChecksum))
  assert.strictEqual(mine.validateMnemonic('not a real phrase at all'), false)
  assert.strictEqual(mine.validateMnemonic(''), false)

  // THE ONE DELIBERATE DIVERGENCE, asserted so it stays deliberate: a valid
  // phrase in another language validates upstream and is rejected here. PearList
  // only ever mints English, so it only ever needs to read English - but a phrase
  // typed in from another app will not restore. See DECISIONS.md 2026-07-28.
  const spanish = upstream.entropyToMnemonic(entropy, { language: 'spanish' })
  assert.strictEqual(upstream.validateMnemonic(spanish), true)
  assert.strictEqual(mine.validateMnemonic(spanish), false)
})
