#!/usr/bin/env bash
# Runs inside the build image. For every named state, window size and theme: a virtual display, the
# app showing that state, and a screenshot. Writes PNGs and a results.tsv the checker reads.
#
#   capture.sh <output dir>      (STATES, SIZES and THEMES narrow it; the defaults are all of them)
set -uo pipefail
OUT="${1:?output directory}"
BIN="${BAKERY_DESKTOP_BIN:-/cache/target-desktop/debug/bakery-desktop}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATES="${STATES:-$(BAKERY_DESKTOP_LIST_PREVIEWS=1 "$BIN")}"
SIZES="${SIZES:-960x640 400x560}"
THEMES="${THEMES:-light dark}"
mkdir -p "$OUT"
[ -n "${APPEND:-}" ] || : > "$OUT/results.tsv"
export DISPLAY=:99 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 NO_AT_BRIDGE=1 TZ=UTC LANG=C.UTF-8

for size in $SIZES; do
  W="${size%x*}"; H="${size#*x}"
  for theme in $THEMES; do
    gtk="Adwaita"; [ "$theme" = dark ] && gtk="Adwaita:dark"
    for state in $STATES; do
      name="$state-$size-$theme"
      report="$OUT/$name.report.jsonl"
      rm -f "$report"
      # Xvfb keeps its screen in a file in the X dump format: that file is the screenshot.
      fb="$(mktemp -d)"
      Xvfb :99 -screen 0 "${W}x${H}x24" -nolisten tcp -fbdir "$fb" >/dev/null 2>&1 &
      xvfb=$!
      sleep 1
      GTK_THEME="$gtk" BAKERY_DESKTOP_PREVIEW="$state" BAKERY_DESKTOP_SIZE="$size" \
        BAKERY_DESKTOP_REPORT="$report" timeout 40 dbus-run-session -- "$BIN" >"$OUT/$name.log" 2>&1 &
      app=$!
      for _ in $(seq 1 40); do grep -q '"event":"view"' "$report" 2>/dev/null && break; sleep 0.5; done
      sleep 2
      if cp "$fb/Xvfb_screen0" "$OUT/$name.xwd" 2>/dev/null; then
        result="$(python3 "$HERE/xwd2png.py" "$OUT/$name.xwd" "$OUT/$name.png")"
      else
        result="no screenshot"
      fi
      rm -f "$OUT/$name.xwd"
      printf '%s\t%s\t%s\t%s\n' "$state" "$size" "$theme" "$result" >> "$OUT/results.tsv"
      pkill -f "$BIN" 2>/dev/null; kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
      kill "$xvfb" 2>/dev/null; wait "$xvfb" 2>/dev/null
      rm -rf "$fb"
      sleep 0.5
    done
  done
done
echo "captured: $(wc -l < "$OUT/results.tsv") of $(( $(echo $STATES | wc -w) * $(echo $SIZES | wc -w) * $(echo $THEMES | wc -w) ))"
