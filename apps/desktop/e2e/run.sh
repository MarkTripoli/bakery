#!/usr/bin/env bash
# From the host: builds the app in the build image, then runs a harness script inside it.
#
#   run.sh stills <output dir>      screenshots of every named state, size and theme
#   run.sh policy <output dir>      the content security policy, tried in the real window
set -uo pipefail
MODE="${1:?stills or policy}"
OUT="$(realpath -m "${2:?output directory}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(realpath "$HERE/..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
mkdir -p "$OUT"
# The page embeds the web's own tokens: copy them in first.
(cd "$APP/../.." && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
docker run --rm -e CARGO_TARGET_DIR=/cache/target-desktop -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e STATES -e SIZES -e THEMES \
  -v "$APP:/app" -v "$OUT:/out" -v "$CACHE/target-desktop:/cache/target-desktop" \
  -v "$CACHE/registry:/opt/rust/cargo/registry" -v "$CACHE/git:/opt/rust/cargo/git" \
  -w /app "$IMAGE" bash -c '
    set -uo pipefail
    cargo build -p bakery-desktop --offline 2>&1 | tail -1
    case "'"$MODE"'" in
      stills) bash e2e/capture.sh /out \
        && APPEND=1 STATES=choose-server-signed-in-no-answer SIZES=400x380 bash e2e/capture.sh /out \
        && python3 e2e/check_stills.py /out ;;
      policy) bash e2e/policy.sh /out ;;
    esac
    status=$?
    chown -R "$HOST_UID:$HOST_GID" /out
    exit $status
  '
