#!/usr/bin/env bash
# Drive an iPhone Simulator on the Mac Mini: tap it, type into it, read it.
#
# WHY THIS EXISTS. `idb` used to do this and no longer can. idb_companion is
# pinned at 1.1.8 (build_date Aug 2022) - that IS the newest Homebrew has, the
# project has not shipped since - and its input path dies on any modern runtime:
#
#   Could not create instance of SimulatorKit.SimDeviceLegacyHIDClient
#   No Legacy HID port found
#
# Apple removed the legacy HID port it drives. Reading still works, so `idb ui
# describe-all` will fool you into thinking idb is fine right up until you try to
# tap. Appium's XCUITest driver talks to WebDriverAgent instead, which is what
# Xcode itself uses, so it moves with the runtime rather than against it.
#
# Without this, CLAUDE.md rule 15 (virtual first) has no iOS half at all and every
# UI check costs a USB cable.
#
# RUNS FROM EITHER MACHINE. On Linux it copies itself to the Mac and re-runs there,
# so it does not care whether the repo is synced. Session id lives in a file on the
# Mac, so each command is independent and a session survives between calls.
#
# Usage:
#   ./scripts/sim-drive.sh start [SimName]   boot the sim, start Appium, open a session
#   ./scripts/sim-drive.sh dump              every label on screen + where to tap it
#   ./scripts/sim-drive.sh tap X Y
#   ./scripts/sim-drive.sh type "some text"  into whatever has focus
#   ./scripts/sim-drive.sh enter             the keyboard's return key
#   ./scripts/sim-drive.sh home
#   ./scripts/sim-drive.sh shot out.png      only when the LOOK is the question (rule 16)
#   ./scripts/sim-drive.sh stop
#
# Env: SIM_NAME (default PearListBench), BUNDLE_ID (default com.pearlist),
#      MAC_MINI (default Tims-Mac-mini.local), APPIUM_PORT (default 4723).

set -euo pipefail

MAC_MINI="${MAC_MINI:-Tims-Mac-mini.local}"

# ── Hop to the Mac if we are not on it ──────────────────────────────────────
# scp+run rather than assuming a synced repo: this script is most wanted exactly
# when something else is broken, and a stale copy on the Mac would be its own bug.
if [ "$(uname)" != "Darwin" ]; then
  scp -q "$0" "$MAC_MINI:/tmp/sim-drive.sh"
  exec ssh "$MAC_MINI" "bash -lc 'chmod +x /tmp/sim-drive.sh && SIM_NAME=${SIM_NAME:-} BUNDLE_ID=${BUNDLE_ID:-} APPIUM_PORT=${APPIUM_PORT:-} /tmp/sim-drive.sh $(printf '%q ' "$@")'"
fi

SIM_NAME="${SIM_NAME:-PearListBench}"
BUNDLE_ID="${BUNDLE_ID:-com.pearlist}"
PORT="${APPIUM_PORT:-4723}"
BASE="http://127.0.0.1:$PORT"
SESSION_FILE=/tmp/pearlist-sim-session

api () { # api METHOD PATH [BODY]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -m 300 -X "$m" "$BASE$p" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -m 300 -X "$m" "$BASE$p"
  fi
}

session () {
  [ -s "$SESSION_FILE" ] || { echo "No session. Run: sim-drive.sh start" >&2; exit 1; }
  cat "$SESSION_FILE"
}

cmd_start () {
  local name="${1:-$SIM_NAME}" udid
  udid=$(xcrun simctl list devices available | grep -E "^ *${name} \(" | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/' || true)
  [ -n "$udid" ] || { echo "No simulator named $name" >&2; exit 1; }
  xcrun simctl list devices booted | grep -q "$udid" || { echo "booting $name..."; xcrun simctl boot "$udid"; sleep 20; }

  # Appium is a long-lived server; leave one running rather than one per command.
  curl -s -m 5 "$BASE/status" >/dev/null 2>&1 || {
    echo "starting appium on $PORT..."
    nohup appium --port "$PORT" --log /tmp/appium.log --log-level info >/dev/null 2>&1 &
    for _ in $(seq 30); do curl -s -m 2 "$BASE/status" >/dev/null 2>&1 && break; sleep 1; done
  }

  local ver sid
  ver=$(xcrun simctl list runtimes | awk '/^iOS /{print $2}' | tail -1)
  # First run builds WebDriverAgent with xcodebuild, which takes minutes. After
  # that it is seconds, so do not let a timeout here send you looking for a fault.
  sid=$(api POST /session "{\"capabilities\":{\"alwaysMatch\":{
      \"platformName\":\"iOS\",\"appium:automationName\":\"XCUITest\",
      \"appium:udid\":\"$udid\",\"appium:deviceName\":\"$name\",
      \"appium:platformVersion\":\"$ver\",\"appium:bundleId\":\"$BUNDLE_ID\",
      \"appium:noReset\":true,\"appium:newCommandTimeout\":3600,
      \"appium:wdaLaunchTimeout\":600000}}}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("value",{}).get("sessionId",""))')
  [ -n "$sid" ] || { echo "session failed, see /tmp/appium.log" >&2; exit 1; }
  echo "$sid" > "$SESSION_FILE"
  echo "session $sid on $name ($udid)"
}

# Every label on screen with the point to tap it, which is what a UI check
# actually needs. Read this, not a screenshot (CLAUDE.md rule 16).
cmd_dump () {
  api GET "/session/$(session)/source" | python3 -c '
import sys, json, re
src = json.load(sys.stdin).get("value") or ""
seen = set()
for m in re.finditer(r"<XCUIElementType(\w+)([^>]*)>", src):
    kind, attrs = m.group(1), m.group(2)
    g = lambda k: (re.search(k + r"=\"([^\"]*)\"", attrs) or [None, ""])[1]
    label = (g("label") or g("name") or g("value")).strip()
    if not label or kind in ("Application", "Window", "Other"):
        continue
    try:
        x = int(float(g("x"))) + int(float(g("width"))) // 2
        y = int(float(g("y"))) + int(float(g("height"))) // 2
    except ValueError:
        x = y = 0
    key = (label, x, y)
    if key in seen:
        continue
    seen.add(key)
    print("%-12s %-46s @ %4d,%4d" % (kind, label[:46], x, y))
'
}

cmd_tap () {
  api POST "/session/$(session)/actions" "{\"actions\":[{\"type\":\"pointer\",\"id\":\"f1\",
    \"parameters\":{\"pointerType\":\"touch\"},\"actions\":[
      {\"type\":\"pointerMove\",\"duration\":0,\"x\":$1,\"y\":$2},
      {\"type\":\"pointerDown\",\"button\":0},{\"type\":\"pause\",\"duration\":80},
      {\"type\":\"pointerUp\",\"button\":0}]}]}" >/dev/null
}

# Goes to whatever holds focus, so tap the field first. One keyDown/keyUp pair per
# character: the W3C key action is the only typing path that reaches a WebView
# input, which is most of this app.
cmd_type () {
  python3 -c '
import json, sys
acts = []
for ch in sys.argv[1]:
    acts += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
print(json.dumps({"actions": [{"type": "key", "id": "k1", "actions": acts}]}))
' "$1" > /tmp/sim-keys.json
  curl -s -m 300 -X POST "$BASE/session/$(session)/actions" -H 'Content-Type: application/json' -d @/tmp/sim-keys.json >/dev/null
}

cmd_enter () {
  api POST "/session/$(session)/actions" '{"actions":[{"type":"key","id":"k1","actions":[
    {"type":"keyDown","value":""},{"type":"keyUp","value":""}]}]}' >/dev/null
}

cmd_home () {
  api POST "/session/$(session)/execute/sync" '{"script":"mobile: pressButton","args":[{"name":"home"}]}' >/dev/null
}

cmd_shot () {
  local out="${1:-/tmp/sim.png}"
  api GET "/session/$(session)/screenshot" \
    | python3 -c 'import sys,json,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["value"]))' > "$out"
  echo "$out"
}

cmd_stop () {
  [ -s "$SESSION_FILE" ] && api DELETE "/session/$(cat "$SESSION_FILE")" >/dev/null || true
  rm -f "$SESSION_FILE"
  echo "stopped"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  dump)  cmd_dump ;;
  tap)   cmd_tap "$2" "$3" ;;
  type)  shift; cmd_type "$*" ;;
  enter) cmd_enter ;;
  home)  cmd_home ;;
  shot)  shift; cmd_shot "${1:-/tmp/sim.png}" ;;
  stop)  cmd_stop ;;
  *) sed -n '2,30p' "$0"; exit 1 ;;
esac
