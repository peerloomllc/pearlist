#!/usr/bin/env bash
# Find tests that pass because they matched a COMMENT rather than code.
#
# Much of this suite asserts on the SHAPE OF SOURCE - "this method defers instead of
# appending", "this control is gone", "this copy is not written at the call site".
# Those pins are valuable: they catch whole classes of regression that a unit test
# cannot see. They also have one failure mode that is worse than no test at all.
#
# A pin that greps a whole file can be satisfied by a COMMENT. When that happens it
# stops testing anything and never says so. It happened here: test/removalCutsOff
# required the string "Stronger removal" inside removeMember, that control was deleted
# in PR #170, and the assertion kept passing for days because the words survived in a
# comment two lines away. The reverse bit too - a comment that quoted a screen's copy
# verbatim broke an unrelated pin that located the screen by searching for it.
#
# HOW IT WORKS. Re-runs each source-reading test with fs.readFileSync patched to strip
# comments from src/ and app/. Anything that then fails was leaning on prose.
#
# READ THE OUTPUT, do not just check the exit code. Two kinds of failure show up here
# and only one is a defect:
#
#   A PIN THAT MATCHED A COMMENT          a real defect - it is testing nothing
#   A PIN THAT IS *ABOUT* THE COMMENT     correct and deliberate. test/deviceRoster
#                                         reads RAW source on purpose, to forbid stale
#                                         claims in listMethods' documentation, after
#                                         one froze an out-of-date sentence for months
#                                         and the user-facing copy inherited the error.
#
# So a clean run is "no failures except the known documentation pins". As of
# 2026-08-01 that is exactly one: deviceRoster's "listMethods describes device:remove
# as it now behaves".
#
# Usage:  ./scripts/audit-source-pins.sh
set -uo pipefail
cd "$(dirname "$0")/.."

STRIP="$(mktemp -t pearlist-nocomments-XXXXXX.js)"
trap 'rm -f "$STRIP"' EXIT
cat > "$STRIP" <<'JS'
const fs = require('fs')
const real = fs.readFileSync
// Conservative on purpose: whole-line comments only, so a `https://` inside a string
// literal is never touched and the stripped file still parses as the same program.
const strip = (s) => s
  .replace(/^\s*\{?\/\*[\s\S]*?\*\/\}?\s*$/gm, '')
  .replace(/^\s*\/\*[\s\S]*?\*\/\s*/gm, '')
  .replace(/^\s*\/\/.*$/gm, '')
fs.readFileSync = function (p, ...rest) {
  const out = real.call(this, p, ...rest)
  const name = typeof p === 'string' ? p : ''
  if (typeof out === 'string' && /\/(src|app)\/.*\.(js|jsx|mjs)$/.test(name)) return strip(out)
  return out
}
JS

fail=0
for f in $(grep -ln "readFileSync" test/*.test.js); do
  n=$(node --require "$STRIP" --test "$f" 2>&1 | grep -E '^# fail' | tr -cd '0-9')
  if [ "${n:-0}" != "0" ]; then
    echo "SUSPECT  $f  ($n failing without comments)"
    node --require "$STRIP" --test "$f" 2>&1 | grep -E "^not ok" | sed 's/^/         /'
    fail=$((fail + 1))
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "No source pin depends on a comment."
else
  echo
  echo "$fail file(s) above. Each is either a pin matching prose (fix it) or a pin"
  echo "deliberately ABOUT the prose (leave it, and say so in the test)."
fi
