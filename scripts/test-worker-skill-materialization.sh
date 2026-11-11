#!/usr/bin/env bash
set -euo pipefail

lock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bakery-verification.lock"
if [[ ${BAKERY_279_MATERIALIZATION_LOCKED:-} != 1 ]]; then
  exec flock -x "$lock" env BAKERY_279_MATERIALIZATION_LOCKED=1 bash "$0" "$@"
fi

available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
if [[ ! $available_kib =~ ^[0-9]+$ ]] || (( available_kib < 3145728 )); then
  printf 'issue279-materialization: MemAvailable=%s KiB; need >=3145728 KiB\n' \
    "${available_kib:-unknown}" >&2
  exit 75
fi

unset DATABASE_URL BAKERY_APP_DATABASE_URL BAKERY_ADMIN_DATABASE_URL
unset FIXTURE_APP_DATABASE_URL INNGEST_URL BAKERY_PUBLIC_BASE_URL
unset BAKERY_CONTAINER_BASE_URL BAKERY_SERVER_URL
unset BAKERY_POSTGRES_PORT BAKERY_INNGEST_PORT
unset BAKERY_SERVER_PORT DOCKER_HOST BAKERY_TEST_CGROUP_ROOT

formation_socket="unix:///run/user/$(id -u)/formation-docker.sock"
docker_cmd=(env "DOCKER_HOST=$formation_socket" docker)
"${docker_cmd[@]}" version >/dev/null

suffix=$(tr -d - < /proc/sys/kernel/random/uuid)
project="bakery-279-materialization-${suffix:0:12}"
postgres_password="p${suffix}"
bakery_password="b${suffix}"
app_password="a${suffix}"
inngest_password="i${suffix}"
export BAKERY_LOCAL_POSTGRES_PASSWORD="$postgres_password"
export BAKERY_LOCAL_BAKERY_PASSWORD="$bakery_password"
export BAKERY_LOCAL_APP_PASSWORD="$app_password"
export BAKERY_LOCAL_INNGEST_PASSWORD="$inngest_password"
export BETTER_AUTH_SECRET="issue279${suffix}auth"
compose=("${docker_cmd[@]}" compose --project-name "$project" -f infra/compose.yaml)
native_manifest=$(mktemp "/tmp/issue279-native-prerequisites-${suffix:0:8}.XXXXXX.json")

cleanup_status=0
cleanup() {
  local incoming=$?
  trap - EXIT INT TERM HUP
  rm -f "$native_manifest"
  if ! "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; then
    cleanup_status=1
  fi
  if (( incoming != 0 )); then exit "$incoming"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT INT TERM HUP

allocate_port() {
  deno eval \
    'import { reserveUniqueLoopbackPort } from "./tests/fixtures/loopback-port-allocation.ts"; console.log(reserveUniqueLoopbackPort(new Set()));'
}

started=0
postgres_port=""
for attempt in 1 2 3; do
  postgres_port=$(allocate_port)
  if [[ ! $postgres_port =~ ^[0-9]+$ ]] || (( postgres_port < 1 )); then
    printf 'issue279-materialization: host-visible port allocation failed\n' >&2
    exit 1
  fi
  export BAKERY_POSTGRES_PORT="$postgres_port"
  if compose_output=$("${compose[@]}" up -d --wait postgres 2>&1); then
    started=1
    break
  fi
  if [[ $compose_output != *"address already in use"* ]]; then
    printf '%s\n' "$compose_output" >&2
    exit 1
  fi
  printf 'issue279-materialization: owned port collision; retry=%s/3 port=%s\n' \
    "$attempt" "$postgres_port" >&2
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
done
if (( started == 0 )); then
  printf 'issue279-materialization: bounded owned port retries exhausted\n' >&2
  exit 1
fi

mapping=$("${compose[@]}" port postgres 5432)
mapped_port=${mapping##*:}
if [[ $mapped_port != "$postgres_port" ]]; then
  printf 'issue279-materialization: mapped port mismatch expected=%s actual=%s\n' \
    "$postgres_port" "$mapped_port" >&2
  exit 1
fi
container="${project}-postgres-1"
[[ $("${docker_cmd[@]}" inspect -f '{{.State.Health.Status}}' "$container") == healthy ]]
[[ $("${docker_cmd[@]}" exec "$container" psql -U postgres -d bakery -Atqc 'select current_user') == postgres ]]
[[ $("${docker_cmd[@]}" exec -e PGPASSWORD="$bakery_password" "$container" \
  psql -h 127.0.0.1 -U bakery -d bakery -Atqc 'select current_user') == bakery ]]
[[ $("${docker_cmd[@]}" exec -e PGPASSWORD="$app_password" "$container" \
  psql -h 127.0.0.1 -U bakery_app -d bakery -Atqc 'select current_user') == bakery_app ]]
if PGPASSWORD=wrong psql -h 127.0.0.1 -p "$postgres_port" \
  -U bakery_app -d bakery -Atqc 'select 1' >/dev/null 2>&1; then
  printf 'issue279-materialization: wrong-password check unexpectedly passed\n' >&2
  exit 1
fi
probe_database="issue279_probe_${suffix:0:8}"
"${docker_cmd[@]}" exec "$container" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "create database ${probe_database}" >/dev/null
"${docker_cmd[@]}" exec "$container" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "drop database ${probe_database}" >/dev/null

export DATABASE_URL="postgres://bakery:${bakery_password}@127.0.0.1:${postgres_port}/bakery"
export BAKERY_APP_DATABASE_URL="postgres://bakery_app:${app_password}@127.0.0.1:${postgres_port}/bakery"
export BAKERY_ADMIN_DATABASE_URL="postgres://postgres:${postgres_password}@127.0.0.1:${postgres_port}/bakery"
printf 'issue279-materialization: project=%s postgres_port=%s MemAvailable=%sKiB roles=owner,application,admin ready=true\n' \
  "$project" "$postgres_port" "$available_kib"

pnpm test:integration -- tests/integration/authenticated-binding-admission_test.ts
pnpm test:integration -- tests/integration/authenticated-pin-producer_test.ts
pnpm test:integration -- tests/integration/materialize-authorized-skills-worker_test.ts
pnpm test:e2e -- tests/e2e/materialize-authorized-skills-worker_test.ts
pnpm test:security -- tests/security/materialize-authorized-skills-worker_test.ts
pnpm test:recovery -- \
  tests/recovery/materialize-authorized-skills-worker-cache_test.ts \
  tests/recovery/materialize-authorized-skills-worker_test.ts

cat > "$native_manifest" <<EOF
{"lane":"native","authority":"explicit","resources":["issue279 delegated cgroup v2 root","issue279 owned PostgreSQL ${project}"],"cleanup":"driver releases cgroup lease and removes only ${project}"}
EOF
native_unit="bakery-279-materialization-${suffix:0:12}"
BAKERY_LANE_AUTHORIZED=true \
BAKERY_PREREQUISITE_MANIFEST="$native_manifest" \
  systemd-run --user --scope --send-sighup \
    --property=Delegate=yes \
    --unit="$native_unit" \
    pnpm test:native -- tests/native/materialize-authorized-skills-worker_test.ts
