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

# ── The bundle's declared addon list is the source of truth ─────────────────
# bare-pack records, inside the bundle, the EXACT addons + versions the worklet
# resolves - the same list Android links against. Reading it beats maintaining a
# hardcoded name list here, and it is what makes the version check below exact.
BUNDLE="$REPO_ROOT/assets/bare-ios.bundle"
DECLARED=""
if [ -s "$BUNDLE" ]; then
  DECLARED=$(node -e '
    const fs = require("fs")
    const bundle = require("bare-bundle").from(fs.readFileSync(process.argv[1]))
    for (const a of bundle._addons || []) {
      console.log(a.replace(/^linked:/, "").split(".framework")[0])
    }
  ' "$BUNDLE" 2>/dev/null || true)
fi

if [ -z "$DECLARED" ]; then
  echo "Bare addons: WARNING - could not read the addon list from $BUNDLE."
  echo "    Falling back to the QVAC-only rule. Run 'npm run build:bare:ios' if this persists."
fi

declared_has () { printf '%s\n' "$DECLARED" | grep -qx "$1"; }
declared_name () { printf '%s\n' "$DECLARED" | sed 's/\.[0-9][0-9.]*$//' | grep -qx "$1"; }

before=$(du -sk "$ADDONS" | cut -f1)
removed=0

prune () { # <path> <reason>
  echo "    - $(basename "$1")  ($2)"
  rm -rf "$1"
  removed=$((removed + 1))
}

shopt -s nullglob
echo "Bare addons: checking $(ls -d "$ADDONS"/*.xcframework 2>/dev/null | wc -l | tr -d ' ') vendored against $(printf '%s\n' "$DECLARED" | grep -c . || true) declared by the bundle."

for f in "$ADDONS"/*.xcframework; do
  base=$(basename "$f" .xcframework)
  # Addon dirs are <name>.<semver>.xcframework, so the name is everything before
  # the trailing dotted-numeric run. Done with sed rather than ${base%.*} because
  # the version has three components, not one.
  name=$(printf '%s' "$base" | sed 's/\.[0-9][0-9.]*$//')

  # 1. QVAC: stale by definition, this repo has no QVAC dependency.
  case "$base" in qvac__*) prune "$f" "no QVAC dependency"; continue ;; esac

  # Nothing else is touched without a declared list to check against.
  [ -z "$DECLARED" ] && continue

  # 2. bare-ffmpeg: not declared, not in the dependency tree (`npm ls bare-ffmpeg`
  #    is empty), not referenced by either bundle, and - the decisive one - the
  #    SAME worklet runs on Android without it present at all, doing full P2P
  #    sync. At ~12 MB in the IPA it was the largest single item. An A/B build on
  #    the iPhone SE showed no behavioural difference. Named explicitly rather
  #    than swept up by the undeclared rule below, because that rule is not safe
  #    to apply wholesale - see the report at the end.
  case "$name" in bare-ffmpeg) prune "$f" "not declared by the bundle; Android runs without it"; continue ;; esac

  # 3. WRONG VERSION of an addon the bundle DOES declare. This is the sharp one:
  #    iOS matches an addon by EXACT version, so a second copy at another version
  #    is the ADDON_NOT_FOUND-at-init hazard package.json's overrides comment
  #    describes - null localDb, every worklet method failing, silently, iOS only.
  #    Safe to delete precisely BECAUSE the bundle names the version it wants.
  if declared_name "$name" && ! declared_has "$base"; then
    want=$(printf '%s\n' "$DECLARED" | grep "^${name}\." | head -1)
    prune "$f" "bundle wants ${want:-another version}"
    continue
  fi
done
shopt -u nullglob

after=$(du -sk "$ADDONS" | cut -f1)
if [ "$removed" -gt 0 ]; then
  echo "    Removed $removed, reclaimed $(( (before - after) / 1024 )) MB on disk."
  echo "    All of it would have been linked into the IPA by the podspec's"
  echo "    ios/addons/*.xcframework glob, used or not."
else
  echo "Bare addons: nothing to prune."
fi

# ── Report what is left but undeclared - do NOT delete ──────────────────────
# "Not declared by the bundle" does NOT mean "unused at runtime", and there is a
# live counter-example: bare-dns is undeclared, yet Android ships it and the app
# needs hostname resolution to reach the DHT bootstrap nodes. bare-pack records
# STATIC requires; anything reached through a dynamic path is invisible to it.
#
# So the undeclared set is reported, with sizes, and left alone. bare-ffmpeg was
# promoted out of this list only because Android independently proves the worklet
# runs without it. Anything else needs the same standard before it is removed.
if [ -n "$DECLARED" ]; then
  shopt -s nullglob
  undeclared=()
  for f in "$ADDONS"/*.xcframework; do
    base=$(basename "$f" .xcframework)
    name=$(printf '%s' "$base" | sed 's/\.[0-9][0-9.]*$//')
    declared_name "$name" || undeclared+=("$base")
  done
  shopt -u nullglob
  if [ ${#undeclared[@]} -gt 0 ]; then
    echo ""
    echo "Bare addons: ${#undeclared[@]} vendored but NOT declared by the bundle (kept, not pruned):"
    printf '    %s\n' "${undeclared[@]}"
    echo "    These still ship. Undeclared is not proof of unused - bare-dns is"
    echo "    undeclared and Android needs it for DHT bootstrap hostnames. Removing"
    echo "    one needs evidence it is unreachable, not just absence from this list."
  fi
fi
