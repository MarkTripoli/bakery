#!/usr/bin/env bash
# Host side of the #77 desktop compatibility spike: a real Bakery server on a throwaway
# Postgres, then the Linux container that runs the Tauri app against it.
#
# Follows the agx64 DB rules: wait for a stack-gate slot outside the lock, take the db-slot
# lock, re-check, one fresh container, removed with its volume on every exit.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
OUT="${SPIKE_OUT:-$HOME/Development/bakery-wt/_spike-77-out/$(date +%Y%m%d-%H%M%S)}"
GATE=/home/marktripoli/Development/bakery-rig/bin/stack-gate
LOCK=/home/marktripoli/Development/bakery-wt/_qa/db-slot.lock
STACK="bakery-dev-spike77"
SERVER_PID=""
mkdir -p "$OUT"; chmod 777 "$OUT"

stop_server() { [ -n "$SERVER_PID" ] && kill -- -"$SERVER_PID" 2>/dev/null; SERVER_PID=""; sleep 1; }
cleanup() { touch "$OUT/done"; stop_server; docker rm -fv "$STACK-pg" >/dev/null 2>&1; }
trap cleanup EXIT

if ! $GATE >/dev/null 2>&1; then echo "blocked: no stack slot"; exit 3; fi
exec 9>"$LOCK"; flock 9
if ! $GATE >/dev/null 2>&1; then echo "blocked: no stack slot"; exit 3; fi
echo "gate ok, load $(cut -d' ' -f1 /proc/loadavg)"

read PG SERVER < <(node -e 'const n=require("net");const a=n.createServer(),b=n.createServer();a.listen(0,"127.0.0.1",()=>b.listen(0,"127.0.0.1",()=>{console.log(a.address().port,b.address().port);a.close();b.close()}))')
docker run -d --name "$STACK-pg" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=bakery-ci-postgres \
  -p "127.0.0.1:$PG:5432" postgres:16-alpine >/dev/null
until docker exec "$STACK-pg" psql -U postgres -Atqc 'select 1' >/dev/null 2>&1; do sleep 1; done
sleep 4
for attempt in 1 2 3 4 5 6 7 8; do
  if docker exec "$STACK-pg" psql -U postgres -Atq \
    -c "CREATE ROLE bakery LOGIN SUPERUSER PASSWORD 'bakery-ci-bakery'" \
    -c "CREATE ROLE bakery_app LOGIN PASSWORD 'bakery-ci-app'" \
    -c "CREATE DATABASE bakery OWNER bakery" \
    -c "GRANT CONNECT ON DATABASE bakery TO bakery_app" >/dev/null 2>&1; then break; fi
  sleep 2
done

cd "$REPO"
export BAKERY_ENV=test BAKERY_SERVER_HOST=127.0.0.1 BAKERY_SERVER_PORT=$SERVER BAKERY_WEB_PORT=$SERVER
export BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:$SERVER
export BETTER_AUTH_SECRET=$(head -c 48 /dev/zero | tr '\0' x)
export DATABASE_URL=postgres://bakery:bakery-ci-bakery@127.0.0.1:$PG/bakery
export BAKERY_APP_DATABASE_URL=postgres://bakery_app:bakery-ci-app@127.0.0.1:$PG/bakery
pnpm migrate 2>&1 | tail -1 | cut -c1-80

start_server() {
  (cd apps/server && exec setsid bash scripts/run-main.sh >> "$OUT/server.log" 2>&1) &
  SERVER_PID=$!
  for i in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$SERVER/health/ready" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server did not become ready"; return 1
}
start_server || exit 4

EMAIL="spike-admin@example.test"; PASSWORD="Spike-Admin-Passw0rd-1"
WEB_AUTH_SEED_PASSWORD="$PASSWORD" deno run --allow-env --allow-net --allow-read \
  tests/helpers/web-auth-seed.ts "$EMAIL" 2>&1 | tail -1 | cut -c1-100

# The reconnect check asks the host to stop and restart the server.
( while [ ! -f "$OUT/done" ]; do
    if [ -f "$OUT/flag-restart" ]; then
      rm -f "$OUT/flag-restart"; stop_server; sleep 3; start_server; touch "$OUT/flag-restarted"
    fi
    sleep 1
  done ) &

docker run --rm --network host -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$HERE:/spike:ro" -v "$OUT:/out" -v "$CACHE/target:/cache/target:ro" \
  -e HOME=/tmp/spikehome -e OUT=/out -e BAKERY_SERVER="http://127.0.0.1:$SERVER" \
  -e SEED_EMAIL="$EMAIL" -e SEED_PASSWORD="$PASSWORD" \
  bakery-spike77-linux bash /spike/scenario.sh 2>&1 | tee "$OUT/scenario.log"
RC=${PIPESTATUS[0]}
echo "scenario exit: $RC; output: $OUT"
exit $RC
