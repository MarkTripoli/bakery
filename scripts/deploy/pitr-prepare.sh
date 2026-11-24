#!/usr/bin/env bash
set -euo pipefail
# Prepares a Postgres data directory to replay to one minute (issue #80, P2).
#
#   pitr-prepare.sh <base backup tar> <empty data directory> <target time> <WAL directory in the container>
#
# The base backup is the decrypted `pg_basebackup -F tar -X none` output that
# backup.sh keeps as base.tar.age. The data directory is filled from it, then
# told to recover: every archived WAL segment is read from the WAL directory
# (as the container sees it) and replay stops at the target time, inclusive,
# and the server is promoted there. The script writes files only; the caller
# starts Postgres and waits for recovery to end. It runs as root (on the host,
# or in the postgres image) so the files belong to the postgres user (uid 70).
#
# Exit 0: prepared. 64: bad arguments. 65: the data directory is not empty.
# 66: the target time is not an ISO-8601 UTC instant.
base=${1:-}
data=${2:-}
target=${3:-}
wal=${4:-}
if [[ -z "$base" || -z "$data" || -z "$target" || -z "$wal" || ! -f "$base" ]]; then
  echo "usage: pitr-prepare.sh <base backup tar> <empty data directory> <target time> <WAL directory in the container>" >&2
  exit 64
fi
if [[ ! "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z$ ]]; then
  echo "PITR_TARGET_INVALID: $target is not a UTC instant like 2026-11-21T10:15:00Z" >&2
  exit 66
fi
# recovery_target_time refuses the ISO "T...Z" spelling; give it "date time+00".
pg_target="${target/T/ }"
pg_target="${pg_target%Z}+00"
install -d -m 0700 "$data"
if [[ -n "$(ls -A "$data")" ]]; then
  echo "PITR_DATA_NOT_EMPTY: $data must be empty; move the current data aside first" >&2
  exit 65
fi
tar -xf "$base" -C "$data"
# pg_wal is not in a -X none backup; recovery fetches every segment it needs.
install -d -m 0700 "$data/pg_wal"
{
  echo "# Point-in-time restore (pitr-prepare.sh). Removed by Postgres on promote"
  echo "# only for recovery.signal; these lines are inert once recovery is over."
  echo "restore_command = 'cp $wal/%f %p'"
  echo "recovery_target_time = '$pg_target'"
  echo "recovery_target_inclusive = on"
  echo "recovery_target_action = 'promote'"
  echo "recovery_target_timeline = 'latest'"
} >> "$data/postgresql.auto.conf"
touch "$data/recovery.signal"
chown -R 70:70 "$data"
chmod 0700 "$data"
echo "PITR_PREPARED $target"
