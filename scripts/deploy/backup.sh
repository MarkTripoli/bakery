#!/usr/bin/env bash
set -euo pipefail
# One encrypted, verified backup set (issue #64 slice A).
#
# A set is complete only when every state store Bakery declares is in it: see
# scripts/deploy/backup-runner/manifest.ts for the list, the manifest format and
# the check. Each store is captured on its own, so one failure does not hide
# another; any required store that is not captured stops the script before the
# set is moved into place or becomes `latest`, with BACKUP_INCOMPLETE on stderr
# and exit 70. The secrets key itself is never copied: its id is recorded and
# the operator keeps the key.
#
# BAKERY_BACKUP_SANDBOX is for tests only: it roots every path under a scratch
# directory and skips the root check, and it is refused unless BAKERY_ENV=test
# (before anything is touched). The systemd units never set it.
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
umask 077
source "$etc/backup.env"
test -n "${BAKERY_BACKUP_RECIPIENT:?required}"
compose=(docker compose --env-file "$etc/infra.env" -f "$root/production/compose.yaml")
directory=$state/backups
install -d -m 0700 "$directory"
attempt=$(mktemp -d "$directory/.pending-XXXXXXXX")
trap 'rm -rf "$attempt"' EXIT
# The cutoff: everything the set holds was read at or after this moment.
started=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

encrypt() { age --encrypt --recipient "$BAKERY_BACKUP_RECIPIENT"; }

failed=()
# capture <store id> <function> [args]: runs one capture and records a failure
# (instead of stopping) so every missing store is reported together.
capture() {
  local id=$1
  shift
  if ! ("$@"); then
    failed+=(--failed "$id=the capture failed")
  fi
}

# Each capture runs where `set -e` is off (it is tested by `capture`), so every
# step ends in `|| return 1`: a pipeline that fails halfway must not pass just
# because it left a non-empty file behind.
dump_database() {
  "${compose[@]}" exec -T postgres pg_dump -U postgres --format=custom "$1" |
    encrypt > "$attempt/$1.dump.age" || return 1
  test -s "$attempt/$1.dump.age"
}

# Redis: a SAVE makes a consistent RDB snapshot, then it is read out of the
# container. The snapshot must start with the RDB magic before it is kept.
capture_redis() {
  "${compose[@]}" exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE' |
    grep -qx OK || return 1
  local magic
  magic=$("${compose[@]}" exec -T redis sh -c 'head -c 5 /data/dump.rdb') || return 1
  [[ "$magic" == REDIS ]] || return 1
  "${compose[@]}" exec -T redis cat /data/dump.rdb |
    encrypt > "$attempt/redis.rdb.age" || return 1
  test -s "$attempt/redis.rdb.age"
}

capture_files() {
  tar -czf - --exclude='.bakery-tmp-*' -C "$state" skills worker |
    encrypt > "$attempt/files.tar.gz.age" || return 1
  test -s "$attempt/files.tar.gz.age"
}

capture_release() {
  cp "$state/deploy/state.json" "$attempt/release.json" || return 1
  test -s "$attempt/release.json"
}

# Every object the database refers to, by key and SHA-256, so a restore can read
# each one back. The bytes of an object store are not copied. The list holds
# object keys, so it is encrypted like the dumps.
references_sql="select jsonb_build_object(
  'format', 1,
  'storageBackend', coalesce((select backend from bakery.skill_storage_settings limit 1), 'filesystem'),
  'skillFiles', coalesce((select jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'skillVersionId', skill_version_id,
    'objectKey', object_key, 'sizeBytes', size_bytes, 'sha256', sha256) order by id)
    from bakery.skill_files), '[]'::jsonb),
  'blobs', coalesce((select jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'sha256', sha256, 'sizeBytes', size_bytes,
    'objectKey', 'organizations/' || organization_id || '/blobs/sha256/' || sha256) order by id)
    from bakery.blobs), '[]'::jsonb))"
counts_sql="select (select count(*) from bakery.skill_files) || ' ' || (select count(*) from bakery.blobs)"
skill_files=0
blobs=0
capture_references() {
  "${compose[@]}" exec -T postgres psql -U postgres -d bakery -Atq -v ON_ERROR_STOP=1 \
    -c "$references_sql" | encrypt > "$attempt/references.json.age" || return 1
  test -s "$attempt/references.json.age"
}
read_reference_counts() {
  local counts
  counts=$("${compose[@]}" exec -T postgres psql -U postgres -d bakery -Atq -v ON_ERROR_STOP=1 -c "$counts_sql") || return 1
  [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]] || return 1
  skill_files=${BASH_REMATCH[1]}
  blobs=${BASH_REMATCH[2]}
}

capture postgres-bakery dump_database bakery
capture postgres-inngest dump_database inngest
capture redis capture_redis
capture files capture_files
capture release-journal capture_release
capture object-references capture_references
# The counts are read in this shell (a failed capture above does not stop them).
if ! read_reference_counts; then
  failed+=(--failed "object-references=the reference counts could not be read")
fi

# The secrets key: only its id is recorded, never the key. A host with neither
# id nor file configured saves no secrets, so it is an explicit exclusion; a
# half-configured key is a failure.
infra_value() {
  sed -n "s/^$1=//p" "$etc/infra.env" | tail -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
key_id=$(infra_value BAKERY_SECRETS_KEY_ID || true)
key_file=$(infra_value BAKERY_SECRETS_KEY_FILE || true)
if [[ -z "$key_id" && -z "$key_file" ]]; then
  key_args=(--no-key)
elif [[ -n "$key_id" && -n "$key_file" && -s "$key_file" ]]; then
  # The builder reads the key file once, only to fingerprint it; the key is
  # never copied, logged or stored.
  key_args=(--key-id "$key_id" --key-file "$key_file")
else
  key_args=(--key-failed "the secrets key id or its key file is missing")
fi

# The manifest and SHA256SUMS are written by the checked module, last, and the
# set is verified again before it is moved into place: an incomplete set exits
# 70 here, so it never becomes a backup and never updates `latest`.
export DENO_DIR=${DENO_DIR:-$state/backup-runner/deno}
manifest=("$root/background/scripts/deploy/backup-manifest.ts")

# Never stop taking backups: when Deno or the release checkout is missing, the
# dumps are already encrypted and in the set, so the set is kept (under its
# normal name, not deleted) with a marker saying it is incomplete and why, and
# the script exits 70. It never becomes `latest`, restore-check.sh and the
# verifier refuse it, and the runner reports `incomplete_set`.
keep_incomplete_set() {
  local cause=manifest_builder_missing
  local detail="deno or $root/background/scripts/deploy/backup-manifest.ts is not available, so the set has no manifest and is not a complete backup. Install or enable a release so $root/background exists, then take another backup."
  local stores="" i id
  for ((i = 1; i < ${#failed[@]}; i += 2)); do
    id=${failed[i]%%=*}
    stores+="${stores:+,}\"$id\""
  done
  printf '{"format":1,"complete":false,"cause":"%s","detail":"%s","failedStores":[%s],"startedAt":"%s"}\n' \
    "$cause" "$detail" "$stores" "$started" > "$attempt/INCOMPLETE.json"
  (cd "$attempt" && sha256sum ./* > .SHA256SUMS.tmp && mv .SHA256SUMS.tmp SHA256SUMS)
  sync -f "$attempt"
  local kept
  kept="$directory/$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
  mv "$attempt" "$kept"
  sync -f "$directory"
  echo "BACKUP_INCOMPLETE $cause: $detail (set kept as ${kept##*/}; it is not the latest backup)" >&2
  exit 70
}
if ! command -v deno > /dev/null 2>&1 || [[ ! -f "${manifest[0]}" ]]; then
  keep_incomplete_set
fi

# The key file is the only file outside the set the builder may read.
build_read=$attempt
if [[ -n "$key_file" ]]; then build_read="$attempt,$key_file"; fi
# The database cutoff the runner took while the installation was quiet, as one
# JSON value (non-secret). Without it (the daily timer, a manual run) the
# manifest records the host clock at the start of this script, marked weaker.
cutoff_args=()
if [[ -n "${BAKERY_BACKUP_CUTOFF:-}" ]]; then
  cutoff_args=(--cutoff-json "$BAKERY_BACKUP_CUTOFF")
fi
build_run=(deno run --no-prompt "--allow-read=$build_read" "--allow-write=$attempt")
deno_run=(deno run --no-prompt "--allow-read=$attempt" "--allow-write=$attempt")
"${build_run[@]}" "${manifest[@]}" build "$attempt" --started "$started" \
  "${key_args[@]}" --skill-files "$skill_files" --blobs "$blobs" \
  ${cutoff_args[@]+"${cutoff_args[@]}"} \
  ${failed[@]+"${failed[@]}"}
"${deno_run[@]}" "${manifest[@]}" verify "$attempt" > /dev/null

sync -f "$attempt"
completed="$directory/$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
mv "$attempt" "$completed"
printf '%s\n' "$completed" > "$directory/latest.next"
mv -f "$directory/latest.next" "$directory/latest"
sync -f "$directory"
printf 'BACKUP_COMPLETED %s\n' "${completed##*/}"
