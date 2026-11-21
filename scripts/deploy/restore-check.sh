#!/usr/bin/env bash
set -euo pipefail
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
else
  [[ "$(id -u)" == 0 ]] || exit 77
  root=/opt/bakery
  state=/var/lib/bakery
fi
snapshot=${1:?completed backup directory required}
identity=${2:?operator age identity file required}
legacy=${3:-}
[[ -d "$snapshot" && -f "$identity" ]] || exit 64
[[ -z "$legacy" || "$legacy" == --allow-legacy ]] || exit 64
umask 077
# The set must be complete before anything is restored: the manifest says every
# declared state store is in it and every file matches what was recorded. A set
# from before manifests has none, so it fails closed unless --allow-legacy says
# the operator knows it is an old set (its old checks below still run).
export DENO_DIR=${DENO_DIR:-$state/backup-runner/deno}
# A fresh disaster-recovery host may have neither Deno nor a release checkout.
# Say so and exit 70 (the documented "not a verified set" code) rather than die
# with 127 from a missing command.
verifier="$root/background/scripts/deploy/backup-manifest.ts"
missing=""
command -v deno > /dev/null 2>&1 || missing="deno (install Deno and put it on the PATH)"
[[ -f "$verifier" ]] || missing+="${missing:+; }the release checkout $root/background (install or enable a release)"
if [[ -n "$missing" ]]; then
  echo "restore-check.sh cannot verify the set; missing: $missing. Nothing was restored." >&2
  exit 70
fi
deno run --no-prompt "--allow-read=$snapshot" \
  "$verifier" verify "$snapshot" ${legacy:+"$legacy"}
temporary=$(mktemp -d /var/tmp/bakery-restore-check-XXXXXXXX)
container="bakery-restore-check-$(cat /proc/sys/kernel/random/uuid)"
cleanup() {
  docker rm --force "$container" > /dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT
(cd "$snapshot" && sha256sum --check --status SHA256SUMS)
docker run --detach --name "$container" --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --mount "type=bind,source=$temporary,target=/var/lib/postgresql/data" \
  postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 > /dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres > /dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || exit 1
docker exec "$container" psql -U postgres -v ON_ERROR_STOP=1 -c 'create role bakery_owner; create role bakery_app; create role inngest;' > /dev/null
for database in bakery inngest; do
  docker exec "$container" createdb -U postgres "$database"
  age --decrypt --identity "$identity" "$snapshot/$database.dump.age" |
    docker exec --interactive "$container" pg_restore -U postgres --dbname "$database" --no-owner --no-acl --exit-on-error
  count=$(docker exec "$container" psql -U postgres -d "$database" -Atqc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
  [[ "$count" =~ ^[1-9][0-9]*$ ]] || exit 1
done
install -d -m 0700 "$temporary/files"
age --decrypt --identity "$identity" "$snapshot/files.tar.gz.age" |
  python3 -c 'import sys,tarfile; archive=tarfile.open(fileobj=sys.stdin.buffer,mode="r|gz");archive.extractall(sys.argv[1],filter="data")' "$temporary/files"
test -d "$temporary/files/skills"
test -d "$temporary/files/worker"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));if(s.format!==1||typeof s.migrations!=="object")throw Error("BACKUP_RELEASE_JOURNAL_INVALID")' "$snapshot/release.json"
printf '%s\n' RESTORE_CHECK_PASSED_ISOLATED_NO_PRODUCTION_WRITES
