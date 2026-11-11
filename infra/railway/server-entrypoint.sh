#!/usr/bin/env bash
# Single entrypoint of the Bakery server image (API, dispatcher, pre-deploy,
# first-admin and variable check). Usage: server-entrypoint.sh <mode>
#
#   api              run-main.sh: allowlisted env, Deno permission flags, /tini as PID 1.
#   dispatch         outbox + execution coordinator (run-dispatch.ts).
#   predeploy        bootstrap roles/databases as superuser, then migrate as owner.
#   createsuperuser  interactive first-admin task (needs a TTY).
#   envcheck         print NAME=set|missing for a fixed list; never a secret.
#
# Never prints variables, never enables xtrace.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:-}"

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-78}"
}

load_release() {
  local file="$root/.bakery-release-sha" sha
  [[ -s "$file" ]] || fail 'RELEASE_SHA_MISSING'
  sha="$(tr -d '[:space:]' < "$file")"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'RELEASE_SHA_INVALID'
  export BAKERY_VERSION="$sha"
  export BAKERY_SENTRY_RELEASE="${BAKERY_SENTRY_RELEASE:-bakery@$sha}"
}

# Optional BAKERY_WAIT_FOR_READY=host:port: wait up to 600 s for
# GET /health/ready to answer 200 so a fresh deployment does not start before
# the API. Starts anyway on timeout; the process then reports its own errors.
wait_for_ready() {
  local target="${BAKERY_WAIT_FOR_READY:-}" host port waited=0
  [[ -n "$target" ]] || return 0
  [[ "$target" =~ ^([A-Za-z0-9.-]+):([0-9]{1,5})$ ]] || fail 'BAKERY_WAIT_FOR_READY_INVALID'
  host="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[2]}"
  while ((waited < 600)); do
    if (
      exec 3<> "/dev/tcp/$host/$port" &&
        printf 'GET /health/ready HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$host" >&3 &&
        head -n 1 <&3 | grep -q ' 200 '
    ) 2> /dev/null; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  printf '%s\n' 'WAIT_FOR_READY_TIMEOUT: starting anyway' >&2
}

envcheck() {
  local name public=""
  if [[ "${1:-}" == '--show-public' ]]; then
    public="${2:-}"
    # Only non-secret names may ever be echoed.
    case "$public" in
      BAKERY_PUBLIC_BASE_URL | BAKERY_ENV) ;;
      *) fail 'ENVCHECK_PUBLIC_NAME_REFUSED' 64 ;;
    esac
    [[ -n "${!public:-}" ]] || fail 'ENVCHECK_PUBLIC_NAME_UNSET' 1
    printf '%s=%s\n' "$public" "${!public}"
    return 0
  fi
  for name in \
    DATABASE_URL \
    BAKERY_APP_DATABASE_URL \
    BAKERY_BOOTSTRAP_DATABASE_URL \
    BAKERY_OWNER_PASSWORD \
    BAKERY_APP_PASSWORD \
    BAKERY_INNGEST_DATABASE_PASSWORD \
    BAKERY_ENV \
    BAKERY_PUBLIC_BASE_URL \
    BETTER_AUTH_SECRET \
    BETTER_AUTH_TRUSTED_ORIGINS \
    INNGEST_URL \
    INNGEST_SIGNING_KEY \
    INNGEST_EVENT_KEY \
    BAKERY_INNGEST_PRIVATE_HOST_SUFFIX \
    BAKERY_TRUSTED_PROXY_CIDRS \
    BAKERY_SECRETS_KEY_B64 \
    BAKERY_SECRETS_KEY_FILE \
    BAKERY_SECRETS_KEY_ID; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s=set\n' "$name"
    else
      printf '%s=missing\n' "$name"
    fi
  done
}

case "$mode" in
  api)
    load_release
    # shellcheck source=infra/railway/secrets-key.sh
    source "$root/infra/railway/secrets-key.sh"
    materialise_secrets_key
    cd "$root/apps/server"
    # run-main.sh re-execs through /tini with the sanitized environment, so the
    # container's PID 1 never holds the superuser, owner or key variables.
    export BAKERY_RUN_MAIN_INIT=/tini
    exec bash scripts/run-main.sh
    ;;
  dispatch)
    load_release
    wait_for_ready
    cd "$root/apps/server"
    # The image clears the Deno base ENTRYPOINT, so this process is PID 1: tini
    # reaps the dispatcher's children and forwards signals.
    exec /tini -s -- deno run --allow-env --allow-run=deno scripts/run-dispatch.ts src/dispatch.ts
    ;;
  predeploy)
    [[ -n "${BAKERY_BOOTSTRAP_DATABASE_URL:-}" ]] || fail 'BAKERY_BOOTSTRAP_DATABASE_URL_REQUIRED'
    [[ -n "${DATABASE_URL:-}" ]] || fail 'DATABASE_URL_REQUIRED'
    cd "$root"
    pnpm --filter @bakery/server bootstrap:database
    pnpm --filter @bakery/server migrate
    ;;
  createsuperuser)
    cd "$root"
    exec pnpm --filter @bakery/server createsuperuser
    ;;
  envcheck)
    shift
    envcheck "$@"
    ;;
  *)
    fail 'Usage: server-entrypoint.sh api|dispatch|predeploy|createsuperuser|envcheck' 64
    ;;
esac
