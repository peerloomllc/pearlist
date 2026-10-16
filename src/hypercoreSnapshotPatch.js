// Runtime fix for hypercore's SessionState._updateSnapshotStorage (upstream
// bug, present from at least 11.27.14 through 11.39.0).
//
//   if (!this.atomized || !this.atomized.flushing) return this.treeInfo()
//   while (this.atomized.flushing) await this.atomized.flushed()
//
// The loop reads `this.atomized` again after each wait, but the atomic batch
// can finish and set it to null meanwhile. Then the read throws "Cannot read
// properties of null (reading 'flushing')" from a promise nobody awaits: an
// uncaught error that can stop the worklet. First seen in PearOffice under
// load (2026-10-07); this is a copy of PearOffice's fix (pearoffice #159).
//
// The fix waits on the batch it saw rather than reading the field again. The
// rest is upstream's code, unchanged. Applied in src/bare.js. Drop it once
// hypercore fixes this, and check `flat` below still matches upstream's
// import if it changes.

const flat = require('flat-tree')

function applySnapshotFlushFix (SessionState) {
  const proto = SessionState && SessionState.prototype
  if (!proto || typeof proto._updateSnapshotStorage !== 'function' || proto._updateSnapshotStorage.__snapshotFlushFixed) return false

  async function _updateSnapshotStorage (storage) {
    const atom = this.atomized
    if (!atom || !atom.flushing) return this.treeInfo()
    while (atom.flushing) await atom.flushed()

    let rx = storage.read()
    const headPromise = rx.getHead()
    const authPromise = rx.getAuth()
    const depPromise = rx.getDependency()

    rx.tryFlush()
    const [head, auth, dep] = await Promise.all([headPromise, authPromise, depPromise])

    storage.setDependencyHead(dep)

    const fork = head ? head.fork : 0
    const length = head ? head.length : 0

    rx = storage.read()
    const rootPromises = []
    for (const r of flat.fullRoots(length * 2)) {
      rootPromises.push(rx.getTreeNode(r))
    }

    rx.tryFlush()

    const roots = await Promise.all(rootPromises)

    for (const root of roots) {
      if (root === null) {
        throw new Error('Bad snapshot from atomized session, id = ' + this.core.id + ' length = ' + length + ' fork = ' + fork)
      }
    }

    return {
      fork,
      roots,
      length,
      prologue: auth.manifest && auth.manifest.prologue,
      signature: head && head.signature
    }
  }
  _updateSnapshotStorage.__snapshotFlushFixed = true
  proto._updateSnapshotStorage = _updateSnapshotStorage
  return true
}

module.exports = { applySnapshotFlushFix }
