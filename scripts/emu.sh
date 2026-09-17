#!/usr/bin/env bash
# Boot an Android emulator on this machine, headless, and wait until it is usable.
#
# WHY THIS EXISTS: `emulator -avd <name>` SEGFAULTS HERE, and the reason is one
# flag. Diagnosed 2026-08-07 from the core dump rather than from the console, which
# says nothing useful:
#
#   Thread 1 (crashing):
#   #0  0x000055efcf033070 in ?? ()                          <- JIT-generated code
#   #1..#5 in emulator/lib64/gles_swiftshader/libGLESv2.so
#
# The crash is in SWIFTSHADER, the bundled software renderer, inside code its
# Reactor JIT emitted at runtime. Not in qemu, not in the AVD, not in KVM. The
# process also has Mesa's lavapipe (`libvulkan_lvp.so`) loaded with the SYSTEM
# LLVM while SwiftShader carries its own, which is the usual shape of this class
# of crash.
#
# `-gpu host` uses the real GPU (an RTX 4070 Ti here) and never loads SwiftShader
# at all, so it boots. `-gpu guest` still dies, which is the control: it is the
# software path that is broken, not the emulator.
#
# THIS COST MONTHS OF VIRTUAL-FIRST. The item sat open as "booting an emulator
# segfaults on this machine" with -gpu swiftshader_indirect and -gpu off already
# on the ruled-out list. What was never tried was the one option that avoids
# software rendering entirely.
#
# Usage:
#   ./scripts/emu.sh [AvdName] [port]     default Pixel_9 on 5570
#   ./scripts/emu.sh --list               what AVDs exist
#   ./scripts/emu.sh --stop [port]
#
# Then drive it with the ordinary adb commands against the serial it prints, and
# read the screen as TEXT (CLAUDE.md rule 16):
#   adb -s emulator-5570 shell uiautomator dump && adb -s emulator-5570 shell cat /sdcard/window_dump.xml | grep -oE 'text="[^"]+"' | sort -u
#
# THE APK MUST CARRY x86_64. An emulator here is x86_64 while the phones are
# arm64, so a debug build made with `-PreactNativeArchitectures=arm64-v8a` installs
# and then dies. Build with `-PreactNativeArchitectures=x86_64` (or omit the flag)
# for emulator work. The Bare addons are fine: `bare-pack --linked` already puts
# the x64 slice in bare-universal.bundle, confirmed by `worklet:loaded` on the
# emulator with no ADDON_NOT_FOUND.
#
# -gpu host NEEDS A REAL DISPLAY, AND AN AGENT SHELL OFTEN HAS NONE. Without DISPLAY
# and the X auth cookie the boot dies with "Could not start renderer! (Error: -2)",
# the same message as a genuinely headless box, and the qemu process then hangs
# (ignoring SIGTERM) instead of exiting. The desktop here is KDE Wayland, so :0 is
# Xwayland with its own auth file under /run/user, whose name changes every login.
# So the script reads both off the running Xwayland (found 2026-09-05, scripted
# 2026-09-17), checks them with xdpyinfo before a boot that takes minutes, and stops
# as soon as the log shows the renderer failed.

set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
EMU="$SDK/emulator/emulator"
AVD="${1:-Pixel_9}"
PORT="${2:-5570}"

case "$AVD" in
  --list) exec "$EMU" -list-avds ;;
  --stop)
    # A qemu whose renderer failed ignores SIGTERM, so escalate.
    pkill -f "emulator.*-port ${2:-5570}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do pgrep -f "emulator.*-port ${2:-5570}" >/dev/null || break; sleep 1; done
    pkill -9 -f "emulator.*-port ${2:-5570}" 2>/dev/null || true
    echo "stopped ${2:-5570}"; exit 0 ;;
esac

SERIAL="emulator-$PORT"

# --- the display ---------------------------------------------------------------
display_ok () { command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo >/dev/null 2>&1; }
if ! display_ok; then
  # Xwayland (KDE, GNOME) and Xorg both carry the display and the cookie on their
  # command line: `Xwayland :0 -auth /run/user/1000/xauth_XXXXXX ...`.
  XLINE="$(ps -u "$(id -u)" -o args= | grep -E '(^|/)(Xwayland|Xorg) :[0-9]+ ' | grep -v grep | head -1 || true)"
  if [ -n "$XLINE" ]; then
    export DISPLAY="$(echo "$XLINE" | grep -oE ' :[0-9]+' | head -1 | tr -d ' ')"
    AUTH="$(echo "$XLINE" | grep -oE -- '-auth [^ ]+' | head -1 | cut -d' ' -f2)"
    [ -n "$AUTH" ] && export XAUTHORITY="$AUTH"
  fi
fi
if ! display_ok; then
  echo "no usable display for -gpu host (DISPLAY=${DISPLAY:-unset} XAUTHORITY=${XAUTHORITY:-unset})." >&2
  echo "Log in to the desktop on this machine, or install xdpyinfo (the xdpyinfo package on Fedora) if it is missing." >&2
  exit 1
fi

# --- the AVD ---------------------------------------------------------------------
# Several AVDs here (Pixel_7, Pixel_8, Pixel_9_Pro, Small_Phone) have an .ini but no
# config.ini, and boot as "CPU Architecture 'arm' is not supported" after a long wait.
AVD_DIR="$HOME/.android/avd/$AVD.avd"
if ! grep -q '^abi.type *= *x86_64' "$AVD_DIR/config.ini" 2>/dev/null; then
  echo "$AVD has no usable x86_64 config ($AVD_DIR/config.ini). Bootable AVDs:" >&2
  for d in "$HOME"/.android/avd/*.avd; do
    grep -q '^abi.type *= *x86_64' "$d/config.ini" 2>/dev/null && echo "  $(basename "$d" .avd)" >&2
  done
  exit 1
fi
if [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
  echo "$SERIAL"; exit 0    # already up; compose with $(./scripts/emu.sh)
fi

# A killed emulator leaves its locks behind, and the next boot of that AVD refuses to
# start. Only cleared when no emulator for this AVD is running.
if ! pgrep -f -- "-avd $AVD -" >/dev/null 2>&1; then
  rm -f "$AVD_DIR/multiinstance.lock" "$AVD_DIR/hardware-qemu.ini.lock"
fi

LOG="/tmp/pearlist-emu-$PORT.log"
# -gpu host is the whole point of this script. Do not "simplify" it away.
nohup "$EMU" -avd "$AVD" -gpu host -no-window -no-audio -no-snapshot -port "$PORT" \
  >"$LOG" 2>&1 &
EMUPID=$!

echo "booting $AVD on $PORT (log: $LOG)..." >&2
for _ in $(seq 1 60); do
  sleep 5
  if ! kill -0 $EMUPID 2>/dev/null; then
    echo "emulator died - see $LOG" >&2
    grep -iE "segmentation|fatal|ERROR" "$LOG" | tail -3 >&2
    exit 1
  fi
  # A failed renderer does not end the process, so do not wait five minutes for it.
  if grep -q "Could not start renderer" "$LOG" 2>/dev/null; then
    echo "the emulator's renderer failed (DISPLAY=${DISPLAY:-unset}) - see $LOG" >&2
    kill -9 $EMUPID 2>/dev/null || true
    pkill -9 -f "emulator.*-port $PORT" 2>/dev/null || true
    exit 1
  fi
  [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && {
    echo "$SERIAL"; exit 0
  }
done
echo "timed out waiting for $SERIAL - see $LOG" >&2
exit 1
