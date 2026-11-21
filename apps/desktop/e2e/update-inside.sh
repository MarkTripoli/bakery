#!/usr/bin/env bash
# Runs inside the build image (see update.sh). Update verification, with throwaway test keys only:
# builds the app twice, once with the committed placeholder key and once with a test key built in,
# then asks each for an update from a local address and checks which updates it accepts.
set -uo pipefail
cd /app
export HOME=/tmp/updhome; mkdir -p "$HOME"
export CARGO_TARGET_DIR=/cache/target-update
KEYS=/tmp/keys; SERVE=/tmp/serve; BIN=/tmp/bin
mkdir -p "$KEYS" "$SERVE/pay" "$BIN"
PLATFORM="linux-$(uname -m)"
PORT=8765
FAILS=0

say() { echo "$@" | tee -a /out/update-results.txt; }
: > /out/update-results.txt

# Two test keys: the app trusts A; B stands for anyone else.
for k in a b; do
  cargo tauri signer generate --ci -w "$KEYS/$k.key" -f >/dev/null 2>&1 || { say "FAIL could not make test key $k"; exit 2; }
done
PUB_A="$(cat "$KEYS/a.key.pub")"

# The committed placeholder first (what ships until the owner's key is built in), then the test key.
cargo build -p bakery-desktop 2>&1 | tail -1
cp "$CARGO_TARGET_DIR/debug/bakery-desktop" "$BIN/placeholder"
TAURI_CONFIG="{\"plugins\":{\"updater\":{\"pubkey\":\"$PUB_A\"}}}" cargo build -p bakery-desktop 2>&1 | tail -1
cp "$CARGO_TARGET_DIR/debug/bakery-desktop" "$BIN/keyed"

# One payload, signed by A and by B, and a copy changed after it was signed.
head -c 4096 /dev/urandom > "$SERVE/pay/update.bin"
cp "$SERVE/pay/update.bin" "$SERVE/pay/update-tampered.bin"
printf 'x' >> "$SERVE/pay/update-tampered.bin"
cargo tauri signer sign -f "$KEYS/a.key" -p "" "$SERVE/pay/update.bin" >/dev/null 2>&1
mv "$SERVE/pay/update.bin.sig" "$SERVE/pay/update.a.sig"
cargo tauri signer sign -f "$KEYS/b.key" -p "" "$SERVE/pay/update.bin" >/dev/null 2>&1
mv "$SERVE/pay/update.bin.sig" "$SERVE/pay/update.b.sig"

manifest() { # case, version, payload file, signature file
  mkdir -p "$SERVE/$1"
  python3 - "$SERVE/$1/latest.json" "$2" "$PLATFORM" "http://127.0.0.1:$PORT/pay/$3" "$SERVE/pay/$4" <<'PY'
import json, sys
out, version, platform, url, sig = sys.argv[1:6]
json.dump({"version": version, "platforms": {platform: {"signature": open(sig).read().strip(), "url": url}}}, open(out, "w"))
PY
}
manifest good 0.0.1 update.bin update.a.sig
manifest tampered 0.0.1 update-tampered.bin update.a.sig
manifest wrongkey 0.0.1 update.bin update.b.sig
manifest uptodate 0.0.0 update.bin update.a.sig

(cd "$SERVE" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
HTTP=$!
sleep 1

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
export DISPLAY=:99 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 NO_AT_BRIDGE=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1
sleep 2

# Asks one build for one update and reports what the app said about it.
ask() { # label, binary, case, expected outcome
  local report="/tmp/report-$1.jsonl"
  rm -f "$report"
  BAKERY_DESKTOP_PREVIEW=sign-in BAKERY_DESKTOP_REPORT="$report" BAKERY_DESKTOP_CONFIG_DIR="/tmp/cfg-$1" \
    BAKERY_DESKTOP_UPDATE_TEST="http://127.0.0.1:$PORT/$3/latest.json" \
    timeout 40 dbus-run-session -- "$BIN/$2" >"/tmp/app-$1.log" 2>&1 &
  local app=$!
  local outcome=""
  for _ in $(seq 1 60); do
    outcome="$(python3 - "$report" <<'PY'
import json, sys
try:
    for line in open(sys.argv[1]):
        e = json.loads(line)
        if e["event"] == "update_checked":
            print(e["data"]["outcome"]); break
except FileNotFoundError:
    pass
PY
)"
    [ -n "$outcome" ] && break
    sleep 0.5
  done
  pkill -f "$BIN/$2" 2>/dev/null; kill "$app" 2>/dev/null; wait "$app" 2>/dev/null
  mkdir -p /out/logs; cp "/tmp/app-$1.log" "/out/logs/$(echo "$1" | tr ' ' '-').app.log" 2>/dev/null
  cp "$report" "/out/logs/$(echo "$1" | tr ' ' '-').report.jsonl" 2>/dev/null
  if [ "$outcome" = "$4" ]; then say "PASS $1: $outcome"; else say "FAIL $1: expected $4, the app said '${outcome:-nothing}'"; FAILS=$((FAILS + 1)); fi
}

ask "a correctly signed update is accepted" keyed good verified
ask "an update changed after it was signed is rejected" keyed tampered rejected
ask "an update signed by another key is rejected" keyed wrongkey rejected
ask "the same version is not offered again" keyed uptodate up_to_date
ask "with only the placeholder key, nothing is accepted" placeholder good rejected

kill "$HTTP" "$XVFB" 2>/dev/null
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out 2>/dev/null
say "$((5 - FAILS)) passed, $FAILS failed"
exit "$FAILS"
