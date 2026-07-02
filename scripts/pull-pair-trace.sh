#!/usr/bin/env bash
# scripts/pull-pair-trace.sh
#
# Pull the pairing/writer-admission trace off the paired iPhone. The worklet
# ships pairing marks to the shell, which tees them to
# Documents/pair-trace.log in the app data container (see app/index.tsx
# writePairTrace + src/bare.js mark). `log collect --device` needs root and
# idevicesyslog only sees USB pairs, so we copy the file out of the container.
#
# Usage:
#   ./scripts/pull-pair-trace.sh              # pull + print
#   DEST=/tmp/x.log ./scripts/pull-pair-trace.sh
#
# Env overrides mirror ios-dev-install.sh.

set -euo pipefail

MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"
DEVICE_UDID="${DEVICE_UDID:-E1A6316D-C6A9-510B-9D3E-CD3D85C6DDF5}"
BUNDLE_ID="${BUNDLE_ID:-com.pearlist}"
DEST="${DEST:-/tmp/pearlist-pair-trace.log}"

ssh "$MAC_MINI" "bash -lc '
  xcrun devicectl device copy from \
    --device $DEVICE_UDID \
    --domain-type appDataContainer \
    --domain-identifier $BUNDLE_ID \
    --source Documents/pair-trace.log \
    --destination /tmp/pearlist-pair-trace.log 2>&1 | tail -3
  cat /tmp/pearlist-pair-trace.log
'" | tee "$DEST"

printf '\n\033[1;36m==>\033[0m saved to %s\n' "$DEST"
