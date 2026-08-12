// Run as a child process by test/invalidCheckout.test.js, once per target length
// (given as argv[2]). It has to be a child: the assertion escapes a SECOND time,
// outside the promise the caller is holding, so measuring it in-process would take
// the test runner down with it - exactly as it took the worklet down.
//
// The caller here does everything right: awaits inside a try/catch and reports.
// Dying anyway is the result being measured. Deliberately installs no handler.
//
// THE STORE DIRECTORY IS THE CALLER'S, handed in as argv[3]. It used to mkdtemp its
// own, which meant a process whose whole point is to die never removed it: this
// fixture was the single biggest family among the 123 abandoned directories found
// on 2026-08-07. Nothing in here can clean up after itself, so the parent owns the
// directory and sweeps it. See test/helpers/tmpdir.js.
const Corestore = require('corestore')

const N = Number(process.argv[2] || 16)
const STORE_DIR = process.argv[3]

async function main () {
  const store = new Corestore(STORE_DIR)
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
