#!/usr/bin/env bash
set -euo pipefail
# Restore drill (issue #64 slice D): restores a completed backup set into
# isolated, throwaway stores (no network, nothing mounted from production),
# checks it there, measures the backup's age (RPO) and the restore time (RTO),
# and reports the result to the server with the backup runner's credential. It
# never writes to a production store and it is not a restore in place.
#
#   sudo bash /opt/bakery/deploy/restore-drill.sh <set> <age identity> [--no-report]
#
# Exit 0: passed and reported. 1: the drill failed (and was reported). 3: the
# drill ran but its result could not be reported. 64: bad arguments. 70: the
# host lacks Deno or the release checkout. 77: not root.
#
# BAKERY_BACKUP_SANDBOX is for tests only (it roots the paths and skips the root
# check); it is refused unless BAKERY_ENV=test, before anything is touched. The
# systemd units and operators never set it.
if [[ -n "${BAKERY_BACKUP_SANDBOX:-}" ]]; then
  if [[ "${BAKERY_ENV:-}" != test ]]; then
    echo "BAKERY_BACKUP_SANDBOX is only honoured when BAKERY_ENV=test; refusing to run" >&2
    exit 64
  fi
  root=$BAKERY_BACKUP_SANDBOX/opt/bakery
  state=$BAKERY_BACKUP_SANDBOX/var/lib/bakery
  etc=$BAKERY_BACKUP_SANDBOX/etc/bakery
  scratch=$BAKERY_BACKUP_SANDBOX/var/tmp
else
  [[ "$(id -u)" == 0 ]] || exit 77
  root=/opt/bakery
  state=/var/lib/bakery
  etc=/etc/bakery
  scratch=/var/tmp
fi
snapshot=${1:?completed backup directory required}
identity=${2:?operator age identity file required}
report=${3:-}
[[ -d "$snapshot" && -f "$identity" ]] || exit 64
[[ -z "$report" || "$report" == --no-report ]] || exit 64
umask 077

# A fresh disaster-recovery host may have neither Deno nor a release checkout.
# Say so and exit 70 rather than die with 127 from a missing command.
export DENO_DIR=${DENO_DIR:-$state/backup-runner/deno}
drill="$root/background/scripts/deploy/restore-drill.ts"
missing=""
command -v deno > /dev/null 2>&1 || missing="deno (install Deno and put it on the PATH)"
[[ -f "$drill" ]] || missing+="${missing:+; }the release checkout $root/background (install or enable a release)"
if [[ -n "$missing" ]]; then
  echo "restore-drill.sh cannot run; missing: $missing. Nothing was restored." >&2
  exit 70
fi

infra_value() {
  sed -n "s/^$1=//p" "$etc/infra.env" 2> /dev/null | tail -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
key_file=$(infra_value BAKERY_SECRETS_KEY_FILE || true)
args=("$snapshot" --identity "$identity" --release-root "$root/background" --scratch-root "$scratch")
# The drill checks the key against the fingerprint the backup recorded; with no
# key file it fails that check and says so, it does not skip it.
[[ -n "$key_file" ]] && args+=(--key-file "$key_file")

# The runner's own credential reports the result. With --no-report, or with no
# runner credential on this host, the result is printed and not reported.
env_file="$etc/backup-runner.env"
permissions=(--no-prompt "--allow-read" "--allow-write=$scratch" "--allow-run=bash,age,tar,docker")
if [[ "$report" == --no-report ]]; then
  args+=(--no-report)
  permissions+=("--allow-env=BAKERY_ENV,NODE_V8_COVERAGE,PATH,HOME,LANG,TMPDIR,DOCKER_HOST,DOCKER_CONFIG,DOCKER_CONTEXT,XDG_RUNTIME_DIR")
else
  if [[ ! -s "$env_file" ]]; then
    echo "restore-drill.sh: no runner credential at $env_file, so the result cannot be reported (pass --no-report to run without it)" >&2
    exit 64
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  api_host=$(printf '%s' "${BAKERY_API_URL:-}" | sed -E 's#^[a-z]+://([^/]+).*#\1#')
  permissions+=("--allow-env=BAKERY_API_URL,BAKERY_BACKUP_RUNNER_TOKEN,BAKERY_ENV,NODE_V8_COVERAGE,PATH,HOME,LANG,TMPDIR,DOCKER_HOST,DOCKER_CONFIG,DOCKER_CONTEXT,XDG_RUNTIME_DIR" "--allow-net=$api_host")
fi
exec deno run "${permissions[@]}" "$drill" "${args[@]}"
