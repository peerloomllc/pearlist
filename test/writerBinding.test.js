// The `_w` binding must name the writer key this device uses NOW, not merely be
// present.
//
// Why it matters, from proposals/2026-07-30-repairing-a-removed-phone.md: a writer
// key could never change, so `typeof mine._w === 'string'` was a fine readiness
// check. Re-pairing a removed phone rotates it. A stale `_w` naming the old,
// already-revoked key sails through a presence check, the republish never fires,
// and a LATER removal revokes a dead key and reports success - a removal silently
// degraded to hide-only. That failure has been seen on-device once already, for a
// different reason, and it is the one that makes a recovery feature into a way to
// defeat the removal feature.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

test('localWriterHex reads the base local key and never throws', () => {
  // Not exported (nothing in listMethods is), so exercise the shape it must
  // tolerate. Every one of these is a real state: a base mid-open has no local
  // core, and a getter can throw during teardown.
  const src = read('src/listMethods.js')
  const at = src.indexOf('function localWriterHex')
  assert.ok(at > 0, 'the helper exists')
  const body = src.slice(at, at + 400)
  assert.match(body, /try \{/, 'wrapped - a base without a local core is legitimate during startup')
  assert.match(body, /base && base\.local && base\.local\.key/, 'guards the whole path')
  assert.match(body, /catch \{ return null \}/, 'degrades to "cannot tell", never throws')
})

test('the readiness check compares _w against the CURRENT writer key', () => {
  const src = read('src/listMethods.js')
  const at = src.indexOf("'space:revocationStatus'")
  assert.ok(at > 0, 'found the method')
  // BOUNDED BY THE NEXT METHOD KEY, not by a character count. This was
  // `slice(at, at + 2200)`, which made the negative below mean "the old presence-only
  // condition is not in the first 2200 characters". The method has grown twice since
  // (the arming catch-up, then the first-arm branch) and would have slid the tail out
  // of range without anything failing.
  const after = src.slice(at).search(/\n {2}'[a-z]+:[a-zA-Z]+':/)
  assert.ok(after > 0, 'the method is followed by another')
  const body = src.slice(at, at + after)

  assert.match(body, /const myWriter = localWriterHex\(base\)/, 'reads this device"s current writer key')
  assert.match(body, /mine\._w === myWriter/, 'and compares the binding against it')

  // The old presence-only test must not survive as the whole condition.
  assert.doesNotMatch(body, /const bound = !!\(mine && typeof mine\._w === 'string'\)\s*$/m,
    'presence alone is no longer sufficient')

  // A base that cannot report a local key must not be treated as UNBOUND - that
  // would republish on every poll during startup, which is a write amplification
  // loop, and this app has had one of those before.
  assert.match(body, /!myWriter \|\| mine\._w === myWriter/,
    'unknown writer key degrades to the old behaviour rather than to a republish storm')
})

test('other members are still judged on presence, because nothing else is knowable', () => {
  // base.local.key answers this for US and for nobody else. The `unbound` list
  // covers other members, and presence is the best available signal there - so it
  // must NOT be "fixed" to use myWriter, which would mark every other member
  // unbound forever.
  const src = read('src/listMethods.js')
  const at = src.indexOf("'space:revocationStatus'")
  const body = src.slice(at, src.indexOf('\n  },', at))
  assert.match(body, /unbound: active\.filter\(\(r\) => typeof r\._w !== 'string'\)/,
    'other members: presence, unchanged')
})

test('applyListOp still stamps _w from the appending core, not from the row', () => {
  // The other half of the contract: `_w` is re-derived on every member write while
  // armed, which is what makes a rotated key heal itself on the next publish. It
  // must keep coming from node.from.key - a self-declared writer key would let a
  // member claim a victim"s key and have a removal hit the wrong device.
  const src = read('src/listWire.js')
  assert.match(src, /const w = writerKeyOf\(ctx\.node\)/, 'taken from the appending core')
  assert.match(src, /value = \{ \.\.\.op\.value, _w: w \}/, 'and stamped onto the stored row')
  const wk = src.slice(src.indexOf('function writerKeyOf'), src.indexOf('function writerKeyOf') + 300)
  assert.match(wk, /node\.from\.key/, 'writerKeyOf reads node.from.key')
})

test('b4a is available for the hex conversion', () => {
  // Cheap guard: localWriterHex uses b4a, and listMethods has imported it since
  // long before this - but a helper added near the top of a 1000-line file is
  // exactly where an unimported symbol hides until runtime.
  const src = read('src/listMethods.js')
  assert.match(src, /const b4a = require\('b4a'\)/)
  assert.equal(typeof b4a.toString, 'function')
})
