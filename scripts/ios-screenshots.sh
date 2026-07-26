#!/usr/bin/env bash
# iOS App Store screenshot capture — runs on Mac Mini.
# Builds PearList for the iOS Simulator, then loops scenes × appearances
# on each configured device, cold-launching via a pear://pearlist/screenshot/<N>
# deep link (simctl openurl; the shell reads it and injects the scene) and
# capturing PNGs via xcrun simctl io screenshot. Needs the UI fixtures harness.
#
# Usage (on Mac Mini):
#   cd ~/peerloomllc/pearlist && SKIP_BUILD=1 ./scripts/ios-screenshots.sh
#   SKIP_BUILD=1 skips xcodebuild (useful when iterating on fixtures only)
#
# Output: /tmp/pearlist-screenshots/<device-name>/<appearance>/scene-N.png

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load app config (APP_NAME / BUNDLE_ID / XCODE_WORKSPACE / XCODE_SCHEME)
if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
APP_NAME="${APP_NAME:-PearList}"
BUNDLE_ID="${BUNDLE_ID:-com.pearlist}"
XCODE_WORKSPACE="${XCODE_WORKSPACE:-ios/${APP_NAME}.xcworkspace}"
XCODE_SCHEME="${XCODE_SCHEME:-$APP_NAME}"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/metadata/ios/screenshots}"
SCENES=(1 2 3 4 5 6)
APPEARANCES=(light)

# Devices from IOS_SCREENSHOT_DEVICES (space-separated "DeviceName|DeviceType"
# pairs, set in scripts/app.conf). iPhone 17 Pro Max = 6.9" App Store size.
#
# NAME, not UDID, on purpose. This used to carry hardcoded UDIDs, and when one of
# those simulators was deleted the script died on "Invalid device" AFTER a full pod
# install and Xcode build - the most expensive possible place to find out. Now each
# entry names a simulator and the device type to create it from if it is missing, so
# a wiped simulator costs one create instead of a broken release chore.
read -ra DEVICES <<<"${IOS_SCREENSHOT_DEVICES:-iPhone-17-Pro-Max|com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max}"

# Resolve a simulator by name, creating it from the given device type if absent.
# Echoes the UDID. The `|| true` matters: under pipefail a no-match grep would fail
# the pipeline and `set -e` would kill the script exactly when the sim is missing.
resolve_sim () {
  local name="$1" type="$2" udid runtime
  udid=$(xcrun simctl list devices available | grep -E "^ *${name} \(" | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/' || true)
  if [ -z "$udid" ]; then
    runtime=$(xcrun simctl list runtimes | awk '/^iOS /{print $NF}' | tail -1)
    echo "    creating simulator $name ($type on $runtime)" >&2
    udid=$(xcrun simctl create "$name" "$type" "$runtime")
  fi
  echo "$udid"
}

# ── Build ──
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  # Resync Pods to the current Podfile after the rsync (which excludes ios/Pods).
  # UTF-8 env is required: CocoaPods' UnicodeNormalize crashes without it.
  echo "==> pod install..."
  (cd "$REPO_ROOT/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install) 2>&1 | tail -3
  echo "==> Building for iOS Simulator..."
  cd "$REPO_ROOT"
  xcodebuild -workspace "$XCODE_WORKSPACE" -scheme "$XCODE_SCHEME" \
    -configuration Release \
    -destination "generic/platform=iOS Simulator" \
    -sdk iphonesimulator \
    CODE_SIGNING_ALLOWED=NO 2>&1 | tail -3
fi

APP_PATH=$(ls -d ~/Library/Developer/Xcode/DerivedData/${APP_NAME}-*/Build/Products/Release-iphonesimulator/${APP_NAME}.app 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  echo "Error: ${APP_NAME}.app not found in DerivedData" >&2
  exit 1
fi
echo "    App: $APP_PATH"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for dev in "${DEVICES[@]}"; do
  NAME="${dev%%|*}"
  TYPE="${dev##*|}"
  UDID=$(resolve_sim "$NAME" "$TYPE")
  echo ""
  echo "==> Device: $NAME ($UDID)"

  # Boot (idempotent). We deliver scenes via a file + normal launch (not
  # simctl openurl), so no SpringBoard "Open in ...?" confirmation is ever
  # triggered - as long as the sim was never openurl'd with a pear:// URL.
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  # Install can hit a transient "Authorization is required to install the
  # packages" on the first attempt (CoreSimulator state); retry until the app is
  # actually present. If it keeps failing, restart the service:
  #   xcrun simctl shutdown all; killall -9 com.apple.CoreSimulator.CoreSimulatorService
  for _try in 1 2 3 4 5; do
    xcrun simctl install "$UDID" "$APP_PATH" 2>/dev/null || true
    xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app >/dev/null 2>&1 && break
    sleep 2
  done

  # Scene is delivered via Documents/screenshot-scene (see the shell). simctl
  # openurl on a custom scheme shows an "Open in ...?" confirmation that would
  # cover the frame, so we write a file + launch normally instead.
  APP_CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)
  mkdir -p "$APP_CONTAINER/Documents"

  # Pretty status bar: 9:41, full signal + battery
  xcrun simctl status_bar "$UDID" override \
    --time "9:41" \
    --dataNetwork wifi \
    --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100

  for appearance in "${APPEARANCES[@]}"; do
    xcrun simctl ui "$UDID" appearance "$appearance"
    DARK=0; [ "$appearance" = "dark" ] && DARK=1
    mkdir -p "$OUT_DIR/$NAME/$appearance"
    for scene in "${SCENES[@]}"; do
      echo "    → $appearance scene $scene"
      xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
      # Write the scene, then cold-launch normally (no openurl confirmation). The
      # shell reads Documents/screenshot-scene and injects it before the bundle runs.
      printf '%s' "$scene" > "$APP_CONTAINER/Documents/screenshot-scene"
      xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
      sleep 5
      xcrun simctl io "$UDID" screenshot "$OUT_DIR/$NAME/$appearance/scene-$scene.png" >/dev/null 2>&1
    done
  done

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  rm -f "$APP_CONTAINER/Documents/screenshot-scene"
  xcrun simctl status_bar "$UDID" clear
done

echo ""
echo "==> Done. PNGs in $OUT_DIR"
find "$OUT_DIR" -name "*.png" | sort
