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

# ── Build number ────────────────────────────────────────────────────────────
# This script archives the existing ios/ project as-is (no `expo prebuild`), so
# the shipped CFBundleVersion is the LITERAL in ios/<App>/Info.plist. app.json's
# ios.buildNumber and the pbxproj CURRENT_PROJECT_VERSION only reach the bundle
# when a prebuild regenerates the project, which never happens here. Nothing was
# bumping that literal, so every run re-uploaded the same build and App Store
# Connect rejected it: "bundle version must be higher than the previously
# uploaded version". (release.sh avoids this because its --clean prebuild rewrites
# Info.plist from app.json; the standalone iOS path had no such step.)
#
# Fix: pick the next build number and write it to all three places so they stay
# in lockstep. Source of truth is the max the three files currently hold (self-
# healing when they disagree, as they did here: plist=4, pbxproj=6, app.json=7),
# plus one. Set IOS_BUILD_NUMBER=<n> to force a value when a build was uploaded
# from another machine and the local files are behind App Store Connect.
INFO_PLIST="$REPO_ROOT/ios/${APP_NAME}/Info.plist"
PBXPROJ="$REPO_ROOT/${XCODE_PROJECT:-ios/${APP_NAME}.xcodeproj/project.pbxproj}"

_plist_build=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST" 2>/dev/null | tr -dc '0-9')
_pbx_build=$(grep -m1 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | tr -dc '0-9')
_json_build=$(node -p "parseInt(require('$REPO_ROOT/app.json').expo.ios.buildNumber||'0',10)" 2>/dev/null || echo 0)
_plist_build=${_plist_build:-0}; _pbx_build=${_pbx_build:-0}; _json_build=${_json_build:-0}

if [ -n "${IOS_BUILD_NUMBER:-}" ]; then
  NEXT_BUILD="$IOS_BUILD_NUMBER"
  echo "Build number: ${NEXT_BUILD} (forced via IOS_BUILD_NUMBER)"
else
  _max=$_plist_build
  for n in "$_pbx_build" "$_json_build"; do
    [ "$n" -gt "$_max" ] && _max="$n"
  done
  NEXT_BUILD=$(( _max + 1 ))
  echo "Build number: ${NEXT_BUILD} (was plist=${_plist_build} pbxproj=${_pbx_build} app.json=${_json_build}; bumped)"
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
  ASC_KEY_FILE="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/AuthKey_${ASC_KEY_ID}.p8}"
  asc auth login \
    --bypass-keychain \
    --name "${APP_NAME}-CI" \
    --key-id "$ASC_KEY_ID" \
    --issuer-id "$ASC_ISSUER_ID" \
    --private-key "$ASC_KEY_FILE"

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
