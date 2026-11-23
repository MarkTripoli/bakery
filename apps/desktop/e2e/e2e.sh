#!/usr/bin/env bash
# The desktop app's end-to-end run, from the host: a real Bakery server on a throwaway Postgres,
# then the Linux container that runs the app against it (scenario.py).
#
# Follows the agx64 DB rules: the build happens before the slot is taken, a stack-gate slot is waited
# for outside the lock, the db-slot lock is taken through slot-fair, one fresh container is used and
# removed with its volume on every exit. Nothing started here outlives the run or inherits the lock.
set -uo pipefail
ORIG_ARGS=("$@")   # before any shift: slot-fair re-runs this script with them
umask 022
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(realpath "$HERE/..")"
REPO="$(realpath "$APP/../..")"
CACHE="${SPIKE_CACHE:-$HOME/Development/bakery-wt/_spike-77-cache}"
OUT="${E2E_OUT:-$HOME/Development/bakery-wt/_desktop-e2e/e2e-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${DESKTOP_IMAGE:-bakery-spike77-linux}"
GATE=/home/marktripoli/Development/bakery-rig/bin/stack-gate
STACK="bakery-dev-desktop-e2e"
SERVER_PID=""
mkdir -p "$OUT"; chmod 777 "$OUT"

# The live server's pid is kept in a file: the stop and start requests run in a background subshell,
# which cannot update this shell's variables, and a stale variable left a server running once.
stop_server() {
  SERVER_PID="$(cat "$OUT/server.pid" 2>/dev/null)"
  [ -n "$SERVER_PID" ] || return 0
  kill -- -"$SERVER_PID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -"$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- -"$SERVER_PID" 2>/dev/null
  SERVER_PID=""; rm -f "$OUT/server.pid"; sleep 1
}
WATCH_PID=""
cleanup() {
  trap - EXIT INT TERM HUP
  touch "$OUT/done"
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null
  stop_server
  [ -f "$OUT/web.pid" ] && kill -- -"$(cat "$OUT/web.pid")" 2>/dev/null
  docker rm -fv "$STACK-pg" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# Build outside the slot: the compile must not hold the shared lock.
if [ -z "${SLOT_FAIR_HELD:-}" ]; then
  (cd "$REPO" && deno run --allow-read --allow-write apps/desktop/scripts/sync-foundations.ts) || exit 1
  docker run --rm -e CARGO_TARGET_DIR=/cache/target-desktop -v "$APP:/app" \
    -v "$CACHE/target-desktop:/cache/target-desktop" -v "$CACHE/registry:/opt/rust/cargo/registry" \
    -v "$CACHE/git:/opt/rust/cargo/git" -w /app "$IMAGE" cargo build -p bakery-desktop --offline 2>&1 | tail -1
fi

if ! $GATE >/dev/null 2>&1; then echo "blocked: no stack slot"; exit 3; fi
# slot-fair: the FIFO ticket queue in front of the db-slot lock (rig rule). Re-run this script under
# it once; the lock is held for the whole run and released on exit.
if [ -z "${SLOT_FAIR_HELD:-}" ]; then
  exec /home/marktripoli/Development/bakery-wt/_qa/slot-fair env SLOT_FAIR_HELD=1 "$0" "${ORIG_ARGS[@]}"
fi
if ! $GATE >/dev/null 2>&1; then echo "blocked: no stack slot"; exit 3; fi
echo "gate ok, load $(cut -d' ' -f1 /proc/loadavg)"

read PG SERVER < <(node -e 'const n=require("net");const a=n.createServer(),b=n.createServer();a.listen(0,"127.0.0.1",()=>b.listen(0,"127.0.0.1",()=>{console.log(a.address().port+" "+b.address().port);a.close();b.close()}))')
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
  (cd apps/server && exec setsid bash scripts/run-main.sh >> "$OUT/server.log" 2>&1 9>&-) &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$OUT/server.pid"
  for i in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$SERVER/health/ready" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server did not become ready"; return 1
}
start_server || exit 4

# With E2E_WEB=1 the built web app is served on a port of its own, proxying the API to the server, so
# the app's window can load real web pages from one origin (the connected server for the web phases).
WEB=""
if [ -n "${E2E_WEB:-}" ]; then
  WEBP=$(node -e 'const n=require("net");const a=n.createServer();a.listen(0,"127.0.0.1",()=>{console.log(a.address().port);a.close()})')
  (cd "$REPO/apps/web" && BAKERY_ENV=test pnpm build >"$OUT/web-build.log" 2>&1) || { echo "web build failed"; exit 5; }
  (cd "$REPO/apps/web" && exec setsid env BAKERY_ENV=test BAKERY_WEB_HOST=127.0.0.1 BAKERY_WEB_PORT=$WEBP \
    BAKERY_SERVER_HOST=127.0.0.1 BAKERY_SERVER_PORT=$SERVER pnpm exec vite preview >>"$OUT/web.log" 2>&1 9>&-) &
  echo $! > "$OUT/web.pid"
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$WEBP/" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$WEBP/health/ready" >/dev/null 2>&1 || { echo "web preview did not become ready"; exit 6; }
  WEB="http://127.0.0.1:$WEBP"
fi

EMAIL="e2e-admin@example.test"; PASSWORD="E2e-Admin-Passw0rd-1"
WEB_AUTH_SEED_PASSWORD="$PASSWORD" deno run --allow-env --allow-net --allow-read \
  tests/helpers/web-auth-seed.ts "$EMAIL" 2>&1 | tail -1 | cut -c1-100

# The scenario asks the host to stop the server and to start it again.
( while [ ! -f "$OUT/done" ]; do
    if [ -f "$OUT/flag-stop" ]; then
      rm -f "$OUT/flag-stop"; stop_server; touch "$OUT/flag-stop-done"
    fi
    if [ -f "$OUT/flag-start" ]; then
      rm -f "$OUT/flag-start"; start_server; touch "$OUT/flag-start-done"
    fi
    sleep 1
  done ) 9>&- &
WATCH_PID=$!

docker run --rm --network host -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$APP:/app:ro" -v "$OUT:/out" -v "$CACHE/target-desktop:/cache/target-desktop:ro" \
  -e HOME=/tmp/e2ehome -e OUT=/out -e BAKERY_SERVER="http://127.0.0.1:$SERVER" -e BAKERY_WEB="$WEB" -e E2E_SHOTS="${E2E_SHOTS:-}" -e E2E_PHASES="${E2E_PHASES:-}" -e E2E_SHOT_ONLY="${E2E_SHOT_ONLY:-}" -e E2E_VIDEO="${E2E_VIDEO:-}" \
  -e SEED_EMAIL="$EMAIL" -e SEED_PASSWORD="$PASSWORD" \
  "$IMAGE" bash /app/e2e/scenario.sh 2>&1 | tee "$OUT/scenario.log"
RC=${PIPESTATUS[0]}
echo "end-to-end exit: $RC; output: $OUT"
exit $RC
