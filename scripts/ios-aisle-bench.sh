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

# ── Run ──
# THE APP DOES NOT SURVIVE A FULL MATRIX. Observed 2026-07-26: it exits cleanly
# (code 0, nothing logged, 60ms after a successful classification) around 50 calls
# in. So this is a LOOP: work out what is still missing, launch with that as the
# work list, watch until the app goes quiet or finishes, repeat. The log is
# appended to across launches and the report rebuilds the grades from every call
# line, so a run is the sum of its launches.
# Results come from the app's OWN FILE (Documents/bench-results.jsonl), not the
# console. A Release build's info-level console.log does not reliably reach the
# device log: error lines from other modules arrived while every [BENCH] line
# vanished, so the driver saw silence and relaunched forever while the app was in
# fact loading the model each time. The console stream is still captured, because
# it is where a native crash would show up, but nothing depends on it.
#
# Append, do not truncate: calls already recorded are answers already paid for, so
# a re-run of this script resumes rather than starting over. FRESH=1 to discard.
[ "${FRESH:-0}" = "1" ] && { : > "$LOG"; : > "$JSONL"; }
touch "$LOG" "$JSONL"
RESULTS_FILE="$APP_CONTAINER/Documents/bench-results.jsonl"
xcrun simctl spawn "$UDID" log stream --style compact --level debug \
  --predicate "processImagePath CONTAINS \"$APP_NAME\"" >> "$LOG" 2>/dev/null &
STREAM_PID=$!
# shellcheck disable=SC2064
trap "kill $STREAM_PID 2>/dev/null || true; xcrun simctl terminate '$UDID' '$BUNDLE_ID' 2>/dev/null || true; rm -f '$APP_CONTAINER/Documents/bench-config'" EXIT
sleep 2

# Merge whatever the app has written into the accumulated results.
harvest () {
  [ -s "$RESULTS_FILE" ] || return 0
  cat "$RESULTS_FILE" >> "$JSONL"
  : > "$RESULTS_FILE"
}

# Seconds without a new [BENCH] line before we call the app dead and relaunch.
# A single call takes about a second on an M-series Mac, so 60s is not ambiguous.
QUIET_S="${QUIET_S:-60}"
MAX_LAUNCHES="${MAX_LAUNCHES:-40}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
LAUNCH=0

while [ "$LAUNCH" -lt "$MAX_LAUNCHES" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  harvest
  PAIRS=$(node "$REPO_ROOT/scripts/aisle-bench-plan.mjs" "$JSONL" "$REPEATS" "$VARIANTS" "$ITEMS" || true)
  if [ -z "$PAIRS" ]; then echo "==> Every (variant, item) has its ${REPEATS} answers"; break; fi

  REMAINING=$(printf '%s' "$PAIRS" | grep -o '\[\"' | wc -l | tr -d ' ')
  LAUNCH=$(( LAUNCH + 1 ))
  echo "==> Launch $LAUNCH: $REMAINING (variant, item) pairs still short of $REPEATS answers"

  CFG="{\"repeats\":$REPEATS,\"pairs\":$PAIRS"
  [ -n "$ITEMS" ] && CFG="$CFG,\"items\":$ITEMS"
  CFG="$CFG}"
  printf '%s' "$CFG" > "$APP_CONTAINER/Documents/bench-config"

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

  # Watch this launch via the app's own results file: finished, aborted, or gone
  # quiet (= died, relaunch). The first call also has to wait out the model load,
  # which is why the quiet window is generous.
  LAST_N=0
  LAST_CHANGE=$(date +%s)
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    N=$(wc -l < "$RESULTS_FILE" 2>/dev/null | tr -d ' ' || echo 0)
    [ -z "$N" ] && N=0
    if [ "$N" -gt "$LAST_N" ]; then
      LAST_N=$N; LAST_CHANGE=$(date +%s)
      DONE_CALLS=$(grep -c '"type":"call"' "$RESULTS_FILE" 2>/dev/null || echo 0)
      printf '\r    %s calls this launch   ' "$DONE_CALLS"
    fi
    if grep -q '"type":"done"' "$RESULTS_FILE" 2>/dev/null; then echo ""; echo "    launch finished its work list"; break; fi
    if grep -q '"type":"abort"' "$RESULTS_FILE" 2>/dev/null; then
      echo ""
      echo "    ABORTED: $(grep '"type":"abort"' "$RESULTS_FILE" | tail -1)"
      harvest
      break 2
    fi
    if [ $(( $(date +%s) - LAST_CHANGE )) -ge "$QUIET_S" ]; then
      echo ""
      echo "    app went quiet after $LAST_N lines - relaunching to continue"
      break
    fi
    sleep 5
  done
done

# ── Results ──
harvest
echo ""
echo "==> [BENCH] lines: $(wc -l < "$JSONL" | tr -d ' ')  ->  $JSONL"
echo ""
# Graded here rather than trusting any single launch's summary: the run is the
# sum of its launches, and the report is what stitches them together.
node "$REPO_ROOT/scripts/aisle-bench-report.mjs" "$JSONL" || true
