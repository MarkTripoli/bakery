#!/bin/sh
# The only executable the dispatch supervisor (apps/server/scripts/
# run-dispatch.ts) may start; its --allow-run grant names this path, never
# Deno (`deno eval` runs anything). It takes no arguments and execs the
# supervisor's own Deno (the kernel's /proc link of this launcher's parent)
# on the fixed dispatch module with --allow-env --allow-net. The environment
# is the supervisor's allowlist (it starts this launcher with clearEnv).
[ "$#" -eq 0 ] || exit 64
deno=$(/usr/bin/readlink "/proc/$PPID/exe") || exit 70
case "$deno" in /*/deno) ;; *) exit 70 ;; esac
here=$(cd "$(/usr/bin/dirname "$0")" && pwd -P) || exit 70
module="$here/../../apps/server/src/dispatch.ts"
[ -f "$module" ] || exit 70
exec "$deno" run --allow-env --allow-net "$module"
