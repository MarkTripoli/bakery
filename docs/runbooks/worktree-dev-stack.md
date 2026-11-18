# Worktree dev stack

How to bring up the API, a database and the web app from one git worktree, run a
browser spec against them, and tear everything down. CI does the same thing in
the `full / web shell browser` job of `.github/workflows/ci.yml`; this is that
recipe for a laptop or a shared host.

Use it when a check needs a real server: a Playwright case with
`BAKERY_REAL_API=1`, an auth flow, or a request the fixtures do not stub. On a
shared host keep to the host's limit on concurrent stacks, start only one, and
tear it down the moment you have the evidence.

## 1. A database

Any PostgreSQL 16. A throwaway container:

```bash
docker run -d --name bakery-dev-pg -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=bakery-ci-postgres -p 127.0.0.1:55441:5432 postgres:16-alpine
until docker exec bakery-dev-pg psql -U postgres -Atqc 'select 1' >/dev/null 2>&1; do sleep 1; done
docker exec bakery-dev-pg psql -U postgres -Atq \
  -c "CREATE ROLE bakery LOGIN PASSWORD 'bakery-ci-bakery'" \
  -c "CREATE ROLE bakery_app LOGIN PASSWORD 'bakery-ci-app'" \
  -c "CREATE DATABASE bakery OWNER bakery" \
  -c "GRANT CONNECT ON DATABASE bakery TO bakery_app"
```

## 2. Environment

Pick two free ports (never the fixed 5173 or 8000: another stack or a leaked dev
server may hold them):

```bash
read WEB SERVER < <(node -e 'const n=require("net");const a=n.createServer(),b=n.createServer();a.listen(0,"127.0.0.1",()=>b.listen(0,"127.0.0.1",()=>{console.log(a.address().port,b.address().port);a.close();b.close()}))')
export BAKERY_ENV=test BAKERY_SERVER_HOST=127.0.0.1
export BAKERY_WEB_PORT=$WEB BAKERY_SERVER_PORT=$SERVER
export BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:$WEB
export BETTER_AUTH_SECRET=$(head -c 48 /dev/zero | tr '\0' x)
export DATABASE_URL=postgres://bakery:bakery-ci-bakery@127.0.0.1:55441/bakery
export BAKERY_APP_DATABASE_URL=postgres://bakery_app:bakery-ci-app@127.0.0.1:55441/bakery
```

## 3. Migrate, start the API, seed the admin

From the worktree root (run `pnpm install --frozen-lockfile` first in a fresh worktree):

```bash
pnpm migrate
(cd apps/server && exec bash scripts/run-main.sh > /tmp/bakery-dev-server.log 2>&1) &
echo $! > /tmp/bakery-dev-server.pid
for i in $(seq 1 90); do curl -fsS "http://127.0.0.1:$SERVER/health/ready" >/dev/null && break; sleep 1; done
WEB_AUTH_SEED_PASSWORD=Browser-Admin-Passw0rd-1 deno run --allow-env --allow-net --allow-read \
  tests/helpers/web-auth-seed.ts browser-admin@example.test
```

## 4. Run a browser spec

Playwright starts the Vite dev server itself (`pnpm dev` on `$BAKERY_WEB_PORT`).
Chromium must be installed once (`pnpm exec playwright install chromium`).

```bash
BAKERY_REAL_API=1 pnpm --dir apps/web exec playwright test tests/shell.spec.ts \
  -g "/settings/security renders one h1" --project=desktop --reporter=line --workers=1
```

A failing case leaves `artifacts/ui-baseline/test-results/<case>/` with
`error-context.md` (the page snapshot) and `trace.zip`. The trace's network
files (`0-trace.network`, `1-trace.network`) list every request with its
status, which shows an endpoint a fixture forgot to stub (it reaches the real API
with no session cookie and answers 401).

## 5. Tear down

The API is started with `exec`, and `run-main.sh` itself execs `deno`, so the
pid in the file is the `deno` process. Backgrounding the whole `cd ... && bash ...`
list instead would record a subshell and leave `deno` running after the kill.

```bash
kill "$(cat /tmp/bakery-dev-server.pid)" 2>/dev/null
docker rm -fv bakery-dev-pg
```

Check that nothing of yours survives: `pgrep -af 'src/main.ts|vite --host'`. A
Vite dev server left on a fixed port by a killed run makes the next run's web
server fail to start.

## The full compose stack

For the worker, Inngest and Redis as well (recovery and end-to-end proofs), use
the compose file under a project name you own and remove it with its volumes:

```bash
docker compose --project-name bakery-<topic>-<hash> -f infra/compose.yaml up -d --wait postgres redis inngest server worker
docker compose --project-name bakery-<topic>-<hash> -f infra/compose.yaml down -v
```

If the default Docker socket is denied, look for a rootless engine in the user
session (`systemctl --user cat <engine>.service`) and set `DOCKER_HOST`; see
`learnings/ephemeral-worktree-stack.xml`.
