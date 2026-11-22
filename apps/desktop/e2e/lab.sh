#!/usr/bin/env bash
# From the host: a small lab for how the app's window treats links, with no database. A stub server on
# this computer stands in for Bakery (health, the handoff and one test page); the app runs against it
# in the build image with a sign-in already in the keyring, and lab.py clicks through the page.
#
#   lab.sh <output dir>
set -uo pipefail
OUT="$(realpath -m "${1:?output directory}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(realpath "$HERE/..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
mkdir -p "$OUT"; chmod 777 "$OUT"
(cd "$APP/../.." && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
docker run --rm -e CARGO_TARGET_DIR=/cache/target-desktop -v "$APP:/app" \
  -v "$CACHE/target-desktop:/cache/target-desktop" -v "$CACHE/registry:/opt/rust/cargo/registry" \
  -v "$CACHE/git:/opt/rust/cargo/git" -w /app "$IMAGE" cargo build -p bakery-desktop --offline 2>&1 | tail -1
docker run --rm --network host -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$APP:/app:ro" -v "$OUT:/out" -v "$CACHE/target-desktop:/cache/target-desktop:ro" \
  -e HOME=/tmp/labhome -e OUT=/out "$IMAGE" bash -c '
    set -uo pipefail
    export HOME=/tmp/labhome; mkdir -p "$HOME"
    export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config XDG_RUNTIME_DIR=$HOME/run
    mkdir -p "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
    eval "$(dbus-launch --sh-syntax)"
    printf "%s" "lab-keyring-password" | gnome-keyring-daemon --unlock --daemonize --components=secrets >/dev/null 2>&1
    mkdir -p /tmp/xfb
    Xvfb :99 -screen 0 1280x800x24 -fbdir /tmp/xfb >/dev/null 2>&1 &
    export DISPLAY=:99 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
      WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
    sleep 2
    python3 /app/e2e/lab.py
    RC=$?
    chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" /out 2>/dev/null
    exit $RC
  '
