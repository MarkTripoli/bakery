#!/usr/bin/env bash
# Starts self-hosted Inngest (`inngest start`) from Railway service variables.
# Every secret reaches the process through its environment only; none is placed
# on the command line, where it would show up in /proc/<pid>/cmdline.
#
# Required variables: BAKERY_POSTGRES_HOST, BAKERY_INNGEST_DATABASE_PASSWORD,
#   INNGEST_REDIS_URI, INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY, INNGEST_SDK_URL.
# Optional: BAKERY_POSTGRES_PORT (5432), INNGEST_PORT (8288),
#   INNGEST_POLL_INTERVAL (60), INNGEST_TICK (1000), BAKERY_WAIT_FOR_READY
#   (host:port of the API; waits for GET /health/ready, at most 600 s).
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 78
}

for name in BAKERY_POSTGRES_HOST BAKERY_INNGEST_DATABASE_PASSWORD INNGEST_REDIS_URI INNGEST_EVENT_KEY INNGEST_SIGNING_KEY INNGEST_SDK_URL; do
  [[ -n "${!name:-}" ]] || fail "${name}_REQUIRED"
done
[[ "$BAKERY_INNGEST_DATABASE_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]] || fail 'INNGEST_DATABASE_PASSWORD_MUST_BE_URI_SAFE'
[[ "$BAKERY_POSTGRES_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'BAKERY_POSTGRES_HOST_INVALID'
postgres_port="${BAKERY_POSTGRES_PORT:-5432}"
[[ "$postgres_port" =~ ^[0-9]{1,5}$ ]] || fail 'BAKERY_POSTGRES_PORT_INVALID'

# Optional wait for the API, so the first SDK sync finds it. Starts anyway on
# timeout.
if [[ -n "${BAKERY_WAIT_FOR_READY:-}" ]]; then
  [[ "$BAKERY_WAIT_FOR_READY" =~ ^([A-Za-z0-9.-]+):([0-9]{1,5})$ ]] || fail 'BAKERY_WAIT_FOR_READY_INVALID'
  wait_host="${BASH_REMATCH[1]}"
  wait_port="${BASH_REMATCH[2]}"
  waited=0
  while ((waited < 600)); do
    if (
      exec 3<> "/dev/tcp/$wait_host/$wait_port" &&
        printf 'GET /health/ready HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$wait_host" >&3 &&
        head -n 1 <&3 | grep -q ' 200 '
    ) 2> /dev/null; then
      break
    fi
    sleep 3
    waited=$((waited + 3))
  done
fi

export INNGEST_POSTGRES_URI="postgres://inngest:${BAKERY_INNGEST_DATABASE_PASSWORD}@${BAKERY_POSTGRES_HOST}:${postgres_port}/inngest"
# '[::]' binds the tcp6 wildcard (dual-stack on Linux), which Railway private
# networking needs; plain '::' fails with "too many colons in address".
export INNGEST_HOST='[::]'
export INNGEST_PORT="${INNGEST_PORT:-8288}"
export INNGEST_POLL_INTERVAL="${INNGEST_POLL_INTERVAL:-60}"
# Default 150 ms keeps an idle instance busy; 1000 ms trades up to a second of
# function start latency for a quiet CPU on the smallest Railway plan.
export INNGEST_TICK="${INNGEST_TICK:-1000}"
export INNGEST_POSTGRES_MAX_OPEN_CONNS="${INNGEST_POSTGRES_MAX_OPEN_CONNS:-20}"
export INNGEST_POSTGRES_MAX_IDLE_CONNS="${INNGEST_POSTGRES_MAX_IDLE_CONNS:-5}"
unset BAKERY_INNGEST_DATABASE_PASSWORD BAKERY_POSTGRES_HOST BAKERY_POSTGRES_PORT BAKERY_WAIT_FOR_READY

exec inngest start
