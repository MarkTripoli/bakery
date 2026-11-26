# Move a PostgreSQL 16 data directory to 18

Bakery runs `postgres:18-alpine`. A data directory written by 16 does not start under 18: the server stops with "database files are incompatible with server". Move the data with a dump and a restore. This also avoids the `pg_upgrade` checksum mismatch, because 18 turns data checksums on by default and a 16 cluster usually has them off.

Expect a short outage: nothing may write while the dump runs.

## 1. Stop every writer and take the dump with 16

Nothing may write after the dump starts, or that write is lost. Stop every service that writes, keep only Postgres up on the old image, then check that no other session is left.

On a production host the API, the worker and the dispatcher are systemd units and Inngest is a compose service. Run every production command in this runbook as root (`sudo -i`). Stop them the way `restore.sh` does, and note the live slot and release first so step 4 can start them again:

```bash
state=/var/lib/bakery/deploy/state.json
slot=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).active.slot' "$state")
sha=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).active.sha' "$state")
bash /opt/bakery/deploy/runtime.sh api-stop blue
bash /opt/bakery/deploy/runtime.sh api-stop green
bash /opt/bakery/deploy/runtime.sh background stop
bash /opt/bakery/deploy/runtime.sh inngest-stop
systemctl is-active bakery-api@blue bakery-api@green bakery-worker bakery-dispatch
compose=(docker compose --env-file /etc/bakery/infra.env -f /opt/bakery/production/compose.yaml)
```

`systemctl is-active` must print `inactive` four times.

On a local stack every service other than Postgres writes (server, worker, Inngest, the probe runner and the purger), so stop all of them:

```bash
compose=(docker compose -p "$PROJECT")
writers=$("${compose[@]}" ps --services | grep -vx postgres || true)
[ -z "$writers" ] || "${compose[@]}" stop $writers
```

Both: nothing but this session may be connected, then dump every database and role with the 16 tools inside the running container:

```bash
sessions=$("${compose[@]}" exec -T postgres psql -U postgres -Atc \
  "select count(*) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()")
if [ "$sessions" != 0 ]; then
  echo "writers still connected: $sessions; stop them and run this block again"
else
  "${compose[@]}" exec -T postgres pg_dumpall -U postgres --globals-only > globals-16.sql
  for db in $("${compose[@]}" exec -T postgres psql -U postgres -Atc \
    "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1"); do
    "${compose[@]}" exec -T postgres pg_dump -U postgres -Fc "$db" > "db-16-$db.dump"
    test -s "db-16-$db.dump" || echo "empty dump: $db"
  done
fi
"${compose[@]}" exec -T postgres psql -U postgres -Atc \
  "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1" > sizes-16.txt
```

The dump runs only when no other session is connected; otherwise a writer is still running, so stop it and run the block again.

Dump with the 16 tools inside the running container: `pg_dump` refuses a server newer than itself. Each database is dumped on its own so the restore never drops the `postgres` database, which other connections (health checks included) open while the restore runs.

## 2. Keep the old directory and start 18 on an empty one

```bash
"${compose[@]}" down
mv /var/lib/bakery/postgres /var/lib/bakery/postgres-16
install -d -m 0700 /var/lib/bakery/postgres
```

For a local stack the data lives in the `<project>_postgres-data` volume: rename it with `docker volume create` plus a copy, or keep the dump as the only copy and remove the volume.

Pull the new compose file (it pins `postgres:18-alpine` and sets `PGDATA=/var/lib/postgresql/data`, so the mount path does not change) and start only Postgres:

```bash
"${compose[@]}" up -d postgres
```

The init scripts create the roles on the empty cluster; the dump then brings back the data and the role passwords.

## 3. Restore and check

```bash
"${compose[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=0 -f - < globals-16.sql > restore.log 2>&1
for dump in db-16-*.dump; do
  "${compose[@]}" exec -T postgres pg_restore -U postgres --clean --if-exists --create -d postgres < "$dump" >> restore.log 2>&1 || true
done
grep -c ERROR restore.log
"${compose[@]}" exec -T postgres psql -U postgres -Atc "show server_version"
"${compose[@]}" exec -T postgres psql -U postgres -Atc \
  "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1"
```

One error is expected and harmless: `role "postgres" already exists`, because the globals recreate the superuser you are connected as. Roles the init scripts made can also report `already exists`. Anything else in `restore.log` needs a look before you go on. The version must start with 18. Every database from `sizes-16.txt` must be there; sizes differ a little after a restore.

## 4. Start the writers again

Run the migrations, which must find nothing to do, then start what step 1 stopped.

On a production host:

```bash
bash /opt/bakery/deploy/runtime.sh migrate "$sha"
bash /opt/bakery/deploy/runtime.sh services
bash /opt/bakery/deploy/runtime.sh api-start "$slot" "$sha"
bash /opt/bakery/deploy/runtime.sh background "$sha"
bash /opt/bakery/deploy/runtime.sh background-check
```

On a local stack:

```bash
pnpm migrate
"${compose[@]}" up -d
```

## 5. Afterwards

Keep `/var/lib/bakery/postgres-16`, `globals-16.sql` and the `db-16-*.dump` files until a backup on 18 has passed its restore check (`scripts/deploy/restore-check.sh`). Take a new base backup straight away if "Restore to any minute" is on: WAL from 16 cannot replay onto 18.

To go back, stop the stack, move `postgres-16` back into place and start the previous compose file, which pins 16.
