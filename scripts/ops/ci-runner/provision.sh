#!/usr/bin/env bash
# Provision Bakery CI runner hosts from an operator machine: copy this directory to each host,
# mint a fresh repo registration token per host with `gh`, and run provision-host.sh there.
# Tokens and the optional Tailscale auth key travel over ssh stdin only.
#
# Usage:
#   scripts/ops/ci-runner/provision.sh <n> [<n> ...]
#     <n> is the host number: ssh alias hetzner-gh-ci-<n>, runner bakery-hetzner-<n>.
#   TS_AUTHKEY_FILE=<path>  optional file holding a tag:dev-machines Tailscale auth key.
#
# Hosts run in parallel; each writes its log to $LOG_DIR (default: a new mktemp directory).
set -euo pipefail

[ $# -gt 0 ] || { echo "Usage: $0 <n> [<n> ...]" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_dir="${LOG_DIR:-$(mktemp -d)}"
remote_dir=/root/bakery-ci-runner

provision() {
  local n="$1" host="hetzner-gh-ci-$1" token
  ssh -o BatchMode=yes "$host" "rm -rf $remote_dir && mkdir -p $remote_dir"
  scp -q -r "$here/provision-host.sh" "$here/files" "$host:$remote_dir/"
  local ts_key=""
  if [ -n "${TS_AUTHKEY_FILE:-}" ]; then
    ts_key="$(cat "$TS_AUTHKEY_FILE")"
    [ -n "$ts_key" ] || { echo "TS_AUTHKEY_FILE is empty: $TS_AUTHKEY_FILE" >&2; return 1; }
  fi
  token="$(gh api -X POST repos/MarkTripoli/bakery/actions/runners/registration-token --jq .token)"
  {
    printf 'RUNNER_TOKEN=%s\n' "$token"
    if [ -n "$ts_key" ]; then printf 'TS_AUTHKEY=%s\n' "$ts_key"; fi
  } | ssh -o BatchMode=yes "$host" "bash $remote_dir/provision-host.sh bakery-hetzner-$n $host"
}

pids=()
for n in "$@"; do
  provision "$n" >"$log_dir/hetzner-gh-ci-$n.log" 2>&1 &
  pids+=("$!")
done
status=0
for i in "${!pids[@]}"; do
  if wait "${pids[$i]}"; then rc=0; else rc=$?; status=1; fi
  echo "hetzner-gh-ci-${*:$((i + 1)):1}: exit $rc (log $log_dir/hetzner-gh-ci-${*:$((i + 1)):1}.log)"
done
exit $status
