#!/usr/bin/env bash
set -euo pipefail
# Restore an installation to one minute (issue #80, P2). DESTRUCTIVE, like
# restore.sh: it replaces the whole installation. Run as root on the host by the
# operator who holds the age identity.
#
#   sudo bash /opt/bakery/deploy/restore-to-time.sh <set> <age identity> --to <UTC instant> \
#     --wal <directory of archived WAL> --confirm <set name>
#
# <set> is a completed backup set taken while Restore to any minute was on, so
# it carries base.tar.age. --wal names a directory holding the archived WAL
# segments (<segment>.age, as the runner ships them under <prefix>wal/); the
# host spool (/var/lib/bakery/wal-spool) is read too, for the newest segments
# not shipped yet.
#
# Order, and why:
#   1. refuse unless the confirmation is the set's name, the set has a base
#      backup, and the target is a UTC instant no earlier than the set finished;
#   2. a restore drill of this set must pass now, then a backup of the current
#      installation, so this can be undone;
#   3. pending page, stop everything that writes;
#   4. decrypt the WAL into a restore directory, move the Postgres data
#      directory aside, prepare a new one from the base backup (pitr-prepare.sh)
#      and start Postgres: it replays to the target and promotes. If the WAL
#      ends before the target, Postgres refuses and the old data is put back;
#   5. Redis and the skills tree from the set (as restore.sh); the worker's
#      state is moved aside;
#   6. schema up to the running release, then the restore fence with the
#      target as the cutoff;
#   7. the api only, then the proxy. The rest stays stopped until an
#      installation administrator re-enables the installation.
#
# Exit 0: restored and held. 64: bad arguments. 65: confirmation missing or not
# the set's name. 66: the set has no base backup. 68: the target is not a UTC
# instant or is before the set finished. 67: the pre-restore backup was not
# taken. 71: the drill of this set did not pass. 69: the archived WAL does not reach the target (the old data is back;
# the installation stays stopped). 70: the host lacks Deno or the release
# checkout. 77: not root. 1: failed after the stores were touched.
#
# BAKERY_BACKUP_SANDBOX: tests only, refused unless BAKERY_ENV=test.
if [[ -n "${BAKERY_BACKUP_SANDBOX:-}" ]]; then
  if [[ "${BAKERY_ENV:-}" != test ]]; then
    echo "BAKERY_BACKUP_SANDBOX is only honoured when BAKERY_ENV=test; refusing to run" >&2
    exit 64
  fi
  root=$BAKERY_BACKUP_SANDBOX/opt/bakery
  state=$BAKERY_BACKUP_SANDBOX/var/lib/bakery
  etc=$BAKERY_BACKUP_SANDBOX/etc/bakery
  sandboxed=1
else
  sandboxed=""
  [[ "$(id -u)" == 0 ]] || exit 77
  root=/opt/bakery
  state=/var/lib/bakery
  etc=/etc/bakery
fi
usage="usage: restore-to-time.sh <set> <age identity> --to <UTC instant> --wal <directory> --confirm <set name>"
set_dir=${1:-}
identity=${2:-}
shift 2 || { echo "$usage" >&2; exit 64; }
target="" wal_dir="" typed="" confirmed=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) target=${2:-}; shift 2 || { echo "$usage" >&2; exit 64; } ;;
    --wal) wal_dir=${2:-}; shift 2 || { echo "$usage" >&2; exit 64; } ;;
    --confirm) confirmed=1; typed=${2:-}; shift; [[ $# -gt 0 ]] && shift ;;
    *) echo "$usage" >&2; exit 64 ;;
  esac
done
if [[ ! -d "$set_dir" || ! -f "$identity" || -z "$target" || ! -d "$wal_dir" || -z "$confirmed" ]]; then
  echo "$usage" >&2
  exit 64
fi
umask 077

set_name=$(basename "$set_dir")
if [[ "$typed" != "$set_name" ]]; then
  echo "RESTORE_CONFIRMATION_REQUIRED: this replaces the whole installation. Run it again with --confirm $set_name to say you mean this set. Nothing was changed." >&2
  exit 65
fi
if [[ ! -f "$set_dir/base.tar.age" ]]; then
  echo "PITR_NO_BASE_BACKUP: $set_name was taken while Restore to any minute was off, so it has no base backup and cannot replay to a minute. Pick a set taken after the switch was turned on. Nothing was changed." >&2
  exit 66
fi
if [[ ! "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z$ ]]; then
  echo "PITR_TARGET_INVALID: $target is not a UTC instant like 2026-11-21T10:15:00Z. Nothing was changed." >&2
  exit 68
fi
finished=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1] + "/manifest.json")).finishedAt' "$set_dir")
if ! node -e 'process.exit(Date.parse(process.argv[1]) >= Date.parse(process.argv[2]) ? 0 : 1)' "$target" "$finished"; then
  echo "PITR_TARGET_BEFORE_SET: $target is before $set_name finished ($finished). Pick an earlier set. Nothing was changed." >&2
  exit 68
fi

export DENO_DIR=${DENO_DIR:-$state/backup-runner/deno}
missing=""
command -v deno > /dev/null 2>&1 || missing="deno (install Deno and put it on the PATH)"
[[ -d "$root/background" ]] || missing+="${missing:+; }the release checkout $root/background (install or enable a release)"
if [[ -n "$missing" ]]; then
  echo "restore-to-time.sh cannot run; missing: $missing. Nothing was changed." >&2
  exit 70
fi

runtime=$root/deploy/runtime.sh
compose=(docker compose --env-file "$etc/infra.env" -f "$root/production/compose.yaml")

# The drill of this set, now (as restore.sh): it only has to pass.
if ! bash "$root/deploy/restore-drill.sh" "$set_dir" "$identity" --no-report > /dev/null; then
  echo "RESTORE_REFUSED_DRILL_FAILED: the restore drill of $set_name did not pass, so it will not be restored. Run restore-drill.sh on it to see why. Nothing was changed." >&2
  exit 71
fi

# 2. A backup of what is here now.
if ! pre=$(bash "$root/deploy/backup.sh" | sed -n 's/^BACKUP_COMPLETED //p' | tail -n 1) || [[ -z "$pre" ]]; then
  echo "RESTORE_REFUSED_NO_PRE_BACKUP: a backup of the current installation could not be taken first, so nothing was changed. Fix the backup and run this again." >&2
  exit 67
fi
echo "PRE_RESTORE_BACKUP $pre"

failed() {
  echo "RESTORE_FAILED: the stores may be partly replaced and the installation is stopped. The pre-restore backup is $pre. Do not start any service; restore $pre or fix the cause and run this again." >&2
}
trap failed ERR

# 3. Pending page, then stop everything that writes.
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
"${compose[@]}" stop postgres

# 4. WAL into a restore directory inside the spool, which the postgres
# container already mounts as /wal-spool.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
restore_wal=$state/wal-spool/restore-$stamp
install -d -m 0700 "$restore_wal"
for file in "$wal_dir"/*.age; do
  [[ -e "$file" ]] || continue
  name=$(basename "$file" .age)
  age --decrypt --identity "$identity" -o "$restore_wal/$name" "$file"
done
for file in "$state"/wal-spool/*; do
  # Only finished segments: a <segment>.tmp is still being copied by Postgres.
  [[ -f "$file" && "$file" != *.tmp ]] || continue
  name=$(basename "$file")
  [[ -e "$restore_wal/$name" ]] || cp "$file" "$restore_wal/$name"
done
# Postgres in the container is uid 70 and must read the segments.
[[ -n "$sandboxed" ]] || chown -R 70:70 "$restore_wal"

data=$state/postgres
aside=$state/postgres.pre-restore-$stamp
mv "$data" "$aside"
base_tar=$state/wal-spool/base-$stamp.tar
age --decrypt --identity "$identity" -o "$base_tar" "$set_dir/base.tar.age"
bash "$root/deploy/pitr-prepare.sh" "$base_tar" "$data" "$target" "/wal-spool/restore-$stamp"
rm -f "$base_tar"
"${compose[@]}" up --detach postgres
# Replay ends in one of two ways: promoted (pg_is_in_recovery() = f), or
# Postgres exits because the WAL stops before the target.
replayed=""
for _ in $(seq 1 3600); do
  if [[ "$("${compose[@]}" exec -T postgres psql -U postgres -Atqc 'select pg_is_in_recovery()' 2> /dev/null || true)" == f ]]; then
    replayed=1
    break
  fi
  if "${compose[@]}" logs --no-log-prefix postgres 2>&1 | grep -q "recovery ended before configured recovery target was reached"; then
    break
  fi
  sleep 1
done
if [[ -z "$replayed" ]]; then
  trap - ERR
  "${compose[@]}" stop postgres
  mv "$data" "$state/postgres.failed-pitr-$stamp"
  mv "$aside" "$data"
  "${compose[@]}" up --detach --wait postgres
  echo "PITR_WAL_SHORT: the archived WAL does not reach $target, so the database was put back as it was (the failed attempt is $state/postgres.failed-pitr-$stamp). Every service but Postgres is stopped; fetch the missing WAL and run this again, or restore $pre." >&2
  exit 69
fi
rm -rf "$restore_wal"
echo "PITR_REPLAYED $target (previous data $aside)"

# 5. Redis and the skills tree from the set, the worker's state aside.
"${compose[@]}" up --detach --wait redis
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
mv "$state/skills" "$state/skills.pre-restore-$stamp"
age --decrypt --identity "$identity" "$set_dir/files.tar.gz.age" |
  tar -xzf - --same-owner -C "$state" skills
mv "$state/worker" "$state/worker.pre-restore-$stamp"
install -d -o "$(stat -c %u "$state/worker.pre-restore-$stamp")" -g "$(stat -c %g "$state/worker.pre-restore-$stamp")" \
  -m "$(stat -c %a "$state/worker.pre-restore-$stamp")" "$state/worker"

# 6. Schema, then the fence: everything after the target is uncertain.
bash "$runtime" migrate "$active_sha"
fence=$(bash "$runtime" restore-fence "$active_sha" --backup-name "$set_name" --cutoff-at "$target")
echo "RESTORE_FENCE $fence"

# 7. The api only, then the proxy.
bash "$runtime" api-start "$active_slot" "$active_sha"
render_proxy "{\"slot\":\"$active_slot\",\"sha\":\"$active_sha\"}"
trap - ERR
printf 'RESTORE_COMPLETED_HELD %s to %s from %s (pre-restore backup %s). Dispatch, the worker and Inngest are stopped; an installation administrator must re-enable the installation.\n' "$active_slot" "$target" "$set_name" "$pre"
