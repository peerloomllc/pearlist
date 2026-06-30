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
})

engine.start()
