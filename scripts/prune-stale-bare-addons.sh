#!/usr/bin/env bash
# scripts/prune-stale-bare-addons.sh
#
# Remove stale QVAC native addons from react-native-bare-kit's iOS addon
# directory, and warn about duplicate addon versions. Runs ON THE BUILD HOST
# (the Mac mini), before `pod install`.
#
# Usage:
#   ./scripts/prune-stale-bare-addons.sh [repo-root]      # default: this repo
#
# WHY THIS EXISTS
#
# react-native-bare-kit.podspec vendors frameworks BY GLOB:
#
#   s.vendored_frameworks = "ios/*.xcframework", "ios/addons/*.xcframework"
#
# Every .xcframework sitting in that addons directory is linked into the app,
# whether or not the worklet bundle references it. And that directory is a CACHE
# INSIDE node_modules that accumulates: `expo prebuild` writes addons into it,
# `npm install` does not clean files a plugin wrote into an already-installed
# package, and the iOS build hosts keep node_modules across syncs (every rsync in
# release.sh and ios-dev-install.sh excludes it). So nothing on the normal path
# ever removes an addon once it lands.
#
# Concretely, on 2026-07-26: PearList's QVAC dependency was removed in PRs #98 and
# #99 and `npm run verify` was green, `expo config --type prebuild` was clean, the
# Android APK contained no ggml library at all - and the iPhone IPA still shipped
# ELEVEN qvac frameworks totalling ~40 MB of its 68 MB, including llamacpp, ocr,
# whisper, tts, diffusion and translation. The archive succeeded, the app ran, and
# nothing anywhere reported a problem. This is the same shape of invisible failure
# that PR #94's archive gate existed to catch, which is why removing that gate
# should not have left this side unguarded.
#
# The check is safe to run always: PearList has no QVAC dependency, so a qvac
# addon in this directory is stale BY DEFINITION. There is no version of this repo
# where keeping one is correct.

set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ADDONS="$REPO_ROOT/node_modules/react-native-bare-kit/ios/addons"

if [ ! -d "$ADDONS" ]; then
  echo "Bare addons: no addon directory at $ADDONS (nothing to prune)."
  exit 0
fi

# ── 1. Stale QVAC addons: remove ────────────────────────────────────────────
shopt -s nullglob
stale=("$ADDONS"/qvac__*.xcframework)
shopt -u nullglob

if [ ${#stale[@]} -gt 0 ]; then
  before=$(du -sk "$ADDONS" | cut -f1)
  echo "Bare addons: removing ${#stale[@]} stale QVAC framework(s) - PearList has no QVAC dependency."
  for f in "${stale[@]}"; do
    echo "    - $(basename "$f")"
    rm -rf "$f"
  done
  after=$(du -sk "$ADDONS" | cut -f1)
  echo "    Reclaimed $(( (before - after) / 1024 )) MB. These would otherwise have been"
  echo "    linked into the IPA by the podspec's ios/addons/*.xcframework glob."
else
  echo "Bare addons: no stale QVAC frameworks."
fi

# ── 2. Duplicate addon versions: WARN ONLY ──────────────────────────────────
# iOS matches a Bare native addon by EXACT framework version, so two versions of
# one addon is the ADDON_NOT_FOUND-at-init hazard package.json's overrides comment
# describes: the worklet asks for the version it was bundled against, and if the
# build linked the other one, engine init fails, localDb is null and every worklet
# method breaks. Android's linked bundling tolerates it, so it is iOS-only.
#
# NOT auto-removed, deliberately: choosing which copy to delete needs the version
# the worklet bundle was built against, and deleting the wrong one breaks the app
# at launch rather than bloating it. A warning that names the pair is the useful,
# safe thing to do.
dupes=$(
  find "$ADDONS" -maxdepth 1 -name '*.xcframework' -exec basename {} \; 2>/dev/null \
    | sed 's/\.xcframework$//' \
    | sed 's/\.[0-9][0-9.]*$//' \
    | sort | uniq -d
)

if [ -n "$dupes" ]; then
  echo ""
  echo "Bare addons: WARNING - more than one version vendored for:"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    printf '    %s -> ' "$name"
    find "$ADDONS" -maxdepth 1 -name "${name}.*.xcframework" -exec basename {} \; | tr '\n' ' '
    echo ""
  done <<< "$dupes"
  echo "    Both get linked. On iOS an addon is matched by EXACT version, so this is"
  echo "    the ADDON_NOT_FOUND-at-init hazard (null localDb, every worklet method"
  echo "    fails). Not pruned automatically - see this script's header for why."
fi
