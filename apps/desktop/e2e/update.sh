#!/usr/bin/env bash
# Update verification, from the host: builds the app in the build image with a throwaway test key
# built in, then asks it for updates from a local address and checks which ones it accepts.
#
#   update.sh <output dir>
#
# Only the test keys made here are used. The release key is held by the owner and never appears.
set -uo pipefail
OUT="$(realpath -m "${1:?output directory}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(realpath "$HERE/..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
mkdir -p "$OUT" "$CACHE/target-update"
(cd "$APP/../.." && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$APP:/app" -v "$OUT:/out" -v "$CACHE/target-update:/cache/target-update" \
  -v "$CACHE/registry:/opt/rust/cargo/registry" -v "$CACHE/git:/opt/rust/cargo/git" \
  -v "$CACHE/cli/bin/cargo-tauri:/usr/local/bin/cargo-tauri:ro" \
  -w /app "$IMAGE" bash /app/e2e/update-inside.sh
status=$?
exit $status
