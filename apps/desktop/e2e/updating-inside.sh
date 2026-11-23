#!/usr/bin/env bash
set -uo pipefail
cd /app
export HOME=/tmp/updhome; mkdir -p "$HOME/Downloads" "$HOME/.config"
export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config XDG_RUNTIME_DIR=$HOME/run
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
printf 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n' > "$XDG_CONFIG_HOME/user-dirs.dirs"
export CARGO_TARGET_DIR=/cache/target-update
KEYS=/tmp/keys; SERVE=/tmp/serve; mkdir -p "$KEYS" "$SERVE/pay"

for k in a b; do
  cargo tauri signer generate --ci -w "$KEYS/$k.key" -f >/dev/null 2>&1 || { echo "FAIL could not make test key $k"; exit 2; }
done
PUB_A="$(cat "$KEYS/a.key.pub")"
export APP_VERSION=1.3.0
cargo build -p bakery-desktop 2>&1 | tail -1
cp "$CARGO_TARGET_DIR/debug/bakery-desktop" /tmp/placeholder-bakery-desktop
TAURI_CONFIG="{\"version\":\"$APP_VERSION\",\"plugins\":{\"updater\":{\"pubkey\":\"$PUB_A\"}}}" cargo build -p bakery-desktop 2>&1 | tail -1
cp "$CARGO_TARGET_DIR/debug/bakery-desktop" /tmp/keyed-bakery-desktop

printf '\x7fELF new AppImage ' > "$SERVE/pay/update.bin"; head -c 4096 /dev/urandom >> "$SERVE/pay/update.bin"
cp "$SERVE/pay/update.bin" "$SERVE/pay/update-tampered.bin"; printf 'x' >> "$SERVE/pay/update-tampered.bin"
cargo tauri signer sign -f "$KEYS/a.key" -p "" "$SERVE/pay/update.bin" >/dev/null 2>&1; mv "$SERVE/pay/update.bin.sig" "$SERVE/pay/update.a.sig"
cargo tauri signer sign -f "$KEYS/b.key" -p "" "$SERVE/pay/update.bin" >/dev/null 2>&1; mv "$SERVE/pay/update.bin.sig" "$SERVE/pay/update.b.sig"

eval "$(dbus-launch --sh-syntax)"
printf "%s" "updating-keyring-password" | gnome-keyring-daemon --unlock --daemonize --components=secrets >/dev/null 2>&1
mkdir -p /tmp/xfb
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -fbdir /tmp/xfb >/dev/null 2>&1 &
export DISPLAY=:99 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
sleep 2
PLACEHOLDER_BIN=/tmp/placeholder-bakery-desktop KEYED_BIN=/tmp/keyed-bakery-desktop OUT=/out python3 /app/e2e/updating.py
status=$?
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out 2>/dev/null
exit $status
