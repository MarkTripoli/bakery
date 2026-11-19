#!/usr/bin/env bash
# Keeps the bakery checkout of each self-hosted runner from growing without bound.
# Installed to /usr/local/sbin and run hourly from /etc/cron.d/runner-git-guard.
#
# actions/checkout leaves one refs/remotes/pull/<n>/merge per PR it ever built and
# the checkout has gc.auto=0, so git never repacks: every PR merge commit stays
# reachable and the pack grew to 9 GB on one host. The pull refs are re-fetched by
# the next job that needs them, so they are safe to drop.
#
# Only touches a runner that is idle (no Runner.Worker from its directory), and
# re-checks between steps. gc uses the default 2-hour prune window so an object a
# job has just fetched is never pruned. DRY_RUN=1 only reports.
set -u
log() { logger -t runner-git-guard "$*"; echo "$*"; }
MIN_PACKS="${MIN_PACKS:-20}"
# Only this project's runner checkout. Other projects' runners share these hosts under
# other users, and a checkout under their directories is not ours to gc.
GUARD_OWNER="${GUARD_OWNER:-ci-runner}"
GUARD_CHECKOUTS="${GUARD_CHECKOUTS:-/opt/actions-runner/_work/bakery/bakery}"

busy() { pgrep -f "$1/bin[.0-9]*/Runner[.]Worker" >/dev/null 2>&1; }

for ws in $GUARD_CHECKOUTS; do
  [ -d "$ws/.git" ] || continue
  runner_dir="${ws%/_work/*}"
  owner="$(stat -c %U "$ws")"
  if [ "$owner" != "$GUARD_OWNER" ]; then log "$ws: owned by $owner, not $GUARD_OWNER: skipped"; continue; fi
  if busy "$runner_dir"; then log "$ws: runner busy, skipped"; continue; fi
  git_in() { runuser -u "$owner" -- git -c safe.directory="$ws" -C "$ws" "$@"; }
  packs="$(git_in count-objects -v 2>/dev/null | awk '/^packs:/{print $2}')"
  pulls="$(git_in for-each-ref --format='%(refname)' refs/remotes/pull 2>/dev/null | wc -l)"
  if [ "${pulls:-0}" -eq 0 ] && [ "${packs:-0}" -lt "$MIN_PACKS" ]; then continue; fi
  log "$ws: ${pulls} pull refs, ${packs} packs: pruning refs and repacking"
  [ "${DRY_RUN:-0}" = 1 ] && continue
  if [ "$(df --output=avail / | tail -1 | tr -dc 0-9)" -lt 4000000 ]; then log "$ws: under 4 GB free, skipped"; continue; fi
  git_in for-each-ref --format='%(refname)' refs/remotes/pull | runuser -u "$owner" -- xargs -r -n1 git -c safe.directory="$ws" -C "$ws" update-ref -d
  if busy "$runner_dir"; then log "$ws: a job started, gc skipped"; continue; fi
  git_in reflog expire --expire=now --all
  nice -n 10 ionice -c3 runuser -u "$owner" -- git -c safe.directory="$ws" -C "$ws" gc --quiet
  log "$ws: done, .git is $(du -xsh "$ws/.git" | cut -f1)"
done
