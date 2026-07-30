// Run as a child process by test/invalidCheckout.test.js, once per target length
// (given as argv[2]). It has to be a child: the assertion escapes a SECOND time,
// outside the promise the caller is holding, so measuring it in-process would take
// the test runner down with it - exactly as it took the worklet down.
//
// The caller here does everything right: awaits inside a try/catch and reports.
// Dying anyway is the result being measured. Deliberately installs no handler.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Corestore = require('corestore')

const N = Number(process.argv[2] || 16)

async function main () {
  const store = new Corestore(fs.mkdtempSync(path.join(os.tmpdir(), 'plist-crash-')))
  await store.ready()

  const src = store.get({ name: 'src' })
  await src.ready()
  await src.append(Buffer.from('one'))

  const next = store.get({
    name: 'next',
    manifest: {
      version: 1,
      hash: 'blake2b',
      allowPatch: false,
      quorum: 1,
      signers: [{ signature: 'ed25519', namespace: Buffer.alloc(32), publicKey: src.key }],
      prologue: { length: 1, hash: await src.treeHash(1) }
    }
  })
  await next.ready()

  // This peer's local view core holds 1 block. The migration is aiming at N -
  // on a phone, the length the system says that view is indexed to.
  next.core.header.manifest.prologue = { length: N, hash: Buffer.alloc(32) }

  // THE SILENT PART: copies nothing, throws nothing, reports nothing.
  await next.core.copyPrologue(src.state)
  console.log('COPIED_LENGTH ' + next.core.state.length)

  // THE LOUD PART, the next line in autobase's _migrateView.
  const batch = next.session({ name: 'batch', overwrite: true, checkout: N })
  try {
    await batch.ready()
    console.log('NO_ERROR')
  } catch (err) {
    console.log('CAUGHT ' + err.code + ' ' + String(err.message).split(' (discovery')[0])
  }
  try { await batch.close() } catch {}

  await new Promise((r) => setTimeout(r, 500))
  console.log('SURVIVED')
}

main().catch((err) => { console.log('MAIN_CAUGHT ' + err.code) })
