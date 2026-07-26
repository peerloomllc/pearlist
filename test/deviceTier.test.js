// The on-device AI gate. These numbers decide whether a user is offered a 0.8 GB
// download, so the two real devices behind them are pinned as test cases: if
// someone retunes a threshold and the SE stops being refused or the TCL starts
// being refused, that is a regression, not a tweak.

const test = require('node:test')
const assert = require('node:assert/strict')

const { capsFor, TOO_SMALL_MB, LOW_MEM_MB } = require('../src/deviceTier')

test('iPhone SE 2nd gen (3 GB) is refused, not merely warned', () => {
  // Measured 2026-07-26: the ~0.8 GB download completed and the load into memory
  // was refused under pressure. Warning was not enough - the user paid the
  // download before finding out.
  const caps = capsFor({ totalMemMB: 2966, freeStorageMB: 20000 })
  assert.equal(caps.tooSmall, true)
  assert.equal(caps.lowEnd, true)
})

test('TCL T513Z (3.84 GB) is warned but allowed - it genuinely works', () => {
  // The 5.9s/item baseline was measured on this phone, so a threshold that blocks
  // it is wrong by construction.
  const caps = capsFor({ totalMemMB: 3844, freeStorageMB: 8000 })
  assert.equal(caps.tooSmall, false, 'must not be blocked - it runs the model')
  assert.equal(caps.lowMem, true, 'still worth a warning at the 4 GB tier')
})

test('a roomy phone gets no warning at all', () => {
  const caps = capsFor({ totalMemMB: 8000, freeStorageMB: 40000 })
  assert.deepEqual(
    { tooSmall: caps.tooSmall, lowMem: caps.lowMem, lowStorage: caps.lowStorage, lowEnd: caps.lowEnd },
    { tooSmall: false, lowMem: false, lowStorage: false, lowEnd: false }
  )
})

test('low free storage warns on its own, whatever the memory', () => {
  const caps = capsFor({ totalMemMB: 8000, freeStorageMB: 900 })
  assert.equal(caps.lowStorage, true)
  assert.equal(caps.lowEnd, true)
  assert.equal(caps.tooSmall, false, 'storage is a warning, not a refusal - it can be freed')
})

test('an unknown reading is never treated as a bad one', () => {
  // Device.totalMemory returns null on some platforms. Blocking a phone because it
  // did not answer would take the feature away from devices that can run it.
  for (const caps of [capsFor({}), capsFor({ totalMemMB: 0, freeStorageMB: 0 }), capsFor()]) {
    assert.equal(caps.tooSmall, false)
    assert.equal(caps.lowMem, false)
    assert.equal(caps.lowEnd, false)
  }
})

test('the refuse line sits below the warn line', () => {
  // Otherwise "too small" would swallow the warning tier and every low-memory
  // device would be blocked outright.
  assert.ok(TOO_SMALL_MB < LOW_MEM_MB, `${TOO_SMALL_MB} must be under ${LOW_MEM_MB}`)
})

test('the refuse line sits between the two measured devices', () => {
  assert.ok(TOO_SMALL_MB > 2966, 'must refuse the 3 GB iPhone SE that failed')
  assert.ok(TOO_SMALL_MB < 3844, 'must allow the 3.84 GB TCL that works')
})
