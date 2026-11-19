#!/usr/bin/env bash
# Keeps a shared self-hosted runner host from filling its root disk.
# Installed to /usr/local/sbin and run from /etc/cron.d every 15 minutes (see
# docs/runbooks/runner-host-maintenance.md). It removes only Docker objects that no
# container uses (for the runner user in GUARD_USERS only), and only past an age limit:
# - at or above LIMIT_PCT of the root disk it prunes everything older than
#   MIN_AGE_HOURS, plus images and build cache older than 72 hours;
# - below it, it still sweeps leaked containers and volumes older than
#   IDLE_AGE_HOURS, so test databases a killed run left behind do not pile up
#   unseen until the disk is full and Docker itself stops answering.
set -u
LIMIT_PCT="${LIMIT_PCT:-75}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-2}"
IDLE_AGE_HOURS="${IDLE_AGE_HOURS:-24}"
# Only this project's own runner user. Other projects' runners share these hosts
# under the `runner` user and their Docker is not ours to prune.
GUARD_USERS="${GUARD_USERS:-ci-runner}"
GUARD_RUN_DIR="${GUARD_RUN_DIR:-/run/user}"

log() {
  if [ -n "${GUARD_LOG_FILE:-}" ]; then
    printf '%s\n' "$*" >> "$GUARD_LOG_FILE"
  else
    logger -t runner-disk-guard "$*"
  fi
}
root_pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }

# The age limit for a root disk that is `used` percent full.
age_hours_for() {
  if [ "${1:-0}" -ge "$LIMIT_PCT" ]; then echo "$MIN_AGE_HOURS"; else echo "$IDLE_AGE_HOURS"; fi
}

# Prints every dangling volume created before the cutoff (epoch seconds), one per line.
eligible_volumes() {
  local cutoff="$1" vol created ts
  while read -r vol; do
    [ -n "$vol" ] || continue
    created="$(docker volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null)" || {
      log "cannot inspect volume $vol"
      continue
    }
    ts="$(date -u -d "$created" +%s 2>/dev/null)" || {
      log "cannot read the creation time of volume $vol: $created"
      continue
    }
    if [ "$ts" -lt "$cutoff" ]; then printf '%s\n' "$vol"; fi
  done < <(docker volume ls -q -f dangling=true)
}

# prune_docker <age-hours> <pressure 0|1>
# Stopped containers go first: a volume is only dangling once the last container
# that held it is gone, so pruning them after the volumes left those volumes for
# the next run. Every failed removal is logged.
prune_docker() {
  local hours="$1" pressure="$2" cutoff vol out
  cutoff="$(date -u -d "-${hours} hours" +%s)"
  docker container prune -f --filter "until=${hours}h" >/dev/null 2>&1 || log "container prune failed"
  while read -r vol; do
    [ -n "$vol" ] || continue
    if out="$(docker volume rm "$vol" 2>&1)"; then
      log "removed volume $vol"
    else
      log "could not remove volume $vol: $out"
    fi
  done < <(eligible_volumes "$cutoff")
  if [ "$pressure" = 1 ]; then
    docker image prune -af --filter "until=72h" >/dev/null 2>&1 || log "image prune failed"
    docker builder prune -af --filter "until=72h" >/dev/null 2>&1 || log "build cache prune failed"
  fi
}

main() {
  local used hours pressure=0 user uid sock
  used="$(root_pct)"
  hours="$(age_hours_for "${used:-0}")"
  if [ "${used:-0}" -ge "$LIMIT_PCT" ]; then
    pressure=1
    log "root filesystem at ${used}% (limit ${LIMIT_PCT}%): pruning unused Docker objects older than ${hours}h"
  fi
  for user in $GUARD_USERS; do
    uid="$(id -u "$user" 2>/dev/null)" || continue
    sock="${GUARD_RUN_DIR}/${uid}/docker.sock"
    [ -S "$sock" ] || { log "no Docker socket for ${user}"; continue; }
    export DOCKER_HOST="unix://${sock}"
    timeout 60 docker info >/dev/null 2>&1 || { log "Docker for ${user} is not answering"; continue; }
    prune_docker "$hours" "$pressure"
  done
  if [ "$pressure" = 1 ]; then
    journalctl --vacuum-size=200M >/dev/null 2>&1
    apt-get clean >/dev/null 2>&1
    log "root filesystem now at $(root_pct)%"
  fi
}

# Sourcing the file (the guard test does) defines the functions and runs nothing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi
