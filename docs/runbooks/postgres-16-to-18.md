# Move a PostgreSQL 16 data directory to 18

Bakery runs `postgres:18-alpine`. A data directory written by 16 does not start under 18: the server stops with "database files are incompatible with server". Move the data with a dump and a restore. This also avoids the `pg_upgrade` checksum mismatch, because 18 turns data checksums on by default and a 16 cluster usually has them off.

Expect a short outage: nothing may write while the dump runs.

## 1. Stop writers and take the dump with 16

Stop the server, worker and dispatcher, keeping only Postgres up on the old image. Then dump every database and role with the 16 tools inside the running container:

```bash
docker compose -p "$PROJECT" stop server worker dispatch inngest
docker compose -p "$PROJECT" exec -T postgres pg_dumpall -U postgres --clean --if-exists > bakery-16.sql
test -s bakery-16.sql
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -Atc \
  "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1" > sizes-16.txt
```

`pg_dumpall` from 16 is right here: `pg_dump` refuses a server newer than itself, so always dump with the tools of the server that holds the data.

## 2. Keep the old directory and start 18 on an empty one

```bash
docker compose -p "$PROJECT" down
sudo mv /var/lib/bakery/postgres /var/lib/bakery/postgres-16
sudo install -d -m 0700 /var/lib/bakery/postgres
```

For a local stack the data lives in the `<project>_postgres-data` volume: rename it with `docker volume create` plus a copy, or keep the dump as the only copy and remove the volume.

Pull the new compose file (it pins `postgres:18-alpine` and sets `PGDATA=/var/lib/postgresql/data`, so the mount path does not change) and start only Postgres:

```bash
docker compose -p "$PROJECT" up -d postgres
```

The init scripts create the roles on the empty cluster; the dump then brings back the data and the role passwords.

## 3. Restore and check

```bash
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -v ON_ERROR_STOP=0 -f - < bakery-16.sql > restore.log 2>&1
grep -c ERROR restore.log
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -Atc "show server_version"
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -Atc \
  "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1"
```

Two errors are expected and harmless: `current user cannot be dropped` and `role "postgres" already exists`, because the dump tries to recreate the superuser you are connected as. Roles the init scripts made can also report `already exists`. The version must start with 18. Every database from `sizes-16.txt` must be there; sizes differ a little after a restore.

Then run the migrations, which must find nothing to do, and start the rest:

```bash
pnpm migrate
docker compose -p "$PROJECT" up -d
```

## 4. Afterwards

Keep `/var/lib/bakery/postgres-16` and `bakery-16.sql` until a backup on 18 has passed its restore check (`scripts/deploy/restore-check.sh`). Take a new base backup straight away if "Restore to any minute" is on: WAL from 16 cannot replay onto 18.

To go back, stop the stack, move `postgres-16` back into place and start the previous compose file, which pins 16.
