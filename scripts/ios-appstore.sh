#!/usr/bin/env bash
# iOS App Store archive + upload script
# Run this directly on the Mac Mini (not via SSH).
#
# Usage: ./scripts/ios-appstore.sh
#
# Required env vars (or set in scripts/.env) - one of these auth methods:
#
#   Preferred (API key via asc CLI):
#     ASC_KEY_ID           - App Store Connect API key ID
#     ASC_ISSUER_ID        - App Store Connect API issuer ID
#     ASC_APP_ID           - Numeric App Store app ID (from `asc apps list`)
#     ASC_PRIVATE_KEY_PATH - Path to .p8 key (default: ~/.appstoreconnect/AuthKey_<KEY_ID>.p8)
#
#   Legacy (app-specific password via altool):
#     ASC_APPLE_ID         - Apple ID email
#     ASC_APP_PASSWORD     - App-specific password (appleid.apple.com → App-Specific Passwords)
#
# Optional env vars:
#   ASC_TEAM_ID        - Team ID (default: G79ALD29NA)
#   ARCHIVE_PATH       - Path to existing .xcarchive to skip rebuild (default: builds fresh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load app config and env
if [ -f "$SCRIPT_DIR/app.conf" ]; then
  set -a; source "$SCRIPT_DIR/app.conf"; set +a
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# ── Determine upload method ─────────────────────────────────────────────────
# Prefer asc CLI (API key auth), fall back to altool (app-specific password)
USE_ASC=false
if command -v asc &>/dev/null \
   && [ -n "${ASC_KEY_ID:-}" ] \
   && [ -n "${ASC_ISSUER_ID:-}" ] \
   && [ -n "${ASC_APP_ID:-}" ]; then
  USE_ASC=true
  echo "Upload method: asc CLI (API key auth)"
elif [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ]; then
  echo "Upload method: altool (app-specific password, legacy)"
else
  echo "Error: No upload credentials configured."
  echo "  Option A (preferred): Install 'asc' and set ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID"
  echo "  Option B (legacy):    Set ASC_APPLE_ID and ASC_APP_PASSWORD"
  exit 1
fi

TEAM_ID="${ASC_TEAM_ID:-G79ALD29NA}"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/${APP_NAME}.xcarchive}"
EXPORT_PATH="/tmp/${APP_NAME}-appstore"
EXPORT_OPTIONS="/tmp/ExportOptions.plist"

# ── Authenticate ────────────────────────────────────────────────────────────
# Log in BEFORE the archive, not just before the upload: the build number below
# is read from App Store Connect, so the session has to exist by then.
if $USE_ASC; then
  ASC_KEY_FILE="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  asc auth login \
    --bypass-keychain \
    --name "${APP_NAME}-CI" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$ASC_KEY_FILE"
fi

# ── Write ExportOptions.plist ───────────────────────────────────────────────
cat > "$EXPORT_OPTIONS" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${BUNDLE_ID}</key>
    <string>${IOS_PROVISIONING_PROFILE}</string>
  </dict>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>uploadSymbols</key>
  <false/>
</dict>
</plist>
EOF

# ── Unlock signing keychain and grant codesign access ───────────────────────
# unlock-keychain: allows access in this session
# list-keychains -s: makes it visible to all child processes
# set-key-partition-list: grants apple-tool/codesign access to private keys,
#   fixing errSecInternalComponent when the distribution pipeline re-signs
#   embedded frameworks like BareKit.framework over SSH
security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain
security list-keychains -s \
  ~/Library/Keychains/buildkey.keychain \
  ~/Library/Keychains/login.keychain-db \
  /Library/Keychains/System.keychain
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "" \
  ~/Library/Keychains/buildkey.keychain

# ── Xcode PATH ─────────────────────────────────────────────────────────────
# Xcode's distribution pipeline invokes rsync internally.  If Homebrew's GNU
# rsync (3.4.x) is on PATH it conflicts with Apple's built-in openrsync,
# causing "Copy failed" during IPA packaging.  Strip /opt/homebrew/bin from
# PATH for xcodebuild invocations so the system rsync is found instead.
XCODE_PATH=$(printf '%s' "$PATH" | sed 's|/opt/homebrew/bin:||g; s|:/opt/homebrew/bin||g')

# ── Pods ────────────────────────────────────────────────────────────────────
# Resync Pods to the current Podfile. The release rsync copies the repo over and
# can leave the CocoaPods sandbox out of sync with Podfile.lock, which fails the
# "Check Pods Manifest.lock" build phase during archive. UTF-8 env is required:
# CocoaPods' UnicodeNormalize crashes without it.
echo "Running pod install..."
( cd "$REPO_ROOT/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install ) 2>&1 | tail -3

# ── Version + build number ──────────────────────────────────────────────────
# Everything Apple sees comes from the LITERALS in ios/<App>/Info.plist:
# CFBundleShortVersionString (the 1.0.2 users see) and CFBundleVersion (the
# build number). NOTHING else reaches the bundle:
#
#   - `expo prebuild` is the only thing that rewrites Info.plist from app.json,
#     and release.sh runs it as `--clean -p android` - ANDROID ONLY. The iOS
#     project is never regenerated.
#   - The pbxproj MARKETING_VERSION / CURRENT_PROJECT_VERSION that release.sh
#     seds are inert: this Info.plist holds literals and does not reference
#     $(MARKETING_VERSION) or $(CURRENT_PROJECT_VERSION).
#   - release.sh rsyncs ios/ to the Mac (it excludes only ios/Pods, ios/build
#     and the xcworkspace), so the Mac's Info.plist is OVERWRITTEN by the repo
#     copy on every release.
#
# So both literals were frozen at whatever the last iOS prebuild wrote. That
# shipped v1.0.2 to App Store Connect labelled 1.0.0, and before that made every
# upload reuse one build number until Apple rejected it ("bundle version must be
# higher than the previously uploaded version").
#
# Fix: set both here, immediately before the archive, and mirror them into the
# pbxproj and app.json so the three cannot drift apart again.
#   - Marketing version: taken verbatim from app.json expo.version (release.sh
#     has already set that to the release being cut). Override: IOS_MARKETING_VERSION.
#   - Build number: max of the three current values + 1, which self-heals when
#     they disagree - and they always do, since the rsync keeps re-planting a
#     stale plist. Override: IOS_BUILD_NUMBER.
INFO_PLIST="$REPO_ROOT/ios/${APP_NAME}/Info.plist"
PBXPROJ="$REPO_ROOT/${XCODE_PROJECT:-ios/${APP_NAME}.xcodeproj/project.pbxproj}"

# ── Marketing version (CFBundleShortVersionString) ──
if [ -n "${IOS_MARKETING_VERSION:-}" ]; then
  MARKETING="$IOS_MARKETING_VERSION"
  echo "Version: ${MARKETING} (forced via IOS_MARKETING_VERSION)"
else
  MARKETING=$(node -p "require('$REPO_ROOT/app.json').expo.version" 2>/dev/null || echo "")
  _plist_marketing=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST" 2>/dev/null || echo "")
  echo "Version: ${MARKETING} (from app.json; plist was ${_plist_marketing:-unset})"
fi
if ! printf '%s' "$MARKETING" | grep -Eq '^[0-9]+(\.[0-9]+)*$'; then
  echo "Error: refusing to archive - marketing version '${MARKETING}' is not a dotted number."
  echo "  Set expo.version in app.json, or pass IOS_MARKETING_VERSION=<x.y.z>."
  exit 1
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${MARKETING}" "$INFO_PLIST"
perl -0pi -e "s/MARKETING_VERSION = [0-9][0-9.]*;/MARKETING_VERSION = ${MARKETING};/g" "$PBXPROJ"

# ── Build number (CFBundleVersion) ──
# App Store Connect is the source of truth, NOT any local file. Local state
# cannot be trusted here: release.sh rsyncs Linux -> Mac only, so a build number
# this script writes on the Mac never travels back, and the next release starts
# from a stale value and collides. Asking Apple sidesteps that entirely.
#
# next-build-number counts uploads that have not finished processing yet, so
# back-to-back runs do not collide. Deliberately NOT scoped with --version:
# per-version it restarts at 1 for a train that has no builds yet (verified:
# 1.0.3 returns nextBuildNumber 1), while unscoped it returns the app-wide
# maximum and stays monotonic forever.
#
# The local max is kept as a FLOOR, so a failed or unavailable query (altool
# auth, no network, asc missing) degrades to the previous behaviour rather than
# shipping a number below what the local files already claim.
_plist_build=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST" 2>/dev/null | tr -dc '0-9')
_pbx_build=$(grep -m1 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | tr -dc '0-9')
_json_build=$(node -p "parseInt(require('$REPO_ROOT/app.json').expo.ios.buildNumber||'0',10)" 2>/dev/null || echo 0)
_plist_build=${_plist_build:-0}; _pbx_build=${_pbx_build:-0}; _json_build=${_json_build:-0}

_local_max=$_plist_build
for n in "$_pbx_build" "$_json_build"; do
  [ "$n" -gt "$_local_max" ] && _local_max="$n"
done
_local_next=$(( _local_max + 1 ))

_asc_next=0
if $USE_ASC; then
  _asc_next=$(asc builds next-build-number --app "$ASC_APP_ID" --platform IOS 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(parseInt(JSON.parse(s).nextBuildNumber,10)||0))}catch(e){process.stdout.write('0')}})" 2>/dev/null || echo 0)
  _asc_next=$(printf '%s' "${_asc_next:-0}" | tr -dc '0-9')
  _asc_next=${_asc_next:-0}
fi

if [ -n "${IOS_BUILD_NUMBER:-}" ]; then
  NEXT_BUILD="$IOS_BUILD_NUMBER"
  echo "Build number: ${NEXT_BUILD} (forced via IOS_BUILD_NUMBER)"
elif [ "$_asc_next" -gt 0 ]; then
  NEXT_BUILD=$_asc_next
  [ "$_local_next" -gt "$NEXT_BUILD" ] && NEXT_BUILD=$_local_next
  echo "Build number: ${NEXT_BUILD} (App Store Connect next=${_asc_next}, local floor=${_local_next})"
else
  NEXT_BUILD=$_local_next
  echo "Build number: ${NEXT_BUILD} (App Store Connect unavailable, fell back to local max: plist=${_plist_build} pbxproj=${_pbx_build} app.json=${_json_build})"
fi

# Write NEXT_BUILD everywhere: the plist literal is what actually ships; the
# pbxproj and app.json are kept in sync so release.sh and a later prebuild agree.
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${NEXT_BUILD}" "$INFO_PLIST"
perl -0pi -e "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${NEXT_BUILD};/g" "$PBXPROJ"
NEXT_BUILD="$NEXT_BUILD" node -e "
  const fs = require('fs'), f = '$REPO_ROOT/app.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.expo.ios = j.expo.ios || {};
  j.expo.ios.buildNumber = String(process.env.NEXT_BUILD);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
"

# ── Archive ─────────────────────────────────────────────────────────────────
rm -rf "$ARCHIVE_PATH"
echo "Archiving..."
PATH="$XCODE_PATH" xcodebuild \
  -workspace "$REPO_ROOT/${XCODE_WORKSPACE}" \
  -scheme "$XCODE_SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" \
  archive | grep -E "^(error:|warning:|note:|.*ARCHIVE)" || true
# xcodebuild's failure is masked by the grep pipe above, so verify the archive
# actually exists rather than pressing on to a confusing "archive not found".
if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: archive was not created at $ARCHIVE_PATH (see xcodebuild output above)."
  exit 1
fi
echo "Archive complete: $ARCHIVE_PATH"

# ── Export ──────────────────────────────────────────────────────────────────
echo "Exporting..."
rm -rf "$EXPORT_PATH"
PATH="$XCODE_PATH" xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  2>&1 | grep -v "^2[0-9][0-9][0-9]-" || true  # suppress timestamp lines

IPA_PATH=$(find "$EXPORT_PATH" -name "*.ipa" | head -1)
if [ -z "$IPA_PATH" ]; then
  echo "Error: export failed — no .ipa found in $EXPORT_PATH"
  exit 1
fi
echo "Export complete: $IPA_PATH"

# ── Upload ──────────────────────────────────────────────────────────────────
echo "Uploading to App Store Connect..."
if $USE_ASC; then
  asc builds upload --app "$ASC_APP_ID" --ipa "$IPA_PATH"
else
  xcrun altool \
    --upload-app \
    --type ios \
    --file "$IPA_PATH" \
    --username "$ASC_APPLE_ID" \
    --password "$ASC_APP_PASSWORD" \
    --show-progress
fi

echo ""
echo "Upload complete. Build is processing on App Store Connect."
