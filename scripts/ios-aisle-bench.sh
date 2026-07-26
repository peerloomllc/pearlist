#!/usr/bin/env bash
# Aisle-prompt harness driver — runs ON the Mac Mini, against the iOS Simulator.
#
# Builds PearList for the Simulator, installs it, drops a Documents/bench-config
# file in (same delivery as the screenshot scene: simctl openurl would pop an
# "Open in ...?" sheet), cold-launches, and streams the console until the harness
# prints its [BENCH] done line. Every [BENCH] line is written to a log.
#
# The Simulator is the right host for the ACCURACY question (same model, same
# sampling, and an M-series Mac runs many more repeats per minute than a phone).
# It is the WRONG host for absolute seconds-per-item: confirm the winning variant
# on a real phone before quoting latency. The prefill/decode RATIO does carry over.
#
# Usage (on Mac Mini):
#   cd ~/peerloomllc/pearlist && ./scripts/ios-aisle-bench.sh
#   REPEATS=3 VARIANTS=v11,v4 ITEMS=6 SKIP_BUILD=1 ./scripts/ios-aisle-bench.sh
#
# Output: metadata/bench/ios-aisle-bench.log (+ .jsonl of just the [BENCH] lines)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/scripts/app.conf" ]; then
  set -a; source "$REPO_ROOT/scripts/app.conf"; set +a
fi
APP_NAME="${APP_NAME:-PearList}"
BUNDLE_ID="${BUNDLE_ID:-com.pearlist}"
XCODE_WORKSPACE="${XCODE_WORKSPACE:-ios/${APP_NAME}.xcworkspace}"
XCODE_SCHEME="${XCODE_SCHEME:-$APP_NAME}"

REPEATS="${REPEATS:-5}"
VARIANTS="${VARIANTS:-}"          # empty = every variant in src/aisleFewshot.js
ITEMS="${ITEMS:-}"                # empty = the whole labelled set
TIMEOUT="${TIMEOUT:-5400}"        # seconds to wait for the run (model download included)

# One device is enough: this measures the model, not the screen. Resolved BY NAME
# and created if missing, deliberately NOT reusing IOS_SCREENSHOT_DEVICES - that
# UDID went stale (a deleted simulator) and the whole run died on "Invalid device"
# after a full build. A dedicated sim also keeps the ~0.8 GB model and this app's
# state out of the other projects' simulators.
NAME="${BENCH_DEVICE_NAME:-PearListBench}"
DEVICE_TYPE="${BENCH_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
# sed, not awk's match(): macOS ships BWK awk, which has no 3-argument match().
# The `|| true` is load-bearing: under `set -o pipefail` a no-match grep fails the
# whole pipeline, and `set -e` then kills the script HERE - i.e. exactly when the
# simulator does not exist yet and the next line was about to create it.
UDID=$(xcrun simctl list devices available | grep -E "^ *${NAME} \(" | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/' || true)
if [ -z "$UDID" ]; then
  RUNTIME=$(xcrun simctl list runtimes | awk '/^iOS /{print $NF}' | tail -1)
  echo "==> Creating simulator $NAME ($DEVICE_TYPE on $RUNTIME)"
  UDID=$(xcrun simctl create "$NAME" "$DEVICE_TYPE" "$RUNTIME")
fi

OUT_DIR="$REPO_ROOT/metadata/bench"
LOG="$OUT_DIR/ios-aisle-bench.log"
JSONL="$OUT_DIR/ios-aisle-bench.jsonl"
mkdir -p "$OUT_DIR"

# ── Build ──
if [ "${SKIP_BUILD:-0}" != "1" ]; then
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

APP_PATH=$(ls -d ~/Library/Developer/Xcode/DerivedData/${APP_NAME}-*/Build/Products/Release-iphonesimulator/${APP_NAME}.app 2>/dev/null | head -1 || true)
if [ -z "$APP_PATH" ]; then echo "Error: ${APP_NAME}.app not found in DerivedData (build it without SKIP_BUILD=1)" >&2; exit 1; fi
echo "    App: $APP_PATH"

echo "==> Device: $NAME ($UDID)"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
for _try in 1 2 3 4 5; do
  xcrun simctl install "$UDID" "$APP_PATH" 2>/dev/null || true
  xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app >/dev/null 2>&1 && break
  sleep 2
done

APP_CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)
mkdir -p "$APP_CONTAINER/Documents"

# Build the config the shell reads at launch.
CFG="{\"repeats\":$REPEATS"
[ -n "$VARIANTS" ] && CFG="$CFG,\"variants\":[$(echo "$VARIANTS" | awk -F, '{for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}}')]"
[ -n "$ITEMS" ] && CFG="$CFG,\"items\":$ITEMS"
CFG="$CFG}"
echo "    Config: $CFG"
printf '%s' "$CFG" > "$APP_CONTAINER/Documents/bench-config"

# ── Run ──
# Stream the sim's console BEFORE launching so nothing is missed. The predicate is
# deliberately broad (the RN console goes through several subsystems); [BENCH] is
# what we filter on when reading it back.
: > "$LOG"
xcrun simctl spawn "$UDID" log stream --style compact --level debug \
  --predicate "processImagePath CONTAINS \"$APP_NAME\"" >> "$LOG" 2>/dev/null &
STREAM_PID=$!
# shellcheck disable=SC2064
trap "kill $STREAM_PID 2>/dev/null || true; xcrun simctl terminate '$UDID' '$BUNDLE_ID' 2>/dev/null || true; rm -f '$APP_CONTAINER/Documents/bench-config'" EXIT
sleep 2

xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
echo "==> Launching harness (up to ${TIMEOUT}s; the first run downloads ~0.8 GB)"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

# Wait for the harness to finish, reporting progress as variants complete.
DEADLINE=$(( $(date +%s) + TIMEOUT ))
LAST_SEEN=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if grep -q '\[BENCH\].*"type":"done"' "$LOG" 2>/dev/null; then echo "==> Harness finished"; break; fi
  if grep -q '\[BENCH\].*"type":"abort"' "$LOG" 2>/dev/null; then echo "==> Harness ABORTED (see $LOG)"; break; fi
  N=$(grep -c '\[BENCH\]' "$LOG" 2>/dev/null || echo 0)
  if [ "$N" -gt "$LAST_SEEN" ]; then
    grep '\[BENCH\]' "$LOG" | tail -n $(( N - LAST_SEEN )) | grep -E '"type":"(start|model|variant-start|variant|skip|error)"' || true
    LAST_SEEN=$N
  fi
  sleep 10
done

# ── Results ──
grep -o '\[BENCH\] .*' "$LOG" | sed 's/^\[BENCH\] //' > "$JSONL" || true
echo ""
echo "==> [BENCH] lines: $(wc -l < "$JSONL" | tr -d ' ')  ->  $JSONL"
echo "==> Summary:"
grep '"type":"variant"' "$JSONL" 2>/dev/null || echo "    (no variant summaries - check $LOG)"
grep '"type":"summary"' "$JSONL" 2>/dev/null || true
