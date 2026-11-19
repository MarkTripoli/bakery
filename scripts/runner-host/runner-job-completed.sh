#!/usr/bin/env bash
# Bakery runner post-job hook (ACTIONS_RUNNER_HOOK_JOB_COMPLETED). Installed 2026-11-19 under #559.
# Artifacts are uploaded by job steps before this runs. Rollback: remove the HOOK lines from .env.
/usr/local/sbin/runner-job-cleanup.sh 10 || true
exit 0
