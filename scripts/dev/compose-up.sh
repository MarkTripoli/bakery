#!/usr/bin/env bash
# Bring up an `infra/compose.yaml` stack under its own Compose project name
# with every host-published port dynamically assigned, so N of these can run
# concurrently (multiple worktrees, multiple agents) without colliding on
# 5432/8288/8000.
#
# This follows the ephemeral-port precedent already used in this repo
# (.github/workflows/backend-connected-native.yml's `native` job): publish
# each service on port 0 so the kernel picks a free ephemeral port, bring the
# stack up, then read the real assigned port back with `docker compose port`
# rather than probing for a "free" port ahead of time (which races).
#
# Usage:
#   scripts/dev/compose-up.sh <project-name> [service...]
#
# <project-name> is a `--project-name` you invent per worktree (e.g.
# `bakery-<issue>-<short-hash>`). This script does not invent naming for
# you; it only removes the "pick free ports
# yourself" step. [service...] defaults to the full stack; pass a subset
# (e.g. `postgres redis inngest`) to start only those services.
#
# Any of BAKERY_POSTGRES_PORT / BAKERY_INNGEST_PORT / BAKERY_SERVER_PORT
# already set in the calling environment are left alone
# (e.g. to pin one port while letting the others float); only the ones left
# unset default to "0" here.
#
# Writes the resolved ports and connection strings to `.env.<project-name>`
# at the repo root (already gitignored via the existing `.env.*` pattern) --
# `set -a; source .env.<project-name>; set +a` before `pnpm dev` or
# `pnpm --dir apps/web test:ui` to point host processes at this stack.
set -euo pipefail

project="${1:?Usage: scripts/dev/compose-up.sh <project-name> [service...]}"
shift
services=("$@")
if [ "${#services[@]}" -eq 0 ]; then
  services=(postgres redis inngest server worker)
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

export BAKERY_POSTGRES_PORT="${BAKERY_POSTGRES_PORT:-0}"
export BAKERY_INNGEST_PORT="${BAKERY_INNGEST_PORT:-0}"
export BAKERY_SERVER_PORT="${BAKERY_SERVER_PORT:-0}"

compose=(docker compose --project-name "$project" -f infra/compose.yaml)

"${compose[@]}" up -d --wait "${services[@]}"

# `docker compose port <service> <container-port>` prints "<ip>:<port>" for
# a published port, or nothing (exit 1) if that service wasn't started in
# this invocation -- tolerate the latter for a partial `services` list, and
# always return 0 so a miss doesn't trip `set -e` at the call site.
resolve_port() {
  local service="$1" container_port="$2" address
  address="$("${compose[@]}" port "$service" "$container_port" 2>/dev/null || true)"
  if [ -n "$address" ]; then
    echo "${address##*:}"
  fi
  return 0
}

postgres_port="$(resolve_port postgres 5432)"
inngest_port="$(resolve_port inngest 8288)"
server_port="$(resolve_port server 8000)"

env_file="$repo_root/.env.${project}"
{
  if [ -n "$postgres_port" ]; then
    printf 'BAKERY_POSTGRES_PORT=%s\n' "$postgres_port"
  fi
  if [ -n "$inngest_port" ]; then
    printf 'BAKERY_INNGEST_PORT=%s\n' "$inngest_port"
  fi
  if [ -n "$server_port" ]; then
    printf 'BAKERY_SERVER_PORT=%s\n' "$server_port"
    printf 'BAKERY_SERVER_HOST=127.0.0.1\n'
    printf 'BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:%s\n' "$server_port"
  fi
  if [ -n "$postgres_port" ]; then
    printf 'DATABASE_URL=postgres://bakery:%s@127.0.0.1:%s/bakery\n' \
      "${BAKERY_LOCAL_BAKERY_PASSWORD:-bakery-local-bakery}" "$postgres_port"
    printf 'BAKERY_APP_DATABASE_URL=postgres://bakery_app:%s@127.0.0.1:%s/bakery\n' \
      "${BAKERY_LOCAL_APP_PASSWORD:-bakery-local-app}" "$postgres_port"
  fi
  if [ -n "$inngest_port" ]; then
    printf 'INNGEST_URL=http://127.0.0.1:%s\n' "$inngest_port"
  fi
} >"$env_file"

echo "Stack '$project' is up. Resolved ports written to ${env_file#"$repo_root"/}:"
cat "$env_file"
echo
echo "Point host processes at it: set -a; source ${env_file#"$repo_root"/}; set +a"
