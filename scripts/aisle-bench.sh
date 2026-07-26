#!/usr/bin/env bash
# Aisle-prompt harness, driven FROM the Linux box: syncs the repo to the Mac Mini,
# runs scripts/ios-aisle-bench.sh there against the iOS Simulator, then pulls the
# results back. Mirrors scripts/screenshots.sh.
#
# Usage:
#   ./scripts/aisle-bench.sh
#   REPEATS=3 VARIANTS=v11,v4 ITEMS=6 SKIP_BUILD=1 ./scripts/aisle-bench.sh
#
# Output: metadata/bench/ios-aisle-bench.{log,jsonl}, then read it with
#   node scripts/aisle-bench-report.mjs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$REPO_ROOT/scripts/app.conf" ]; then set -a; source "$REPO_ROOT/scripts/app.conf"; set +a; fi
MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"
MAC_REPO="${MAC_MINI_REPO_PATH:-peerloomllc/$(basename "$REPO_ROOT")}"
OUT_DIR="$REPO_ROOT/metadata/bench"

echo "==> Bundling UI (the shell embeds it; the harness itself needs no UI)"
cd "$REPO_ROOT"
npm run build:ui 2>&1 | tail -1

echo "==> Syncing to $MAC_MINI"
# metadata/bench/ is EXCLUDED because results only travel Mac -> here. Syncing it
# outbound copied a stale local log over the Mac's accumulated one and threw away
# 50 answered calls - the log is the run's memory, and the Mac is where it lives.
rsync -az --checksum --exclude='.git' --exclude='node_modules' --exclude='android' \
  --exclude='ios/Pods/' --exclude='ios/build/' --exclude="ios/${APP_NAME:-PearList}.xcworkspace/" \
  --exclude='.expo/' --exclude='metadata/bench/' \
  "$REPO_ROOT/" "$MAC_MINI:$MAC_REPO/"

# @qvac/sdk/dist/worker.mobile.bundle.js is NOT in the npm tarball - `expo prebuild`
# GENERATES it into node_modules, next to the qvac/ dir it also writes. node_modules
# is excluded from the sync, so without this the Mac builds an app whose
# require("@qvac/sdk/worker.mobile.bundle") fails at runtime: "Failed to load mobile
# worker bundle", i.e. no on-device AI at all. The Xcode build still succeeds, which
# is what makes it easy to miss. Ship the generated bundle with the prebuilt ios/
# tree that produced it.
echo "==> Syncing the prebuild-generated QVAC worker bundle"
rsync -az "$REPO_ROOT/node_modules/@qvac/sdk/dist/worker.mobile.bundle.js" \
  "$MAC_MINI:$MAC_REPO/node_modules/@qvac/sdk/dist/worker.mobile.bundle.js"

echo "==> Running harness on $MAC_MINI"
ssh "$MAC_MINI" "bash -lc 'cd $MAC_REPO && ${SKIP_BUILD:+SKIP_BUILD=1 }${REPEATS:+REPEATS=$REPEATS }${VARIANTS:+VARIANTS=$VARIANTS }${ITEMS:+ITEMS=$ITEMS }${TIMEOUT:+TIMEOUT=$TIMEOUT }./scripts/ios-aisle-bench.sh'"

echo "==> Pulling results into $OUT_DIR"
mkdir -p "$OUT_DIR"
rsync -az "$MAC_MINI:$MAC_REPO/metadata/bench/" "$OUT_DIR/"

echo ""
node "$REPO_ROOT/scripts/aisle-bench-report.mjs" "$OUT_DIR/ios-aisle-bench.jsonl" || true
