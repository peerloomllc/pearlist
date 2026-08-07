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

set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
EMU="$SDK/emulator/emulator"
AVD="${1:-Pixel_9}"
PORT="${2:-5570}"

case "$AVD" in
  --list) exec "$EMU" -list-avds ;;
  --stop)
    pkill -f "emulator.*-port ${2:-5570}" 2>/dev/null || true
    echo "stopped ${2:-5570}"; exit 0 ;;
esac

SERIAL="emulator-$PORT"
if [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
  echo "$SERIAL"; exit 0    # already up; compose with $(./scripts/emu.sh)
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
  [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && {
    echo "$SERIAL"; exit 0
  }
done
echo "timed out waiting for $SERIAL - see $LOG" >&2
exit 1
