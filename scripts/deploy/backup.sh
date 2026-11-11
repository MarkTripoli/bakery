#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 ]] || exit 77
umask 077
source /etc/bakery/backup.env
test -n "${BAKERY_BACKUP_RECIPIENT:?required}"
compose=(docker compose --env-file /etc/bakery/infra.env -f /opt/bakery/production/compose.yaml)
directory=/var/lib/bakery/backups
install -d -m 0700 "$directory"
attempt=$(mktemp -d "$directory/.pending-XXXXXXXX")
trap 'rm -rf "$attempt"' EXIT
for database in bakery inngest; do
  "${compose[@]}" exec -T postgres pg_dump -U postgres --format=custom "$database" |
    age --encrypt --recipient "$BAKERY_BACKUP_RECIPIENT" > "$attempt/$database.dump.age"
  test -s "$attempt/$database.dump.age"
done
tar -czf - --exclude='.bakery-tmp-*' -C /var/lib/bakery skills worker |
  age --encrypt --recipient "$BAKERY_BACKUP_RECIPIENT" > "$attempt/files.tar.gz.age"
cp /var/lib/bakery/deploy/state.json "$attempt/release.json"
(cd "$attempt" && sha256sum ./*.age > SHA256SUMS)
sync -f "$attempt"
completed="$directory/$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
mv "$attempt" "$completed"
printf '%s\n' "$completed" > "$directory/latest.next"
mv -f "$directory/latest.next" "$directory/latest"
sync -f "$directory"
printf 'BACKUP_COMPLETED %s\n' "${completed##*/}"
