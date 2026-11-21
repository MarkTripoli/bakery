#!/usr/bin/env bash
# Bakery runner cleanup of this runner's own job leftovers. Installed 2026-11-19 under #559.
# Usage: runner-job-cleanup.sh <min-age-minutes>   (both hooks use 10, so nothing a running job just wrote is touched)
# Touches only ci-runner-owned entries directly under /tmp with Bakery/Playwright/Chromium names,
# plus test-results/playwright-report/blob-report dirs in the Bakery workspace and old _work/_temp files.
# One Bakery job runs at a time on this runner and the other runners on the host use another user.
set -u
AGE="${1:-10}"
cd / || exit 0
[ "$(id -un)" = "ci-runner" ] || exit 0
find /tmp -mindepth 1 -maxdepth 1 -user ci-runner -mmin "+$AGE" \
  \( -name 'bakery-*' -o -name 'playwright_*' -o -name 'playwright-*' -o -name '.org.chromium.*' -o -name 'pw-*' \) \
  -exec rm -rf -- {} + 2>/dev/null
find /opt/actions-runner/_work/bakery -maxdepth 4 -type d \
  \( -name test-results -o -name playwright-report -o -name blob-report \) -not -path '*/node_modules/*' \
  -mmin "+$AGE" -exec rm -rf -- {} + 2>/dev/null
find /opt/actions-runner/_work/_temp -mindepth 1 -mmin "+30" -exec rm -rf -- {} + 2>/dev/null
exit 0
