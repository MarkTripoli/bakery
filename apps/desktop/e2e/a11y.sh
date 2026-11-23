#!/usr/bin/env bash
# Runs inside the build image. For every named state and window size: a virtual display, a message bus
# with the accessibility bus on it, the app showing that state, and a11y_check.py reading the window over
# AT-SPI the way a screen reader does (#77, acceptance criterion 1: native accessibility).
#
#   a11y.sh <output dir>      (STATES and SIZES narrow it; the defaults are every state at 960x640)
set -uo pipefail
OUT="${1:?output directory}"
BIN="${BAKERY_DESKTOP_BIN:-/cache/target-desktop/debug/bakery-desktop}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATES="${STATES:-$(BAKERY_DESKTOP_LIST_PREVIEWS=1 "$BIN")}"
SIZES="${SIZES:-960x640}"
mkdir -p "$OUT"
[ -n "${APPEND:-}" ] || : > "$OUT/results.tsv"
# NO_AT_BRIDGE is left unset on purpose: the window must offer itself to the accessibility bus.
export DISPLAY=:99 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 TZ=UTC LANG=C.UTF-8 GTK_A11Y=atspi GTK_THEME=Adwaita
unset NO_AT_BRIDGE
failed=0
for size in $SIZES; do
  W="${size%x*}"; H="${size#*x}"
  for state in $STATES; do
    name="$state-$size"
    report="$OUT/$name.report.jsonl"
    rm -f "$report"
    Xvfb :99 -screen 0 "${W}x${H}x24" -nolisten tcp >/dev/null 2>&1 &
    xvfb=$!
    sleep 1
    timeout 120 dbus-run-session -- bash -c '
      /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
      sleep 1.5
      BAKERY_DESKTOP_PREVIEW="'"$state"'" BAKERY_DESKTOP_SIZE="'"$size"'" BAKERY_DESKTOP_REPORT="'"$report"'" \
        "'"$BIN"'" >"'"$OUT/$name.log"'" 2>&1 &
      app=$!
      for _ in $(seq 1 60); do grep -q "\"event\":\"page_loaded\"" "'"$report"'" 2>/dev/null && break; sleep 0.5; done
      sleep 1
      python3 "'"$HERE"'/a11y_check.py" "'"$state"'" "'"$size"'" "'"$OUT"'" >"'"$OUT/$name.checks.txt"'" 2>&1
      status=$?
      kill $app 2>/dev/null; wait $app 2>/dev/null
      exit $status'
    status=$?
    cat "$OUT/$name.checks.txt"
    [ $status -eq 0 ] || failed=$((failed + 1))
    printf '%s\t%s\t%s\n' "$state" "$size" "$([ $status -eq 0 ] && echo pass || echo fail)" >> "$OUT/results.tsv"
    kill "$xvfb" 2>/dev/null; wait "$xvfb" 2>/dev/null
    sleep 0.5
  done
done
total=$(wc -l < "$OUT/results.tsv")
echo "accessibility: $((total - failed)) of $total states pass"
[ $failed -eq 0 ]
