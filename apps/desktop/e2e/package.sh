#!/usr/bin/env bash
# From the host: builds the unsigned Linux package in the build image and checks what is in it.
#
#   package.sh <output dir>
#
# Unsigned on purpose: hosted signing waits for the owner's release key (docs/runbooks/desktop-packaging.md).
set -uo pipefail
OUT="$(realpath -m "${1:?output directory}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(realpath "$HERE/..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
mkdir -p "$OUT" "$CACHE/target-update"
(cd "$APP/../.." && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e CARGO_TARGET_DIR=/cache/target-update \
  -v "$APP:/app" -v "$OUT:/out" -v "$CACHE/target-update:/cache/target-update" \
  -v "$CACHE/registry:/opt/rust/cargo/registry" -v "$CACHE/git:/opt/rust/cargo/git" \
  -v "$CACHE/cli/bin/cargo-tauri:/usr/local/bin/cargo-tauri:ro" \
  -w /app/src-tauri "$IMAGE" bash -c '
    set -uo pipefail
    FAILS=0
    say() { echo "$@" | tee -a /out/package-results.txt; }
    : > /out/package-results.txt
    check() { if eval "$2" >/dev/null 2>&1; then say "PASS $1"; else say "FAIL $1"; FAILS=$((FAILS + 1)); fi; }
    cargo tauri build --bundles deb --no-sign 2>&1 | tail -3
    DEB="$(ls /cache/target-update/release/bundle/deb/*.deb 2>/dev/null | head -1)"
    check "the package was built" "[ -f \"$DEB\" ]"
    cp "$DEB" /out/ 2>/dev/null
    ROOT=/tmp/unpacked; rm -rf $ROOT; mkdir -p $ROOT
    dpkg-deb -x "$DEB" $ROOT
    check "the package names its needs (webkit and gtk)" "dpkg-deb -I \"$DEB\" | grep -E \"Depends:.*libwebkit2gtk.*libgtk\""
    check "the program is installed under usr/bin" "[ -x $ROOT/usr/bin/bakery-desktop ]"
    check "the launcher registers the bakery:// scheme" "grep -q x-scheme-handler/bakery $ROOT/usr/share/applications/*.desktop"
    check "the launcher passes the address it was given" "grep -q \"Exec=bakery-desktop %u\" $ROOT/usr/share/applications/*.desktop"
    check "the unpacked program runs" "BAKERY_DESKTOP_LIST_PREVIEWS=1 $ROOT/usr/bin/bakery-desktop | grep -q sign-in"
    check "it is a release build without debug symbols" "! file $ROOT/usr/bin/bakery-desktop | grep -q \"with debug_info\""
    chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out 2>/dev/null
    say "$FAILS failed"
    exit $FAILS
  '
