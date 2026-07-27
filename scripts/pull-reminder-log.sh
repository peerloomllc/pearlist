#!/usr/bin/env bash
# scripts/pull-reminder-log.sh
#
# Pull the pairing/writer-admission trace off the paired iPhone. The worklet
# ships pairing marks to the shell, which tees them to
# Documents/reminder-log.txt in the app data container (see app/index.tsx
# writePairTrace + src/bare.js mark). `log collect --device` needs root and
# idevicesyslog only sees USB pairs, so we copy the file out of the container.
#
# Usage:
#   ./scripts/pull-reminder-log.sh              # pull + print
#   DEST=/tmp/x.log ./scripts/pull-reminder-log.sh
#
# Env overrides mirror ios-dev-install.sh.

set -euo pipefail

MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"
DEVICE_UDID="${DEVICE_UDID:-E1A6316D-C6A9-510B-9D3E-CD3D85C6DDF5}"
BUNDLE_ID="${BUNDLE_ID:-com.pearlist}"
DEST="${DEST:-/tmp/pearlist-reminder-log.txt}"

# The staging path on the Mac is DELETED FIRST, and the copy's exit status is
# checked, because this script previously did neither and that is a trap: it
# copied to a FIXED path, swallowed the copy's error through `| tail -3`, then
# `cat`-ed whatever was there. A failed pull therefore reprinted the PREVIOUS
# run's trace and looked exactly like a successful one.
#
# That is not hypothetical. On 2026-07-26 it produced a byte-identical trace -
# same millisecond timings - for a build that had just been installed onto a
# freshly wiped device, and was briefly read as proof that build was healthy. A
# stale success is worse than a clean failure, because you act on it.
#
# NOTE ON EMPTY RESULTS: no trace is written until a group mounts or a pairing
# event fires. src/bare.js buffers marks and only emits once `_engine` exists,
# and `mark('worklet:loaded')` runs BEFORE that assignment - so a freshly
# installed, not-yet-paired app legitimately has no reminder-log.txt. Absence is
# NOT evidence that the worklet failed to start.
ssh "$MAC_MINI" "bash -lc '
  rm -f /tmp/pearlist-reminder-log.txt
  xcrun devicectl device copy from \
    --device $DEVICE_UDID \
    --domain-type appDataContainer \
    --domain-identifier $BUNDLE_ID \
    --source Documents/reminder-log.txt \
    --destination /tmp/pearlist-reminder-log.txt >/tmp/pearlist-pull.err 2>&1
  if [ ! -s /tmp/pearlist-reminder-log.txt ]; then
    echo \"pull-reminder-log: NO TRACE on the device (see below).\" >&2
    echo \"  Either the app has not mounted a group or paired since install, or it\" >&2
    echo \"  never started. Absence alone does not tell you which.\" >&2
    tail -5 /tmp/pearlist-pull.err >&2
    exit 3
  fi
  cat /tmp/pearlist-reminder-log.txt
'" | tee "$DEST"

printf '\n\033[1;36m==>\033[0m saved to %s\n' "$DEST"
