// Backing spaces up to a blind seeder (suite proposals/2026-10-12-generic-seeder.md,
// phase 2). Off until this device pairs with a seeder.
//
// Each device lists the seeders it paired with in a `seeders` field on its own
// signed member row (publishMember). Every member then backs each space up to every
// seeder any visible member lists, so a household syncs through the seeder when the
// other phones are asleep. An added field on an existing row: older versions store
// it as is and ignore it, so the space does not fork (listWire.js, top).
//
// The seeder gets core keys and encrypted blocks only. It cannot read a list, and it
// cannot add a new phone to a space: that still needs a member online.

const { createSeeding } = require('@peerloom/core/seeding')
const { MEMBER_RANGE, isMemberVisible } = require('./listWire')

const HEX64 = /^[0-9a-f]{64}$/
const instances = new WeakMap() // engine -> seeding (one per worklet; tests run several)

// Every seeder a visible member of this space lists.
async function seedersOfSpace (base) {
  const keys = new Set()
  const spaceMeta = (await base.view.get('space').catch(() => null))?.value || null
  for await (const { value } of base.view.createReadStream(MEMBER_RANGE)) {
    if (!isMemberVisible(value, spaceMeta) || !Array.isArray(value.seeders)) continue
    for (const k of value.seeders) if (typeof k === 'string' && HEX64.test(k)) keys.add(k)
  }
  return [...keys]
}

// One per engine. `engine` is the group engine (store, swarm, localDb, bases).
function getSeeding (engine) {
  let s = instances.get(engine)
  if (!s) {
    s = createSeeding({ ctx: engine, app: 'PearList', seedersFor: (_groupId, base) => seedersOfSpace(base) })
    instances.set(engine, s)
  }
  return s
}

// The keys this device publishes on its member rows.
async function pairedKeys (engine) {
  return (await getSeeding(engine).paired()).map((s) => s.seederKey).sort()
}

module.exports = { getSeeding, seedersOfSpace, pairedKeys }
