// DOES "Remove" ACTUALLY STOP THEM WRITING?
//
// Tim, 2026-07-31, after removing the Pixel from a space: "it still had read and
// write permissions (hidden from members list but could still create lists, update
// lists, etc)."
//
// TWO VERY DIFFERENT EXPLANATIONS, and nothing visible from the phone tells them
// apart. Either the space was not armed for Stronger removal - in which case removal
// is hide-only BY DESIGN and the app simply never said so - or it was armed and hard
// revocation did not hold, which would be a security control failing silently.
//
// The existing coverage did not settle it: test/offlineRemoval.test.js proves the
// ENGINE honours a revokeWriter op, but it writes that op by hand. Nothing proved
// that `member:remove` - the thing the button actually calls - produces one. So this
// file drives the real method against real Autobase peers and then asks the only
// question that matters: does the removed peer's next write land on anyone else?

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const IdentityKey = require('../../peerloom-device-link/node_modules/keet-identity-key')
const { signValue } = require('@peerloom/core/records')
const listWire = require('../src/listWire.js')
const { authorizeRevoke, admitWriter } = require('../src/revocation.js')
const methods = require('../src/listMethods.js')

const _dirs = []
function tmpDir () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-cutoff-')); _dirs.push(d); return d }
function cleanup () {
  for (const d of _dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  _dirs.length = 0
}

const openView = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
const hex = (b) => b4a.toString(b, 'hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAPS = [listWire.REVOKE_CAP, listWire.REVOKE_SELF_CAP, listWire.PROMOTE_CAP]
const GID = 'g1'

function kp () {
  const publicKey = b4a.alloc(32); const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}
async function person () {
  const id = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  return async function device () {
    const d = kp()
    return { ...d, pubkey: hex(d.publicKey), identityProof: hex(await id.bootstrap(d.publicKey)) }
  }
}

// The engine's apply loop, from peerloom-core/src/engine.js - INCLUDING the
// revocation hooks. Those hooks are the thing under test here, so a harness that
// left them out (as the multi-space one does) would answer the wrong question.
function makeApply (groupId, selfKey) {
  return async (nodes, view, base) => {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op.type !== 'string') continue
      if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
        const how = await admitWriter(op, { view })
        await base.addWriter(b4a.from(op.pubkey, 'hex'), { indexer: how.indexer !== false })
        continue
      }
      if (op.type === 'revokeWriter' && typeof op.pubkey === 'string') {
        if (!await authorizeRevoke(op, { view, groupId })) continue
        const key = b4a.from(op.pubkey, 'hex')
        if (typeof base.removeable === 'function' && !base.removeable(key)) continue
        try { await base.removeWriter(key) } catch {}
        continue
      }
      await listWire.applyListOp(op, { view, base, groupId, node, emit () {}, selfKey })
    }
  }
}

async function mkPeer ({ bootstrap, selfKey }) {
  const store = new Corestore(tmpDir())
  await store.ready()
  const base = new Autobase(store.namespace(GID), bootstrap, {
    open: openView, apply: makeApply(GID, selfKey), valueEncoding: 'json',
  })
  await base.ready()
  return { store, base }
}
function connect (a, b) {
  const s1 = a.store.replicate(true); const s2 = b.store.replicate(false)
  s1.on('error', () => {}); s2.on('error', () => {}); s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
}
async function settle (peers, ms = 1500) {
  for (const p of peers) { try { await p.base.update() } catch {} }
  await sleep(ms)
  for (const p of peers) { try { await p.base.update() } catch {} }
}

let clock = 1700000000000
async function put (peer, dev, key, value) {
  await peer.base.append({
    type: 'put', key, value: signValue({ ...value, pubkey: dev.pubkey, updatedAt: ++clock }, dev.secretKey),
  })
}
function mkCtx (dev, peer) {
  const bases = new Map([[GID, peer.base]])
  return {
    identity: { publicKey: dev.publicKey, secretKey: dev.secretKey },
    bases,
    async append (gid, value) { await bases.get(gid).append(value) },
    emit () {},
  }
}

// The real join order: the space is created, the housemate joins while it is still
// un-armed (so they are admitted as an INDEXER, exactly as on a phone), and only then
// does the owner arm. Getting this order wrong would quietly make the test easier
// than reality - a non-indexer is the simpler writer to remove.
async function mkSpace ({ owner: o, mate: m, armed }) {
  const po = await mkPeer({ bootstrap: null, selfKey: o.publicKey })
  const pm = await mkPeer({ bootstrap: po.base.key, selfKey: m.publicKey })
  const stop = connect(po, pm)
  const peers = [po, pm]

  await put(po, o, 'space', { owner: o.pubkey, name: 'House' })
  await po.base.append({ type: 'addWriter', pubkey: hex(pm.base.local.key), indexer: true })
  await settle(peers, 2000)

  if (armed) {
    const meta = (await po.base.view.get('space')).value
    await put(po, o, 'space', { ...meta, revokeV1: true, revokeV2: true })
    await settle(peers, 1500)
  }
  // Published AFTER arming so apply stamps `_w`. Without a binding there is nothing
  // to revoke and removal degrades to hide-only - a case the app already reports.
  await put(po, o, 'member:' + o.pubkey, { displayName: 'Owner', caps: CAPS, identityProof: o.identityProof })
  await put(pm, m, 'member:' + m.pubkey, { displayName: 'Mate', caps: CAPS, identityProof: m.identityProof })
  await settle(peers, 2000)

  return { po, pm, peers, stop }
}
async function closeAll (s) {
  try { s.stop() } catch {}
  for (const p of s.peers) { try { await p.base.close() } catch {}; try { await p.store.close() } catch {} }
}

test('ARMED: removing a member really does stop their writes reaching anyone', async (t) => {
  t.after(cleanup)
  const owner = await (await person())()
  const mate = await (await person())()
  const s = await mkSpace({ owner, mate, armed: true })
  t.after(() => closeAll(s))

  // Precondition, or the assertion below proves nothing: they can write NOW.
  await put(s.pm, mate, 'list:before', { id: 'before', name: 'Still a member' })
  await settle(s.peers, 1500)
  assert.equal((await s.po.base.view.get('list:before'))?.value?.name, 'Still a member', 'precondition: their writes landed')

  const res = await methods['member:remove']({ groupId: GID, pubkey: mate.pubkey }, mkCtx(owner, s.po))
  assert.equal(res.revoked, true, 'the method reports a real cut-off')
  await settle(s.peers, 2500)

  // THE QUESTION TIM ASKED. A removed member creating a list is the exact thing he
  // watched the Pixel do.
  //
  // IT FAILS EARLIER THAN EXPECTED, which is worth writing down: the removed peer's
  // OWN base refuses the append with 'Not writable' rather than accepting it locally
  // and having everyone else drop it. Better than the assumed behaviour - the phone
  // cannot even build a change to lose - but it means "assert the write did not
  // arrive" is not the assertion to make. Both halves are checked below so a future
  // change cannot pass by breaking the append for some unrelated reason.
  await assert.rejects(
    put(s.pm, mate, 'list:after', { id: 'after', name: 'Should never land' }),
    /Not writable/,
    'a removed member cannot even append',
  )
  assert.equal(s.pm.base.writable, false, 'and it knows it')
  await settle(s.peers, 2500)
  assert.equal(await s.po.base.view.get('list:after'), null, 'the owner never sees a removed member\'s new list')
})

test('UN-ARMED: removal only HIDES them, and the method says so', async (t) => {
  t.after(cleanup)
  const owner = await (await person())()
  const mate = await (await person())()
  const s = await mkSpace({ owner, mate, armed: false })
  t.after(() => closeAll(s))

  const res = await methods['member:remove']({ groupId: GID, pubkey: mate.pubkey }, mkCtx(owner, s.po))
  assert.equal(res.evicted, true)
  assert.equal(res.revoked, false, 'nothing was cut off, and the result does not pretend otherwise')
  await settle(s.peers, 2000)

  // They are hidden from the roster...
  const meta = (await s.po.base.view.get('space')).value
  assert.ok(meta.evicted && meta.evicted[mate.pubkey], 'hidden from the members list')

  // ...and they can still write. THIS IS BY DESIGN on an un-armed space: hard
  // revocation changes how every peer applies writer ops, so it stays off until every
  // member advertises support, or a peer that did not understand it would keep
  // accepting the removed device and fork the space.
  //
  // Pinned as a test precisely BECAUSE it surprised its own author in the field. It
  // is the behaviour the UI has to explain, not a behaviour to quietly fix here - and
  // if a future change makes removal cut off unconditionally, this failing is the
  // reminder that the arming gate exists for a reason.
  await put(s.pm, mate, 'list:after', { id: 'after', name: 'Still writable' })
  await settle(s.peers, 2000)
  assert.equal((await s.po.base.view.get('list:after'))?.value?.name, 'Still writable',
    'un-armed removal is hide-only - the app must SAY this, not imply a cut-off')
})

// --- and the app has to SAY so ------------------------------------------------
//
// The two tests above settle what the code does. This one is about the half Tim
// actually hit: the behaviour was defensible, the silence was not. A source-shape pin
// rather than a copy match, so rewording stays free - what must not come back is a
// removal flow that mentions neither the limit nor the way out of it.

test('the removal flow tells the truth on an UN-ARMED space', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')
  const start = src.indexOf('async function removeMember')
  assert.ok(start > 0)
  const body = src.slice(start, src.indexOf('\n  async function', start + 1))

  // The CONFIRM has to differ, because that is the last moment the user can decide
  // not to bother - being told afterwards is being told too late.
  assert.match(body, /revoke\?\.armed/, 'the confirm has to know whether this space is armed')
  assert.match(body, /still change things/, 'and say what removal will not do')

  // ...AND NAME WHAT WOULD CHANGE IT. This used to require the string "Stronger
  // removal". That control was deleted in PR #170 - spaces arm themselves now - so the
  // pin should have gone red then and did not, because the words still appeared in a
  // COMMENT inside the same function. A pin matched against a whole function body can
  // be satisfied by prose nobody ships. It is asserted against the user-visible
  // `message:` strings now, and names the condition rather than a control, since there
  // is no longer a control to name.
  const messages = body.match(/message:[\s\S]*?confirmLabel/)
  assert.ok(messages, 'the confirm still builds a message')
  assert.match(messages[0], /everyone updates/, 'and names what would change it')
  assert.doesNotMatch(messages[0], /Stronger removal/,
    'never by pointing at a control that no longer exists')

  // The BANNER too: a confirm is read once and dismissed, and the banner is what is
  // still on screen when they look at the members list and see the person gone.
  const after = body.slice(body.indexOf('setBanner'))
  assert.match(after, /still change things/, 'the result must repeat the limit')
})
