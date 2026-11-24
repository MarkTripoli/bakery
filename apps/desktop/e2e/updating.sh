#!/usr/bin/env bash
set -uo pipefail
OUT="$(realpath -m "${1:?output directory}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(realpath "$HERE/..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
mkdir -p "$OUT" "$CACHE/target-update"
(cd "$APP/../.." && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
WEB_CSS="${WEB_CSS:-$(ls -S "$APP"/../web/dist/assets/*.css "$HOME"/Development/bakery-wt/rig-77-slice7/apps/web/dist/assets/*.css 2>/dev/null | head -1)}"
CSS_MOUNT=(); [ -n "$WEB_CSS" ] && CSS_MOUNT=(-v "$WEB_CSS:/web.css:ro")
docker run --rm "${CSS_MOUNT[@]}" -e SHOTS -e VIDEO -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$APP:/app" -v "$OUT:/out" -v "$CACHE/target-update:/cache/target-update" \
  -v "$CACHE/registry:/opt/rust/cargo/registry" -v "$CACHE/git:/opt/rust/cargo/git" \
  -v "$CACHE/cli/bin/cargo-tauri:/usr/local/bin/cargo-tauri:ro" \
  -w /app "$IMAGE" bash /app/e2e/updating-inside.sh
status=$?
exit $status
