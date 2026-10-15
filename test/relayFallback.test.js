// Two phones on mobile data that cannot open a direct path must fall back to the
// relay. Field report 2026-10-15: an Android and an iPhone, both on mobile data
// with Connect Anywhere on, joined a space but never synced until both were put
// on one wifi.
//
// Runs two real Hyperswarms on a local DHT testnet. Every direct dial is made to
// fail with HOLEPUNCH_PROBE_TIMEOUT, the error a phone gets when it has not
// worked out its NAT type yet. Hyperswarm only switches a peer to the relay after
// three other punch errors, so on its own it never asks the relay here. The fix in
// src/relay.js counts this one too. The first test shows the bug, the second the
// fix, with the swarm wired the same way as createSwarm in src/bare.js.
//
// What this proves is that the next dial ASKS for the relay. On a localhost
// testnet a dial that asks for the relay still reaches the other side directly
// before the relay is used. Whether it carries the data on real mobile
// networks is hyperdht's job and needs two phones on mobile data.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const DHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const BlindRelay = require('blind-relay')
const createTestnet = require('@hyperswarm/testnet')
const relay = require('../src/relay')

// A real blind relay node on the testnet. A dial that asks for a relay nobody
// serves fails outright, even when the direct path works.
async function startRelayNode (bootstrap) {
  const dht = new DHT({ bootstrap })
  const server = new BlindRelay.Server({ createStream: (opts) => dht.createRawStream({ ...opts, framed: true }) })
  const listener = dht.createServer((socket) => {
    server.accept(socket, { id: socket.remotePublicKey }).on('error', () => {})
  })
  await listener.listen()
  return { key: listener.publicKey, close: async () => { await listener.close(); await dht.destroy() } }
}

// Every dial that does not ask for the relay fails the way an unpunchable mobile
// network does when the phone has not learned its NAT type yet. Counts the dials
// that did ask.
function directDialsFail (dht, relayKey, counts) {
  function connect (key, opts = {}) {
    const socket = dht.connect(key, opts)
    if (opts.relayThrough && b4a.equals(opts.relayThrough, relayKey)) counts.relayed++
    else queueMicrotask(() => socket.destroy(Object.assign(new Error('simulated'), { code: 'HOLEPUNCH_PROBE_TIMEOUT' })))
    return socket
  }
  return new Proxy(dht, {
    get (target, prop) {
      if (prop === 'connect') return connect
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function phone ({ bootstrap, relayKey, withFix, counts }) {
  // Same policy as relay.swarmRelayThrough, with the test key. The real DHT's
  // `randomized` is false on a testnet, which matches a phone that has not
  // finished sampling its NAT.
  const swarm = new Hyperswarm({
    bootstrap,
    relayThrough: (force, sw) => relay.relayThroughFor({ force, randomized: !!sw.dht.randomized, useRelay: true, relayKey }),
  })
  const failing = directDialsFail(swarm.dht, relayKey, counts)
  swarm.dht = withFix ? relay.relayingDht(failing, { relayKey }) : failing
  swarm.on('connection', (conn) => conn.on('error', () => {}))
  return swarm
}

async function tryToConnect (ms, withFix) {
  const testnet = await createTestnet(3)
  const node = await startRelayNode(testnet.bootstrap)
  relay._reset()
  relay.setUseRelay(true)
  const counts = { relayed: 0 }
  const android = phone({ bootstrap: testnet.bootstrap, relayKey: node.key, withFix, counts })
  const iphone = phone({ bootstrap: testnet.bootstrap, relayKey: node.key, withFix, counts })
  try {
    const topic = b4a.alloc(32, 9)
    const connected = new Promise((resolve) => android.once('connection', () => resolve(true)))
    await android.join(topic, { server: true, client: true }).flushed()
    iphone.join(topic, { server: true, client: true })
    let timer
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms) })
    const ok = await Promise.race([connected, timedOut])
    clearTimeout(timer)
    return { ok, relayed: counts.relayed }
  } finally {
    await android.destroy()
    await iphone.destroy()
    await node.close()
    await testnet.destroy()
    relay._reset()
  }
}

test('without the fix: two phones whose direct dials time out never connect', { timeout: 60000 }, async () => {
  const { ok, relayed } = await tryToConnect(20000, false)
  assert.equal(ok, false, 'Hyperswarm alone kept dialling direct')
  assert.equal(relayed, 0, 'and never asked the relay')
})

test('with the fix: the next dial asks the relay and the phones connect', { timeout: 60000 }, async () => {
  const { ok, relayed } = await tryToConnect(20000, true)
  assert.ok(relayed > 0, 'asked the relay')
  assert.equal(ok, true, 'connected')
})
