# CLAUDE.md - PearList

Shared household lists (groceries, to-dos, chores) over P2P. No account, no
server. Part of the PeerLoom suite, governed by
`/home/tim/peerloomllc/CONSTITUTION.md`.

## What it is

A shared mutable list app. One household group holds many lists. Any member can
add, check, rename, assign and delete items, and everyone syncs peer to peer.
The `assignee` field doubles the grocery list as a chore board.

PearList is also the **extraction vehicle** for `@peerloom/core` (see
`proposals/2026-06-30-pearlist-core-extraction.md`). It is the first app built
on the shared core rather than a copy-fork.

## Architecture

Three-layer, same as the rest of the suite: React Native shell + WebView UI +
Bare worklet. The P2P substrate (identity, Autobase engine, swarm, pairing,
signing) comes from `@peerloom/core` (`file:../peerloom-core`). PearList itself
supplies only:
- `src/listWire.js` - the apply/merge rules (the `tripWire.js` analog).
- the IPC method table and Hyperbee key schema.
- `src/ui/` - the list UI.

Wire protocol and apply rules are specified in the proposal. Data model:
`list:{listId}` and `item:{listId}:{pubkey}:{seqPad}`, signed values,
last-writer-wins, no-resurrection tombstones.

## Canonical verify

`npm run verify` -> `npm test && npm run build:bare && npm run build:bare:ios && npm run build:ui`

Do not merge red. See Constitution §5.

## Conventions

- Feature branches always, no direct-to-master.
- T2/T3 changes get a proposal in `proposals/`. Wire-protocol or pairing changes
  are T3.
- Append-only `DECISIONS.md`, newest on top.
- No em dashes, no Oxford commas in docs and copy.
