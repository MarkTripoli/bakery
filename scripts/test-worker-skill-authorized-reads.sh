#!/usr/bin/env bash
set -euo pipefail

lock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bakery-verification.lock"
if [[ ${BAKERY_279_AUTH_READS_LOCKED:-} != 1 ]]; then
  exec flock -x "$lock" env BAKERY_279_AUTH_READS_LOCKED=1 bash "$0" "$@"
fi

available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
if [[ ! $available_kib =~ ^[0-9]+$ ]] || (( available_kib < 3145728 )); then
  printf 'issue279-authorized-reads: MemAvailable=%s KiB; need >=3145728 KiB\n' \
    "${available_kib:-unknown}" >&2
  exit 75
fi

unset DATABASE_URL BAKERY_APP_DATABASE_URL BAKERY_ADMIN_DATABASE_URL
unset FIXTURE_APP_DATABASE_URL INNGEST_URL BAKERY_PUBLIC_BASE_URL
unset BAKERY_CONTAINER_BASE_URL BAKERY_SERVER_URL
unset BAKERY_POSTGRES_PORT BAKERY_INNGEST_PORT
unset BAKERY_SERVER_PORT

export DOCKER_HOST="unix:///run/user/$(id -u)/formation-docker.sock"
docker version >/dev/null

suffix=$(tr -d - < /proc/sys/kernel/random/uuid)
project="bakery-279-authorized-reads-${suffix:0:12}"
postgres_password="p${suffix}"
bakery_password="b${suffix}"
app_password="a${suffix}"
inngest_password="i${suffix}"
export BAKERY_POSTGRES_PORT=0
export BAKERY_LOCAL_POSTGRES_PASSWORD="$postgres_password"
export BAKERY_LOCAL_BAKERY_PASSWORD="$bakery_password"
export BAKERY_LOCAL_APP_PASSWORD="$app_password"
export BAKERY_LOCAL_INNGEST_PASSWORD="$inngest_password"
export BETTER_AUTH_SECRET="issue279${suffix}auth"
compose=(docker compose --project-name "$project" -f infra/compose.yaml)

cleanup_status=0
cleanup() {
  local incoming=$?
  trap - EXIT INT TERM HUP
  if ! "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; then
    cleanup_status=1
  fi
  if (( incoming != 0 )); then exit "$incoming"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT INT TERM HUP

started=0
for attempt in 1 2 3; do
  if compose_output=$("${compose[@]}" up -d --wait postgres 2>&1); then
    started=1
    break
  fi
  if [[ $compose_output != *"address already in use"* ]]; then
    printf '%s\n' "$compose_output" >&2
    exit 1
  fi
  printf 'issue279-authorized-reads: owned port collision; retry=%s/3\n' "$attempt" >&2
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
done
if (( started == 0 )); then
  printf 'issue279-authorized-reads: bounded owned port retries exhausted\n' >&2
  exit 1
fi
mapping=$("${compose[@]}" port postgres 5432)
postgres_port=${mapping##*:}
if [[ ! $postgres_port =~ ^[0-9]+$ ]] || (( postgres_port < 1 )); then
  printf 'issue279-authorized-reads: invalid PostgreSQL mapping\n' >&2
  exit 1
fi
container="${project}-postgres-1"
[[ $(docker inspect -f '{{.State.Health.Status}}' "$container") == healthy ]]
[[ $(docker exec "$container" psql -U postgres -d bakery -Atqc 'select current_user') == postgres ]]
[[ $(docker exec -e PGPASSWORD="$bakery_password" "$container" \
  psql -h 127.0.0.1 -U bakery -d bakery -Atqc 'select current_user') == bakery ]]
[[ $(docker exec -e PGPASSWORD="$app_password" "$container" \
  psql -h 127.0.0.1 -U bakery_app -d bakery -Atqc 'select current_user') == bakery_app ]]
if PGPASSWORD=wrong psql -h 127.0.0.1 -p "$postgres_port" \
  -U bakery_app -d bakery -Atqc 'select 1' >/dev/null 2>&1; then
  printf 'issue279-authorized-reads: wrong-password check unexpectedly passed\n' >&2
  exit 1
fi

export DATABASE_URL="postgres://bakery:${bakery_password}@127.0.0.1:${postgres_port}/bakery"
export BAKERY_APP_DATABASE_URL="postgres://bakery_app:${app_password}@127.0.0.1:${postgres_port}/bakery"
export BAKERY_ADMIN_DATABASE_URL="postgres://postgres:${postgres_password}@127.0.0.1:${postgres_port}/bakery"
printf 'issue279-authorized-reads: project=%s postgres_port=%s MemAvailable=%sKiB roles=ready\n' \
  "$project" "$postgres_port" "$available_kib"

pnpm fmt
pnpm lint
pnpm typecheck
pnpm test:unit -- tests/unit/materialize-authorized-skills-worker_test.ts
pnpm test:integration -- tests/integration/materialize-authorized-skills-worker_test.ts
pnpm test:security -- tests/security/materialize-authorized-skills-worker_test.ts
