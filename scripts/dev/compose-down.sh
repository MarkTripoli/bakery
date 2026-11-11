#!/usr/bin/env bash
# Tear down a stack started by scripts/dev/compose-up.sh: removes the
# Compose project (containers, volumes) and the per-project `.env.<project>`
# file it wrote, so nothing outlives its worktree.
#
# Usage:
#   scripts/dev/compose-down.sh <project-name>
#
# Needs the same environment the stack was started with (for example
# BETTER_AUTH_SECRET): a missing variable fails before anything is removed.
set -euo pipefail

project="${1:?Usage: scripts/dev/compose-down.sh <project-name>}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Fail on a missing interpolation variable (for example BETTER_AUTH_SECRET)
# before anything is removed: `down` re-reads infra/compose.yaml, so a stack
# started with the variable needs it again here.
docker compose --project-name "$project" -f infra/compose.yaml config -q

# One-off containers (`docker compose run -d`, for example the outbox
# dispatcher) are not part of `down`.
# Remove everything carrying this project's label first.
docker ps -aq --filter "label=com.docker.compose.project=$project" |
  xargs -r docker rm -f >/dev/null

docker compose --project-name "$project" -f infra/compose.yaml down -v --remove-orphans
rm -f "$repo_root/.env.${project}"
