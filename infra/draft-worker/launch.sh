#!/bin/sh
# The only executable the Bakery server may start (--allow-run names this
# path alone). It is not a general launcher: every argument and every
# inherited variable is ignored except one job id, which must be a UUID and
# selects nothing. It starts exactly one fixed worker module, with no
# permissions, remote imports denied, the lockfile frozen, and V8 caps on its
# JavaScript heap and WebAssembly memory. Pinned values below; the unit test
# tests/unit/draft-worker-launcher_test.ts keeps them equal to DRAFT_LIMITS.
WORKER_MODULE=/workspace/apps/server/src/modules/knowledge/draft-import-worker.ts
WORKER_DENO_DIR=/deno-dir
WORKER_HOME=/tmp

[ "$#" -eq 1 ] || exit 64
case "$1" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
case "$1" in
  *[!0-9a-f-]*) exit 64 ;;
esac

exec /usr/bin/env -i \
  DENO_DIR="$WORKER_DENO_DIR" HOME="$WORKER_HOME" NO_COLOR=1 \
  /usr/bin/deno run \
  --cached-only \
  --no-prompt \
  --deny-import \
  --frozen \
  --v8-flags=--max-old-space-size=192,--wasm-max-mem-pages=4096 \
  "$WORKER_MODULE"
