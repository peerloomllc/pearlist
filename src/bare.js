// PearList Bare worklet entry. All the P2P plumbing lives in @peerloom/core;
// this just wires the list merge rules and the list method table into the
// engine and starts the IPC loop. The RN shell sends { id, method, args } over
// BareKit IPC; group:create / group:join / init are engine builtins, the
// list:* / item:* methods come from listMethods.

const { createGroupEngine } = require('@peerloom/core/engine')
const Hyperswarm = require('hyperswarm')
const { applyListOp } = require('./listWire')
const { authorizeRevoke, admitWriter } = require('./revocation')
const relay = require('./relay')
const listMethods = require('./listMethods')

// Pairing/writer-admission trace (diagnostic, 2026-07-01). The core emits marks
// (peer:connected, group:mounted, group:join, pair:onopen, pair:hello-sent,
// pair:hello-received, pair:addwriter-appended, pair:became-writable,
// apply:addwriter) through this hook. We timestamp each relative to worklet boot,
// keep a running buffer, and ship the whole buffer to the shell as a `pair:trace`
// event; the shell tees it to Documents/pair-trace.log, which we pull off the
// iPhone with `xcrun devicectl ... copy from` (worklet console does not reach a
// remote shell on iOS). Marks here are all one-shot per connection/join, so
// re-shipping the buffer each time is bounded (no per-op flood).
const _bootTs = Date.now()
const _traceLines = []
let _engine = null
function mark (name, extra) {
  const dt = Date.now() - _bootTs
  const line = (extra !== undefined)
    ? '[pair worklet+' + dt + 'ms] ' + name + ' ' + JSON.stringify(extra)
    : '[pair worklet+' + dt + 'ms] ' + name
  console.warn(line)
  _traceLines.push(line)
  if (_engine) { try { _engine.emit('pair:trace', { lines: _traceLines.slice() }) } catch {} }
}
mark('worklet:loaded')

const engine = createGroupEngine({
  appId: 'pearlist',
  applyOps: applyListOp,
  methods: listMethods,
  mark,
  // Writer revocation (proposals/2026-07-13-writer-revocation.md). Both are inert
  // until a space's owner ARMS it (space.revokeV1); without authorizeRevoke the
  // engine ignores revokeWriter ops entirely, so an un-armed space behaves exactly
  // as it does today.
  authorizeRevoke,
  admitWriter,
  // Storage retention (roadmap #4 P2): auto-prune old already-applied blocks
  // across all mounted spaces every 30 min, keeping a generous recent buffer so
  // small spaces are untouched and only long-churned ones shrink.
  retentionInterval: 30 * 60 * 1000,
  retentionKeepRecent: 512,
  // The off-LAN relay backstop (proposals/2026-07-23-blind-relay-adoption.md).
  // Core's default swarm takes no options, so we build it here purely to attach
  // `relayThrough`. It is a FUNCTION, not a static key, so both the baked relay
  // key and the user's privacy toggle are read live on every dial: direct-first
  // always, the relay only after Hyperswarm marks the peer as unpunchable.
  //
  // The engine calls this during init(), right after localDb is ready, which is
  // why hydrating the toggle from here is safe. It is deliberately not awaited
  // (createSwarm is sync): until the read lands the policy relays nothing.
  createSwarm: ({ keyPair }) => {
    relay.hydrate(engine.localDb).catch(() => {})
    return new Hyperswarm({ keyPair, relayThrough: relay.swarmRelayThrough })
  },
})
_engine = engine

engine.start()
