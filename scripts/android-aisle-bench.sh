#!/usr/bin/env bash
# Aisle-prompt harness on a real Android phone (the TCL).
#
# WHY THIS EXISTS ALONGSIDE THE SIMULATOR DRIVER. The Simulator answers the
# ACCURACY question cheaply - same model, same sampling, many more repeats per
# minute. It cannot answer "how long does this take on a phone": an M4 runs the
# same call about 7x faster. The shipped baseline (5.9s/item) is a TCL number, so
# any speed claim has to be re-measured here to be comparable.
#
# Same shape as the iOS driver: write a work list into the app's files dir,
# launch, read the app's own results file back, relaunch for whatever is missing.
# Uses run-as, which works because the debug build is debuggable.
#
# Usage:
#   ./scripts/android-aisle-bench.sh                      # every variant
#   VARIANTS=v11,v4 REPEATS=2 ./scripts/android-aisle-bench.sh
#   SERIAL=<adb serial> ./scripts/android-aisle-bench.sh
#
# Output: metadata/bench/android-aisle-bench.jsonl (+ a printed table)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERIAL="${SERIAL:-4H65K7MFZXSCSWPR}"     # the TCL, the disposable test phone
APP_ID="${APP_ID:-com.pearlist.debug}"
REPEATS="${REPEATS:-3}"
VARIANTS="${VARIANTS:-}"
ITEMS="${ITEMS:-}"
QUIET_S="${QUIET_S:-180}"                # a phone call takes ~6s, and the model load is slow
MAX_LAUNCHES="${MAX_LAUNCHES:-40}"
TIMEOUT="${TIMEOUT:-5400}"

OUT_DIR="$REPO_ROOT/metadata/bench"
JSONL="$OUT_DIR/android-aisle-bench.jsonl"
mkdir -p "$OUT_DIR"
# FRESH clears the APP's results file too - see the iOS driver for the run this
# cost. Clearing only the driver's copy leaves stale answers to be harvested.
if [ "${FRESH:-0}" = "1" ]; then
  : > "$JSONL"
  $ADB shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  $ADB shell run-as "$APP_ID" rm -f files/bench-results.jsonl >/dev/null 2>&1 || true
fi
touch "$JSONL"

ADB="adb -s $SERIAL"
$ADB get-state >/dev/null 2>&1 || { echo "Error: $SERIAL not reachable by adb" >&2; exit 1; }
$ADB shell pm list packages | grep -q "$APP_ID" || { echo "Error: $APP_ID not installed on $SERIAL" >&2; exit 1; }

# The app writes Documents/bench-results.jsonl, which on Android is the app's
# private files dir - reachable only through run-as, hence the debug build.
appfile () { $ADB shell run-as "$APP_ID" "$@"; }

echo "==> Device: $SERIAL ($APP_ID)"
echo "    Model load on a phone takes a while; the first call of each launch waits for it."

trap '$ADB shell am force-stop "$APP_ID" >/dev/null 2>&1 || true; appfile rm -f files/bench-config >/dev/null 2>&1 || true' EXIT

# ONLY EVER CALLED WITH THE APP STOPPED. The app rewrites its whole results file
# on every call, so reading (and especially deleting) it while the app is alive
# races the write and can take a truncated copy or lose answers outright. Harvest
# at launch boundaries, where the app is force-stopped and the file is at rest.
harvest () {
  $ADB shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  sleep 1
  local tmp
  tmp=$(mktemp)
  if appfile cat files/bench-results.jsonl > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    tr -d '\r' < "$tmp" >> "$JSONL"
    appfile sh -c 'rm -f files/bench-results.jsonl' >/dev/null 2>&1 || true
  fi
  rm -f "$tmp"
}

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
  # base64 through the shell: the config is JSON full of quotes and brackets, and
  # adb shell quoting mangles it otherwise.
  B64=$(printf '%s' "$CFG" | base64 -w0)
  $ADB shell "run-as $APP_ID sh -c 'echo $B64 | base64 -d > files/bench-config'"

  $ADB shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  $ADB shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

  LAST_N=0
  LAST_CHANGE=$(date +%s)
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    N=$(appfile sh -c 'wc -l < files/bench-results.jsonl' 2>/dev/null | tr -d ' \r' || echo 0)
    [ -z "$N" ] && N=0
    if [ "$N" -gt "$LAST_N" ]; then
      LAST_N=$N; LAST_CHANGE=$(date +%s)
      printf '\r    %s lines this launch   ' "$N"
    fi
    if appfile sh -c 'grep -c "\"type\":\"done\"" files/bench-results.jsonl' 2>/dev/null | grep -qv '^0'; then
      echo ""; echo "    launch finished its work list"; break
    fi
    if appfile sh -c 'grep -c "\"type\":\"abort\"" files/bench-results.jsonl' 2>/dev/null | grep -qv '^0'; then
      echo ""; echo "    ABORTED:"; appfile sh -c 'grep "\"type\":\"abort\"" files/bench-results.jsonl' | tail -1
      harvest; break 2
    fi
    if [ $(( $(date +%s) - LAST_CHANGE )) -ge "$QUIET_S" ]; then
      echo ""; echo "    app went quiet after $LAST_N lines - relaunching to continue"; break
    fi
    sleep 10
  done
done

harvest
echo ""
echo "==> lines: $(wc -l < "$JSONL" | tr -d ' ')  ->  $JSONL"
echo ""
node "$REPO_ROOT/scripts/aisle-bench-report.mjs" "$JSONL" || true
