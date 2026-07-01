// PearList Bare worklet entry. All the P2P plumbing lives in @peerloom/core;
// this just wires the list merge rules and the list method table into the
// engine and starts the IPC loop. The RN shell sends { id, method, args } over
// BareKit IPC; group:create / group:join / init are engine builtins, the
// list:* / item:* methods come from listMethods.

const { createGroupEngine } = require('@peerloom/core/engine')
const { applyListOp } = require('./listWire')
const listMethods = require('./listMethods')

const engine = createGroupEngine({
  appId: 'pearlist',
  applyOps: applyListOp,
  methods: listMethods,
  // Storage retention (roadmap #4 P2): auto-prune old already-applied blocks
  // across all mounted spaces every 30 min, keeping a generous recent buffer so
  // small spaces are untouched and only long-churned ones shrink.
  retentionInterval: 30 * 60 * 1000,
  retentionKeepRecent: 512,
})

engine.start()
