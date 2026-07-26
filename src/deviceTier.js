// Can this phone run the ~0.8 GB on-device model at all?
//
// Three answers, not two, because "warn" and "refuse" are different situations:
//
//   tooSmall  the model downloads and then CANNOT be loaded into memory. Offering
//             it costs the user 0.8 GB and several minutes to reach a dead end, so
//             the UI refuses instead of asking.
//   lowEnd    it should work but may be slow or fail. Worth a warning, not a block.
//   (neither) go ahead.
//
// CALIBRATION - measured, not guessed. Move a threshold only with a device that
// contradicts it, and record that device here:
//
//   iPhone SE 2nd gen   3.0 GB   download completed, load into memory refused
//                                under memory pressure (2026-07-26). No crash
//                                report: the load failed, the app was not killed.
//   TCL T513Z           3.84 GB  loads and classifies fine - the 5.9s/item
//                                baseline was measured on this phone.
//
// 3400 MB sits between those two. The softer 4600 MB warning line predates this
// and stays as-is: it flags the 4 GB class, which includes the TCL, and the TCL
// works, so that tier is a caution rather than a bar.

const TOO_SMALL_MB = 3400   // below this the model cannot load - refuse
const LOW_MEM_MB = 4600     // below this it may be slow or fail - warn
const LOW_STORAGE_MB = 1500 // the download plus its extract needs headroom

// A zero or missing reading means "unknown", never "bad": a device that does not
// report its memory must not be blocked on a guess.
function capsFor ({ totalMemMB = 0, freeStorageMB = 0 } = {}) {
  const tooSmall = totalMemMB > 0 && totalMemMB < TOO_SMALL_MB
  const lowMem = totalMemMB > 0 && totalMemMB < LOW_MEM_MB
  const lowStorage = freeStorageMB > 0 && freeStorageMB < LOW_STORAGE_MB
  return { totalMemMB, freeStorageMB, tooSmall, lowMem, lowStorage, lowEnd: tooSmall || lowMem || lowStorage }
}

module.exports = { capsFor, TOO_SMALL_MB, LOW_MEM_MB, LOW_STORAGE_MB }
