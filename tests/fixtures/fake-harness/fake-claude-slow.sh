#!/bin/sh
# FS06 fake Claude executable ($0, no model). Exercises the real Claude harness
# adapter, worker, server and UI, not model behaviour. Every record that uses
# it is labeled "fake executable, $0".
#
# The harness spawns the executable with a cleared environment, so settings
# come from `fs06-fake.conf` beside this script (sourced when present), which
# may set:
#   FS06_FAKE_COUNTER  file that receives one line per start (the number of
#                      lines is the number of inferences)
#   FS06_FAKE_SECONDS  number of one-second stream lines (default 90)
# Environment variables of the same names win when the harness passes them.
#
# It emits one valid system/init record, one assistant stream-json line per
# second, then a valid success result. It never edits a file, so the harness
# repository stays clean and no patch is published.
set -eu
# The harness probes `<exe> --version` (2 s deadline, stdin open) before every
# run; answer it before anything that reads stdin or sources the conf file.
if [ "${1:-}" = "--version" ]; then
  echo '2.1.0 (Claude Code)'
  exit 0
fi
directory=${0%/*}
if [ -f "$directory/fs06-fake.conf" ]; then
  # shellcheck disable=SC1091
  . "$directory/fs06-fake.conf"
fi
seconds=${FS06_FAKE_SECONDS:-90}
if [ -n "${FS06_FAKE_COUNTER:-}" ]; then
  printf '%s pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >> "$FS06_FAKE_COUNTER"
fi
session=$(cat /proc/sys/kernel/random/uuid)
printf '%s\n' "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$session\",\"claude_code_version\":\"2.1.0\",\"model\":\"fs06-fake\"}"
index=1
while [ "$index" -le "$seconds" ]; do
  printf '%s\n' "{\"type\":\"assistant\",\"session_id\":\"$session\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"fs06 fake stream line $index of $seconds\"}]}}"
  sleep 1
  index=$((index + 1))
done
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"$session\"}"
