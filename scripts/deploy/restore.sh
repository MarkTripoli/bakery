#!/usr/bin/env bash
set -euo pipefail
# Restore an installation in place from a completed backup set (issue #64 slice
# E2). This is DESTRUCTIVE: it replaces the whole installation's stores. It is
# run as root on the host, by the operator who holds the age identity.
#
#   sudo bash /opt/bakery/deploy/restore.sh <set> <age identity> --confirm <set name>
#
# Order, and why:
#   1. refuse unless the typed confirmation is the set's own name;
#   2. refuse unless a restore drill of THIS set passes now (restore-drill.sh);
#   3. refuse unless a backup of the current installation is taken first, so a
#      restore can itself be undone;
#   4. put the Caddy pending page up and stop the api, dispatch, worker and
#      Inngest;
#   5. replace Postgres (bakery, inngest), Redis and the skills tree from the
#      set; the worker's state is MOVED ASIDE and never restored: a copied
#      worker journal must not be replayed against older database truth;
#   6. bring the schema up to the running release (the fence needs it), then run
#      the restore-fence task: every unsettled effect becomes uncertain, every
#      active attempt is quarantined, every worker host is revoked;
#   7. start the api only (the restore hold keeps every guarded door closed) and
#      put the proxy back. Dispatch, the worker and Inngest stay stopped until an
#      installation administrator re-enables the installation (slice E3).
#
# Exit 0: restored and held. 64: bad arguments. 65: confirmation missing or not
# the set's name. 66: the drill of this set did not pass. 67: the pre-restore
# backup was not taken. 70: the host lacks Deno or the release checkout. 77: not
# root. 1: the restore failed after the stores were touched; the message names
# the pre-restore backup, and the installation stays stopped.
#
# BAKERY_BACKUP_SANDBOX is for tests only (it roots the paths and skips the root
# check); it is refused unless BAKERY_ENV=test, before anything is touched. The
# systemd units and operators never set it.
if [[ -n "${BAKERY_BACKUP_SANDBOX:-}" ]]; then
  if [[ "${BAKERY_ENV:-}" != test ]]; then
    echo "BAKERY_BACKUP_SANDBOX is only honoured when BAKERY_ENV=test; refusing to run" >&2
    exit 64
  fi
  root=$BAKERY_BACKUP_SANDBOX/opt/bakery
  state=$BAKERY_BACKUP_SANDBOX/var/lib/bakery
  etc=$BAKERY_BACKUP_SANDBOX/etc/bakery
else
  [[ "$(id -u)" == 0 ]] || exit 77
  root=/opt/bakery
  state=/var/lib/bakery
  etc=/etc/bakery
fi
set_dir=${1:?completed backup directory required}
identity=${2:?operator age identity file required}
flag=${3:-}
typed=${4:-}
usage="usage: restore.sh <completed backup directory> <age identity file> --confirm <set name>"
if [[ ! -d "$set_dir" || ! -f "$identity" || "$flag" != --confirm ]]; then
  echo "$usage" >&2
  exit 64
fi
umask 077

set_name=$(basename "$set_dir")
if [[ "$typed" != "$set_name" ]]; then
  echo "RESTORE_CONFIRMATION_REQUIRED: this replaces the whole installation. Run it again with --confirm $set_name to say you mean this set. Nothing was changed." >&2
  exit 65
fi

export DENO_DIR=${DENO_DIR:-$state/backup-runner/deno}
missing=""
command -v deno > /dev/null 2>&1 || missing="deno (install Deno and put it on the PATH)"
[[ -d "$root/background" ]] || missing+="${missing:+; }the release checkout $root/background (install or enable a release)"
if [[ -n "$missing" ]]; then
  echo "restore.sh cannot run; missing: $missing. Nothing was changed." >&2
  exit 70
fi

runtime=$root/deploy/runtime.sh
compose=(docker compose --env-file "$etc/infra.env" -f "$root/production/compose.yaml")

# 2. The drill of this set, now. It reports nothing (the API may be the thing
# being replaced); it only has to pass.
if ! bash "$root/deploy/restore-drill.sh" "$set_dir" "$identity" --no-report > /dev/null; then
  echo "RESTORE_REFUSED_DRILL_FAILED: the restore drill of $set_name did not pass, so it will not be restored. Run restore-drill.sh on it to see why. Nothing was changed." >&2
  exit 66
fi

# 3. A backup of what is here now.
# backup.sh's stderr goes through, so a refusal says why the backup failed.
if ! pre=$(bash "$root/deploy/backup.sh" | sed -n 's/^BACKUP_COMPLETED //p' | tail -n 1) || [[ -z "$pre" ]]; then
  echo "RESTORE_REFUSED_NO_PRE_BACKUP: a backup of the current installation could not be taken first, so nothing was changed. Fix the backup and run this again." >&2
  exit 67
fi
echo "PRE_RESTORE_BACKUP $pre"

failed() {
  echo "RESTORE_FAILED: the stores may be partly replaced and the installation is stopped. The pre-restore backup is $pre. Do not start any service; restore $pre or fix the cause and run this again." >&2
}
trap failed ERR

# 4. Pending page, then stop everything that writes.
state_file=$state/deploy/state.json
active_sha=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).active.sha' "$state_file")
active_slot=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).active.slot' "$state_file")
render_proxy() {
  node --input-type=module - "$1" "$root" "$etc" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [, , which, root, etc] = process.argv;
const { renderCaddy } = await import(`${root}/deploy/release.mjs`);
const config = JSON.parse(readFileSync(`${etc}/deployment.json`, 'utf8'));
const active = which === 'pending' ? null : JSON.parse(which);
writeFileSync(`${etc}/Caddyfile.next`, renderCaddy(config, active, root), { mode: 0o644 });
JS
  bash "$runtime" proxy "$etc/Caddyfile.next"
}
render_proxy pending
bash "$runtime" api-stop blue
bash "$runtime" api-stop green
bash "$runtime" background stop
bash "$runtime" inngest-stop
"${compose[@]}" up --detach --wait postgres redis

# 5. Postgres: each database is dropped and recreated from its dump, with the
# owners and grants it was dumped with (the roles are cluster-level and exist).
for database in bakery inngest; do
  "${compose[@]}" exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atqc \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$database' and pid <> pg_backend_pid()" > /dev/null
  age --decrypt --identity "$identity" "$set_dir/$database.dump.age" |
    "${compose[@]}" exec -T postgres pg_restore -U postgres --dbname postgres \
      --create --clean --if-exists --exit-on-error
done

# Redis: the append-only file wins over an RDB at start, so the snapshot is
# loaded by a one-shot server with the append-only file off, which then turns it
# on (writing a fresh base from memory) before the real server starts.
"${compose[@]}" stop redis
rm -rf "$state/redis/appendonlydir" "$state/redis/dump.rdb"
age --decrypt --identity "$identity" "$set_dir/redis.rdb.age" > "$state/redis/dump.rdb"
"${compose[@]}" run --rm --no-deps -T --entrypoint sh redis -eu -c '
  redis-server --dir /data --dbfilename dump.rdb --appendonly no --requirepass "$REDIS_PASSWORD" --daemonize yes > /dev/null
  export REDISCLI_AUTH="$REDIS_PASSWORD"
  until redis-cli ping > /dev/null 2>&1; do sleep 1; done
  redis-cli config set appendonly yes > /dev/null
  until [ "$(redis-cli info persistence | tr -d "\r" | sed -n "s/^aof_rewrite_in_progress://p")" = 0 ]; do sleep 1; done
  redis-cli shutdown nosave || true
'
"${compose[@]}" up --detach --wait redis

# Skills: the current tree is moved aside, the set's tree is put in its place.
# The worker's state is moved aside and a new empty directory takes its place,
# with the same owner and mode: it is never restored.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mv "$state/skills" "$state/skills.pre-restore-$stamp"
age --decrypt --identity "$identity" "$set_dir/files.tar.gz.age" |
  tar -xzf - --same-owner -C "$state" skills
mv "$state/worker" "$state/worker.pre-restore-$stamp"
install -d -o "$(stat -c %u "$state/worker.pre-restore-$stamp")" -g "$(stat -c %g "$state/worker.pre-restore-$stamp")" \
  -m "$(stat -c %a "$state/worker.pre-restore-$stamp")" "$state/worker"

# 6. Schema first (the fence's table is a migration), then the fence.
bash "$runtime" migrate "$active_sha"
cutoff_at=$(node -p 'const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/manifest.json")); (m.cutoff ? m.cutoff.at : m.cutoffAt) || ""' "$set_dir")
fence_args=(--backup-name "$set_name")
[[ -z "$cutoff_at" ]] || fence_args+=(--cutoff-at "$cutoff_at")
fence=$(bash "$runtime" restore-fence "$active_sha" "${fence_args[@]}")
echo "RESTORE_FENCE $fence"

# 7. The api only, then the proxy. Dispatch, the worker and Inngest stay stopped.
bash "$runtime" api-start "$active_slot" "$active_sha"
render_proxy "{\"slot\":\"$active_slot\",\"sha\":\"$active_sha\"}"
trap - ERR
printf 'RESTORE_COMPLETED_HELD %s from %s (pre-restore backup %s). Dispatch, the worker and Inngest are stopped; an installation administrator must re-enable the installation.\n' "$active_slot" "$set_name" "$pre"
