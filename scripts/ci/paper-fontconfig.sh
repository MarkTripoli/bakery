#!/usr/bin/env bash
# Writes the hermetic Paper-lane fontconfig and prints its absolute path, for
# `FONTCONFIG_FILE`. Usage: paper-fontconfig.sh <scratch-dir>
set -euo pipefail
scratch="${1:?usage: paper-fontconfig.sh <scratch-dir>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
mkdir -p "$scratch/fontconfig-cache"
scratch="$(cd "$scratch" && pwd)"
out="$scratch/paper-fonts.conf"
sed \
  -e "s|@FONTS_DIR@|$root/docs/technical-design/enterprise-mocks/fonts|" \
  -e "s|@FALLBACK_DIR@|$here/paper-fonts|" \
  -e "s|@CACHE_DIR@|$scratch/fontconfig-cache|" \
  "$here/paper-fonts.conf.in" > "$out"
printf '%s\n' "$out"
