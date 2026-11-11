#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 ]] || exit 77
snapshot=${1:?completed backup directory required}
identity=${2:?operator age identity file required}
[[ -d "$snapshot" && -f "$identity" ]] || exit 64
umask 077
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
