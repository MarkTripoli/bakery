#!/usr/bin/env bash
set -uo pipefail
OUT="${1:?output directory}"
BIN="${BAKERY_DESKTOP_BIN:-/cache/target-desktop/debug/bakery-desktop}"
mkdir -p "$OUT"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 TZ=UTC LANG=C.UTF-8 NO_AT_BRIDGE=1 GTK_THEME=Adwaita
export DISPLAY=:99

picture_pair() {
  local name="$1" animations="$2" fb cfg
  fb="$(mktemp -d)"; cfg="$(mktemp -d)"
  mkdir -p "$cfg/gtk-3.0"
  printf '[Settings]\ngtk-enable-animations=%s\n' "$animations" > "$cfg/gtk-3.0/settings.ini"
  Xvfb :99 -screen 0 960x640x24 -nolisten tcp -fbdir "$fb" >/dev/null 2>&1 &
  local xvfb=$!
  sleep 1
  XDG_CONFIG_HOME="$cfg" BAKERY_DESKTOP_PREVIEW=waiting BAKERY_DESKTOP_SIZE=960x640 \
    BAKERY_DESKTOP_REPORT="$OUT/$name.report.jsonl" timeout 40 dbus-run-session -- "$BIN" >"$OUT/$name.log" 2>&1 &
  for _ in $(seq 1 40); do grep -q '"event":"page_loaded"' "$OUT/$name.report.jsonl" 2>/dev/null && break; sleep 0.5; done
  sleep 2
  cp "$fb/Xvfb_screen0" "$OUT/$name-a.xwd"; sleep 0.37; cp "$fb/Xvfb_screen0" "$OUT/$name-b.xwd"
  pkill -f "$BIN" 2>/dev/null; kill "$xvfb" 2>/dev/null; wait "$xvfb" 2>/dev/null
  rm -rf "$fb" "$cfg"
  if cmp -s "$OUT/$name-a.xwd" "$OUT/$name-b.xwd"; then echo "still"; else echo "moving"; fi
}

moving="$(picture_pair animations-on true)"
still="$(picture_pair animations-off false)"
status=0
if [ "$moving" = "moving" ]; then echo "PASS [motion] with animations on the waiting spinner turns"; else echo "FAIL [motion] with animations on the waiting spinner turns (no change seen)"; status=1; fi
if [ "$still" = "still" ]; then echo "PASS [motion] with reduced motion the waiting window is perfectly still"; else echo "FAIL [motion] with reduced motion the waiting window is perfectly still (it changed)"; status=1; fi
rm -f "$OUT"/*.xwd
exit $status
