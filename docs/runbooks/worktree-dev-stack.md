# Worktree dev stack

How to bring up the API, a database and the web app from one git worktree, run a
browser spec against them, and tear everything down. CI does the same thing in
the `full / web shell browser` job of `.github/workflows/ci.yml`; this is that
recipe for a laptop or a shared host.

Use it when a check needs a real server: a Playwright case with
`BAKERY_REAL_API=1`, an auth flow, or a request the fixtures do not stub. On a
shared host keep to the host's limit on concurrent stacks, start only one, and
tear it down the moment you have the evidence.

## 1. Names, ports and scratch files

Everything below is derived from the worktree, so two worktrees on one host
never share a container, a port or a file. Run all six steps in one shell, from
the worktree root.

```bash
STACK="bakery-dev-$(basename "$PWD" | tr -c 'A-Za-z0-9\n' -)"   # e.g. bakery-dev-rig-559-recovery
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/$STACK.XXXXXX")"          # logs and the API pid
read PG WEB SERVER < <(node -e 'const n=require("net");const s=[1,2,3].map(()=>n.createServer());let p=[],i=0;const next=()=>i<3?s[i].listen(0,"127.0.0.1",()=>{p.push(s[i].address().port);i++;next()}):(console.log(p.join(" ")),s.forEach(x=>x.close()));next()')
```

Never use the fixed ports 5173 or 8000: another stack or a leaked dev server may
hold them. The three sockets stay open until all three ports are read, so they differ.

## 2. A database

Any PostgreSQL 16. A throwaway container named for the worktree:

```bash
docker run -d --name "$STACK-pg" -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=bakery-ci-postgres -p "127.0.0.1:$PG:5432" postgres:18-alpine@sha256:0115267ab5a509022df9319c77be365cef335adb71556c75f60f5360ee247e71
until docker exec "$STACK-pg" psql -U postgres -Atqc 'select 1' >/dev/null 2>&1; do sleep 1; done
docker exec "$STACK-pg" psql -U postgres -Atq \
  -c "CREATE ROLE bakery LOGIN PASSWORD 'bakery-ci-bakery'" \
  -c "CREATE ROLE bakery_app LOGIN PASSWORD 'bakery-ci-app'" \
  -c "CREATE DATABASE bakery OWNER bakery" \
  -c "GRANT CONNECT ON DATABASE bakery TO bakery_app"
```

## 3. Environment

```bash
export BAKERY_ENV=test BAKERY_SERVER_HOST=127.0.0.1
export BAKERY_WEB_PORT=$WEB BAKERY_SERVER_PORT=$SERVER
export BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:$WEB
export BETTER_AUTH_SECRET=$(head -c 48 /dev/zero | tr '\0' x)
export DATABASE_URL=postgres://bakery:bakery-ci-bakery@127.0.0.1:$PG/bakery
export BAKERY_APP_DATABASE_URL=postgres://bakery_app:bakery-ci-app@127.0.0.1:$PG/bakery
```

## 4. Migrate, start the API, seed the admin

From the worktree root (run `pnpm install --frozen-lockfile` first in a fresh worktree):

```bash
pnpm migrate
(cd apps/server && exec bash scripts/run-main.sh > "$SCRATCH/server.log" 2>&1) &
echo $! > "$SCRATCH/server.pid"
for i in $(seq 1 90); do curl -fsS "http://127.0.0.1:$SERVER/health/ready" >/dev/null && break; sleep 1; done
WEB_AUTH_SEED_PASSWORD=Browser-Admin-Passw0rd-1 deno run --allow-env --allow-net --allow-read \
  tests/helpers/web-auth-seed.ts browser-admin@example.test
```

### Owner maintenance: storage purges

An Admin "Delete forever" of a record-area file only queues a request; the
bytes are cleared by the `storage-purges` task, which connects with
`DATABASE_URL` as the database owner (the API holds only the runtime role).

- Schedule: the `storage-purges` service in `infra/compose.yaml` runs it
  every 600 seconds after `migrate` succeeds. The server image runs it once
  with `bash infra/railway/server-entrypoint.sh storage-purges`, for an
  external cron.
- By hand, after section 3's exports: `pnpm --filter @bakery/server storage-purges`.
  It prints `{"completed":N,"versionsPurged":M}`. Run as any role other than
  the owner it fails with AUTH_FORBIDDEN and changes nothing.

## 5. Run a browser spec

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

## 6. Tear down

The API is started with `exec`, and `run-main.sh` itself execs `deno`, so the
pid in the file is the `deno` process. Backgrounding the whole `cd ... && bash ...`
list instead would record a subshell and leave `deno` running after the kill.

```bash
kill "$(cat "$SCRATCH/server.pid")" 2>/dev/null
docker rm -fv "$STACK-pg"
rm -rf "$SCRATCH"
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
