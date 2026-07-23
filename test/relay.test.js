const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const relay = require('../src/relay')

const KEY = b4a.from('a'.repeat(64), 'hex')

test('the baked relay key decodes to 32 bytes', () => {
  assert.equal(relay.RELAY_PUBLIC_KEY.length, 32)
  assert.equal(relay.RELAY_PUBLIC_KEY_Z.length, 52)
})

test('direct-first: no relay until the punch has failed', () => {
  assert.equal(relayFor({ force: false, randomized: false }), null)
  assert.equal(relayFor({ force: true, randomized: false }), KEY)
})

test('a double-randomized NAT relays from the first attempt', () => {
  // It can never punch, so waiting for a failure would only add ~10s of nothing.
  assert.equal(relayFor({ force: false, randomized: true }), KEY)
})

test('the privacy toggle wins over every NAT signal', () => {
  assert.equal(relayFor({ force: true, randomized: true, useRelay: false }), null)
})

test('no configured relay key is a hard off', () => {
  assert.equal(relay.relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: null }), null)
})

function relayFor ({ force, randomized, useRelay = true }) {
  return relay.relayThroughFor({ force, randomized, useRelay, relayKey: KEY })
}

// --- the live-read policy Hyperswarm actually calls -------------------------

test('relays nothing until the stored toggle has been read', () => {
  relay._reset()
  assert.equal(relay.isHydrated(), false)
  // force=true would relay if we knew the user's choice; not knowing it, we do not.
  assert.equal(relay.swarmRelayThrough(true, { dht: { randomized: false } }), null)
})

test('hydrate defaults to on, and honours a stored off', async () => {
  relay._reset()
  await relay.hydrate({ get: async () => null })
  assert.equal(relay.getUseRelay(), true)
  assert.equal(relay.swarmRelayThrough(true, { dht: {} }), relay.RELAY_PUBLIC_KEY)

  relay._reset()
  await relay.hydrate({ get: async () => ({ value: { useRelay: false } }) })
  assert.equal(relay.getUseRelay(), false)
  assert.equal(relay.swarmRelayThrough(true, { dht: {} }), null)
})

test('a failed read leaves the backstop on rather than silently off', async () => {
  relay._reset()
  await relay.hydrate({ get: async () => { throw new Error('db gone') } })
  assert.equal(relay.isHydrated(), true)
  assert.equal(relay.getUseRelay(), true)
})

test('flipping the toggle applies to the next dial, no reconnect', async () => {
  relay._reset()
  await relay.hydrate({ get: async () => null })
  assert.equal(relay.swarmRelayThrough(true, { dht: {} }), relay.RELAY_PUBLIC_KEY)
  relay.setUseRelay(false)
  assert.equal(relay.swarmRelayThrough(true, { dht: {} }), null)
  relay.setUseRelay(true)
  assert.equal(relay.swarmRelayThrough(true, { dht: {} }), relay.RELAY_PUBLIC_KEY)
})

test('swarmRelayThrough reads randomized off the live swarm', async () => {
  relay._reset()
  await relay.hydrate({ get: async () => null })
  assert.equal(relay.swarmRelayThrough(false, { dht: { randomized: false } }), null)
  assert.equal(relay.swarmRelayThrough(false, { dht: { randomized: true } }), relay.RELAY_PUBLIC_KEY)
  assert.equal(relay.swarmRelayThrough(false, undefined), null) // no swarm handed in: direct
})
