// hypercore's _updateSnapshotStorage reads `this.atomized` again after a
// wait, when it may be null (src/hypercoreSnapshotPatch.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const SessionState = require('hypercore/lib/session-state')
const { applySnapshotFlushFix } = require('../src/hypercoreSnapshotPatch')

// A session whose atomic batch finishes, and is cleared, while it waits.
function session () {
  const s = { treeInfo: () => ({ fork: 0, roots: [], length: 0 }) }
  const atom = { flushing: true, flushed: async () => { atom.flushing = false; s.atomized = null } }
  s.atomized = atom
  return s
}
const storage = {
  read: () => ({ getHead: async () => null, getAuth: async () => ({ manifest: null }), getDependency: async () => null, getTreeNode: async () => null, tryFlush () {} }),
  setDependencyHead () {}
}

// Runs first, before this file patches anything.
test('upstream throws when the batch is cleared during the wait', async () => {
  assert.equal(SessionState.prototype._updateSnapshotStorage.__snapshotFlushFixed, undefined)
  // If this stops throwing, hypercore has fixed it: drop the patch.
  await assert.rejects(SessionState.prototype._updateSnapshotStorage.call(session(), storage), /flushing/)
})

test('the patched version waits on the batch it saw', async () => {
  applySnapshotFlushFix(SessionState)
  assert.equal(SessionState.prototype._updateSnapshotStorage.__snapshotFlushFixed, true)
  assert.deepEqual(await SessionState.prototype._updateSnapshotStorage.call(session(), storage), { fork: 0, roots: [], length: 0, prologue: null, signature: null })
  assert.equal(applySnapshotFlushFix(SessionState), false, 'applied once')
})
