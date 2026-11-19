#!/usr/bin/env bash
# Bakery runner pre-job hook (ACTIONS_RUNNER_HOOK_JOB_STARTED). Installed 2026-11-19 under #559.
# Fails the job in seconds with a clear message when the root disk is nearly full,
# after one cheap cleanup of this runner's own leftovers. Rollback: remove the two
# ACTIONS_RUNNER_HOOK_* lines from /opt/actions-runner/.env and restart the runner.
set -u
MIN_FREE_GB="${RUNNER_MIN_FREE_GB:-10}"
free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }
free="$(free_gb)"
if [ "${free:-0}" -lt "$MIN_FREE_GB" ]; then
  /usr/local/sbin/runner-job-cleanup.sh 10 || true
  free="$(free_gb)"
fi
if [ "${free:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "RUNNER_DISK_LOW: $(hostname) / has ${free} GB free, needs at least ${MIN_FREE_GB} GB. Failing this job before it starts so it can be re-run (gh run rerun --failed) once space is freed. See issue #559."
  exit 1
fi
exit 0
