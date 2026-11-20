#!/usr/bin/env bash
# Runs inside the build image. Starts the real window, has it try what the content security policy
# must refuse, and checks what the browser engine itself blocked.
#
#   policy.sh <output dir>
set -uo pipefail
OUT="${1:?output directory}"
BIN="${BAKERY_DESKTOP_BIN:-/cache/target-desktop/debug/bakery-desktop}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
report="$OUT/policy.report.jsonl"
rm -f "$report"
export DISPLAY=:99 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 NO_AT_BRIDGE=1 LANG=C.UTF-8
Xvfb :99 -screen 0 960x640x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
sleep 1
# Nothing listens on the configured server: the policy decides before anything connects.
BAKERY_SERVER=http://127.0.0.1:9 BAKERY_DESKTOP_PREVIEW=sign-in BAKERY_DESKTOP_CSP_PROBE=1 \
  BAKERY_DESKTOP_REPORT="$report" timeout 60 dbus-run-session -- "$BIN" >"$OUT/policy.log" 2>&1 &
app=$!
for _ in $(seq 1 60); do grep -q '"event":"probe"' "$report" 2>/dev/null && break; sleep 0.5; done
pkill -f "$BIN" 2>/dev/null; kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
kill "$xvfb" 2>/dev/null; wait "$xvfb" 2>/dev/null
python3 "$HERE/check_policy.py" "$report"
