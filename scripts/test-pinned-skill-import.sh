#!/usr/bin/env bash
set -euo pipefail

lock=/run/user/1000/bakery-verification.lock
if [[ ${BAKERY_IMPORT_STACK_LOCKED:-} != 1 ]]; then
  exec flock -x "$lock" env BAKERY_IMPORT_STACK_LOCKED=1 bash "$0" "$@"
fi

available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
if [[ ! $available_kib =~ ^[0-9]+$ ]] || (( available_kib < 3145728 )); then
  printf 'issue278: MemAvailable=%s KiB; need >=3145728 KiB before stack creation\n' "${available_kib:-unknown}" >&2
  exit 75
fi

unset DATABASE_URL BAKERY_APP_DATABASE_URL BAKERY_ADMIN_DATABASE_URL
unset FIXTURE_APP_DATABASE_URL INNGEST_URL BAKERY_PUBLIC_BASE_URL
unset BAKERY_CONTAINER_BASE_URL BAKERY_SERVER_URL
unset BAKERY_REMOTE_SKILL_SOURCE_URL BAKERY_POSTGRES_PORT BAKERY_INNGEST_PORT
unset BAKERY_SERVER_PORT

export DOCKER_HOST="unix:///run/user/$(id -u)/formation-docker.sock"
docker version >/dev/null

projects=()
roots=()
cleanup_status=0
cleanup() {
  local incoming=$?
  trap - EXIT INT TERM HUP
  for root in "${roots[@]:-}"; do
    [[ -n $root ]] || continue
    for pid_file in "$root"/*.pid; do
      [[ -f $pid_file ]] || continue
      pid=$(cat "$pid_file" 2>/dev/null || true)
      if [[ $pid =~ ^[0-9]+$ ]]; then
        kill -TERM "$pid" 2>/dev/null || true
        sleep 0.1
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  done
  for project in "${projects[@]:-}"; do
    [[ -n $project ]] || continue
    DOCKER_HOST="$DOCKER_HOST" docker rm -f \
      "${project}-inngest-host" "${project}-redis-host" \
      >/dev/null 2>&1 || true
    if ! BETTER_AUTH_SECRET=cleanup \
      DOCKER_HOST="$DOCKER_HOST" \
      docker compose --project-name "$project" -f infra/compose.yaml \
      down -v --remove-orphans >/dev/null 2>&1; then
      cleanup_status=1
    fi
  done
  for root in "${roots[@]:-}"; do
    [[ -n $root ]] && rm -rf -- "$root"
  done
  if (( incoming != 0 )); then exit "$incoming"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT INT TERM HUP

run_stack_test() {
  local lane=$1
  local file=$2
  local suffix=$3
  local project="bakery-278-${suffix}-$$"
  local root="${TMPDIR:-/tmp}/${project}"
  install -d -m 0700 "$root"
  projects+=("$project")
  roots+=("$root")
  printf 'issue278: lane=%s project=%s root=%s MemAvailable=%sKiB DOCKER_HOST=%s\n' \
    "$lane" "$project" "$root" "$available_kib" "$DOCKER_HOST"
  BAKERY_IMPORT_STACK_PROJECT="$project" \
  BAKERY_IMPORT_STACK_ROOT="$root" \
  timeout 900s deno test -A "$file"
}

case ${1:-all} in
  integration)
    run_stack_test integration \
      tests/integration/import-pinned-remote-skill-real-stack_test.ts integration
    ;;
  recovery)
    run_stack_test recovery \
      tests/recovery/import-pinned-remote-skill-real-stack_test.ts recovery
    ;;
  all)
    run_stack_test integration \
      tests/integration/import-pinned-remote-skill-real-stack_test.ts integration
    run_stack_test recovery \
      tests/recovery/import-pinned-remote-skill-real-stack_test.ts recovery
    ;;
  *)
    printf 'usage: %s [all|integration|recovery]\n' "$0" >&2
    exit 2
    ;;
esac
