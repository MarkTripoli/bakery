#!/usr/bin/env bash
# Railway-like local proof of the hosted QA deployment (#434, plan section 4).
#
# Builds the real server, web and Inngest images, starts them on the network
# layout of compose.yaml (private network without egress, TEST-NET-2 public
# network, edge emulator in front) and checks, with recorded commands and exit
# codes, every property the Railway bring-up depends on. Tears the stack down
# and verifies nothing is left.
#
#   prove.sh                     full run (all steps, teardown at the end)
#   prove.sh --keep              full run, leave the stack up afterwards
#   prove.sh --steps a,b,c       only the named steps (stack must exist), no teardown
#   prove.sh --teardown          tear down a leftover stack and verify
#
# Steps, in order: preflight build bringup predeploy start edge inngest seed
# ratelimit cookies browser isolation secretskey redeploy tickprobe dispatcher
# leaks
#
# Secrets live only in a 0600 env file under ~/.local/state; they are never
# printed, never put on a command line and never written to the evidence. The
# `leaks` step greps every log and evidence file for each of them.
#
# Evidence: $XDG_STATE_HOME/bakery/railway-qa/evidence/local-proof/:
# checks.tsv, README.md, outputs/, logs/.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
compose_file="$here/compose.yaml"
project=bakery-railway-qa-proof
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/bakery/railway-qa"
env_file="$state_dir/local-proof.env"
credentials_file="$state_dir/local-proof-admin.json"
scratch_dir="$state_dir/tmp"
evidence="$state_dir/evidence/local-proof"
lock_file="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bakery-verification.lock"
release_file="$root/.bakery-release-sha"
all_steps=(preflight build bringup predeploy start edge inngest seed ratelimit cookies browser isolation secretskey redeploy tickprobe dispatcher leaks)

keep=0
teardown_only=0
selected_steps=()
partial=0
while (($#)); do
  case "$1" in
    --keep) keep=1 ;;
    --teardown) teardown_only=1 ;;
    --steps)
      shift
      IFS=',' read -r -a selected_steps <<< "${1:-}"
      partial=1
      keep=1
      ;;
    *)
      printf 'usage: prove.sh [--keep] [--steps a,b,c] [--teardown]\n' >&2
      exit 64
      ;;
  esac
  shift
done

declare -i failures=0
declare -i checks=0
edge_port=""
candidate_sha=""

mkdir -p "$evidence/outputs" "$evidence/logs" "$scratch_dir"
touch "$evidence/checks.tsv"

record() {
  # record PASS|FAIL|INFO name [detail]
  local status="$1" name="$2" detail="${3-}"
  checks+=1
  [[ "$status" == FAIL ]] && failures+=1
  printf '%s\t%s\t%s\n' "$status" "$name" "$detail" >> "$evidence/checks.tsv"
  printf '[%s] %s%s\n' "$status" "$name" "${detail:+ - $detail}"
}

expect_eq() {
  # expect_eq name actual expected
  if [[ "$2" == "$3" ]]; then record PASS "$1" "$2"; else record FAIL "$1" "got '$2' want '$3'"; fi
}

expect_match() {
  # expect_match name actual regex  (detail keeps the first 160 characters, one line)
  local shown
  shown="$(printf '%s' "$2" | head -c 160 | tr '\n\r' '  ')"
  if [[ "$2" =~ $3 ]]; then record PASS "$1" "$shown"; else record FAIL "$1" "got '$shown' want ~ $3"; fi
}

dc() {
  docker compose --profile '*' -p "$project" --env-file "$env_file" -f "$compose_file" "$@"
}

load_env_value() {
  sed -n "s/^$1=//p" "$env_file" | head -n 1
}

secret_values() {
  sed -n -E 's/^(PROOF_POSTGRES_PASSWORD|PROOF_REDIS_PASSWORD|BAKERY_OWNER_PASSWORD|BAKERY_APP_PASSWORD|BAKERY_INNGEST_DATABASE_PASSWORD|BETTER_AUTH_SECRET|INNGEST_SIGNING_KEY|INNGEST_EVENT_KEY|BAKERY_SECRETS_KEY_B64)=(.+)$/\2/p' "$env_file"
  if [[ -f "$credentials_file" ]]; then jq -r '.password // empty' "$credentials_file"; fi
}

wait_for_memory() {
  local waited=0 available
  while :; do
    available="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
    ((available >= 3145728)) && return 0
    ((waited >= 1800)) && { echo "MEM_FLOOR_TIMEOUT last=${available}" >&2; return 75; }
    sleep 60
    waited=$((waited + 60))
  done
}

heavy() {
  (
    exec 9> "$lock_file"
    flock -w 900 9 || exit 75
    wait_for_memory || exit $?
    "$@"
  )
}

edge_curl() {
  curl -sk --max-time 20 --resolve "bakery-qa.localhost:${edge_port}:127.0.0.1" "$@"
}

client_curl() {
  # client_curl <client-service> curl-args...  (from the public network)
  local client="$1"
  shift
  dc exec -T "$client" curl -sk --max-time 20 \
    --resolve "bakery-qa.localhost:${edge_port}:198.51.100.2" "$@"
}

pg() {
  dc exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"' sh "$@"
}

# internal_http <service> <host> <port> <method> <path> [body] [authorization-token-var]
# Plain HTTP/1.1 over bash /dev/tcp from inside the private network. __EVENT_KEY__
# in the path and __SIGNING_KEY__ in the authorization are replaced inside the
# container from its own environment, so no secret crosses this script.
internal_http() {
  dc exec -T "$1" bash -s -- "$2" "$3" "$4" "$5" "${6-}" "${7-}" << 'EOS'
host=$1 port=$2 method=$3 path=$4 body=${5-} auth=${6-}
path=${path//__EVENT_KEY__/${INNGEST_EVENT_KEY-}}
extra=""
if [[ "$auth" == __SIGNING_KEY__ ]]; then
  extra="Authorization: Bearer ${INNGEST_SIGNING_KEY-}"$'\r\n'
fi
exec 3<> "/dev/tcp/$host/$port" || exit 7
printf '%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nContent-Type: application/json\r\n%sContent-Length: %d\r\n\r\n%s' \
  "$method" "$path" "$host" "$extra" "${#body}" "$body" >&3
cat <&3
EOS
}

# --- steps ------------------------------------------------------------------

step_preflight() {
  local tool
  for tool in docker curl jq openssl python3 flock git; do
    command -v "$tool" > /dev/null || { record FAIL "tool $tool present"; return 1; }
  done
  record PASS "required tools present"
  candidate_sha="$(git -C "$root" rev-parse HEAD)"
  printf '%s\n' "$candidate_sha" > "$evidence/candidate-sha.txt"
  record INFO "candidate sha" "$candidate_sha"
  local dirty
  dirty="$(git -C "$root" status --porcelain --untracked-files=normal | grep -v -E ' \.bakery-release-sha$' || true)"
  if [[ -n "$dirty" && "${PROVE_ALLOW_DIRTY:-0}" != 1 ]]; then
    record FAIL "working tree is clean (candidate sha describes the tree)" "$(printf '%s\n' "$dirty" | head -n 5 | tr '\n' ';')"
    return 1
  fi
  record PASS "working tree is clean"

  # Subnet collision check: host routes and every existing docker network.
  local overlap=""
  overlap="$(ip -4 route | grep -E '^(10\.250\.0\.|198\.51\.100\.)' || true)"
  overlap+="$(docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2> /dev/null | grep -E '(10\.250\.0\.0/24|198\.51\.100\.0/24)' | grep -v "^${project}_" || true)"
  if [[ -n "$overlap" ]]; then
    record FAIL "proof subnets 10.250.0.0/24 and 198.51.100.0/24 are unused" "$overlap"
    return 1
  fi
  record PASS "proof subnets 10.250.0.0/24 and 198.51.100.0/24 are unused"
  if [[ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$project")" ]]; then
    record FAIL "no leftover proof containers" "run prove.sh --teardown first"
    return 1
  fi
  if [[ -e "$env_file" ]]; then
    record FAIL "no leftover env file" "run prove.sh --teardown first"
    return 1
  fi

  # Secrets: generated once, mode 0600, never printed.
  (
    umask 077
    mkdir -p "$state_dir" "$scratch_dir"
    local port
    port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
    {
      printf 'EDGE_PORT=%s\n' "$port"
      printf 'PROOF_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'PROOF_REDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'BAKERY_OWNER_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'BAKERY_APP_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'BAKERY_INNGEST_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
      printf 'INNGEST_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)"
      printf 'INNGEST_EVENT_KEY=%s\n' "$(openssl rand -hex 24)"
      printf 'BAKERY_SECRETS_KEY_B64=%s\n' "$(openssl rand -base64 32)"
      printf 'BAKERY_SECRETS_KEY_ID=%s\n' 'qa-proof-1'
    } > "$env_file"
  )
  local mode
  mode="$(stat -c %a "$env_file")"
  expect_eq "env file mode" "$mode" 600
  edge_port="$(load_env_value EDGE_PORT)"
  record INFO "edge port (OS assigned)" "$edge_port"
  dc config -q && record PASS "docker compose config -q" || record FAIL "docker compose config -q"
}

step_build() {
  candidate_sha="$(git -C "$root" rev-parse HEAD)"
  printf '%s\n' "$candidate_sha" > "$release_file"
  heavy dc build api web inngest > "$evidence/outputs/build.log" 2>&1
  local rc=$?
  rm -f "$root/.bakery-release-sha"
  expect_eq "docker compose build api web inngest exit" "$rc" 0
  local image
  for image in server web inngest; do
    record INFO "image bakery-railway-qa-proof-$image:local" \
      "$(docker image inspect "bakery-railway-qa-proof-$image:local" --format '{{.Id}} {{.Size}}B' 2> /dev/null || echo missing)"
  done
  local label
  label="$(docker run --rm --network none --entrypoint bash bakery-railway-qa-proof-server:local -c 'tr -d "[:space:]" < /workspace/.bakery-release-sha')"
  expect_eq "server image carries the candidate sha" "$label" "$candidate_sha"
}

step_bringup() {
  heavy dc up -d --wait --wait-timeout 180 postgres redis > "$evidence/outputs/bringup.log" 2>&1
  expect_eq "postgres and redis healthy (up --wait exit)" "$?" 0
  expect_match "postgres 17 template" "$(pg -tAc 'show server_version')" '^17'
}

ledger_counts() {
  pg -d bakery -tAc "
    select table_schema || '.' || table_name || '=' ||
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables
    where table_name like '%schema_migrations%' and table_type = 'BASE TABLE'
    order by 1" 2> /dev/null | tr '\n' ' '
}

step_predeploy() {
  local out1="$evidence/outputs/predeploy-run1.txt" out2="$evidence/outputs/predeploy-run2.txt"
  heavy dc run --rm -T --no-deps api-predeploy > "$out1" 2>&1
  expect_eq "pre-deploy run 1 exit" "$?" 0
  local before after line1 line2
  before="$(ledger_counts)"
  record INFO "migration ledgers after run 1" "$before"
  line1="$(grep -h '"event":"bakery.database.bootstrap.v1"' "$out1" | tail -n 1)"
  record INFO "bootstrap run 1" "$line1"
  expect_eq "bootstrap run 1 reports changes" "$(jq -r '(.changes | length) > 0' <<< "$line1" 2> /dev/null)" true

  dc run --rm -T --no-deps api-predeploy > "$out2" 2>&1
  expect_eq "pre-deploy run 2 exit" "$?" 0
  after="$(ledger_counts)"
  line2="$(grep -h '"event":"bakery.database.bootstrap.v1"' "$out2" | tail -n 1)"
  record INFO "bootstrap run 2" "$line2"
  expect_eq "bootstrap run 2 reports changes []" "$(jq -c '.changes' <<< "$line2" 2> /dev/null)" '[]'
  expect_eq "AC5 migration ledgers unchanged by run 2" "$after" "$before"
  [[ -n "$before" ]] || record FAIL "ledger counts readable"

  local roles
  roles="$(pg -d railway -tAc "select rolname || ' ' || left(rolpassword, 19) from pg_authid where rolname in ('bakery','bakery_app','inngest') order by 1" | tr '\n' ';')"
  expect_eq "role passwords stored as SCRAM-SHA-256 verifiers" "$roles" \
    'bakery SCRAM-SHA-256$4096:;bakery_app SCRAM-SHA-256$4096:;inngest SCRAM-SHA-256$4096:;'
  expect_eq "databases bakery and inngest exist, owned by their roles" \
    "$(pg -d railway -tAc "select string_agg(datname || ':' || pg_get_userbyid(datdba), ',' order by datname) from pg_database where datname in ('bakery','inngest')")" \
    'bakery:bakery,inngest:inngest'
  dc logs --no-color postgres > "$evidence/logs/postgres-after-predeploy.log" 2>&1
  if grep -q -F -f <(secret_values) "$evidence/logs/postgres-after-predeploy.log"; then
    record FAIL "postgres log holds no plaintext password"
  else
    record PASS "postgres log holds no plaintext password"
  fi
}

step_start() {
  heavy dc up -d --wait --wait-timeout 300 api inngest dispatcher web edge > "$evidence/outputs/start.log" 2>&1
  local rc=$?
  expect_eq "api inngest dispatcher web edge healthy (up --wait exit)" "$rc" 0
  ((rc == 0)) || return 1
  dc up -d client-a client-b > /dev/null 2>&1
  expect_eq "probe clients started" "$?" 0
  dc ps --format '{{.Service}} {{.State}} {{.Health}}' > "$evidence/outputs/ps-after-start.txt" 2>&1
  local started
  started="$(docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q dispatcher)")"
  printf '%s\n' "$started" > "$scratch_dir/dispatcher-started-at"
  date +%s > "$scratch_dir/dispatcher-up-epoch"
}

step_dispatcher() {
  local scan
  scan="$(dc exec -T dispatcher bash -s << 'EOS'
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2> /dev/null) || continue
  case "$cmd" in
    *"deno run"*src/dispatch.ts*)
      case "$cmd" in *run-dispatch.ts*) role=launcher ;; *) role=child ;; esac
      count=$(tr '\0' '\n' < "$p/environ" 2> /dev/null | grep -c '^DENO_DIR=/deno-dir$')
      printf '%s pid=%s deno_dir=%s\n' "$role" "${p#/proc/}" "$count"
      ;;
  esac
done
EOS
)"
  printf '%s\n' "$scan" > "$evidence/outputs/dispatcher-processes.txt"
  expect_match "dispatcher child process exists with DENO_DIR=/deno-dir" "$scan" 'child pid=[0-9]+ deno_dir=1'
  expect_match "dispatcher launcher process exists" "$scan" 'launcher pid=[0-9]+'
  local id up_epoch now restarts running started0 started1
  id="$(dc ps -q dispatcher)"
  up_epoch="$(cat "$scratch_dir/dispatcher-up-epoch" 2> /dev/null || echo 0)"
  now="$(date +%s)"
  if ((now - up_epoch < 120)); then sleep $((120 - (now - up_epoch))); fi
  restarts="$(docker inspect -f '{{.RestartCount}}' "$id")"
  running="$(docker inspect -f '{{.State.Running}}' "$id")"
  started0="$(cat "$scratch_dir/dispatcher-started-at" 2> /dev/null || true)"
  started1="$(docker inspect -f '{{.State.StartedAt}}' "$id")"
  expect_eq "dispatcher still running 2+ minutes after start" "$running" true
  expect_eq "dispatcher restart count after 2+ minutes" "$restarts" 0
  [[ -z "$started0" || "$started0" == "$started1" ]] \
    && record PASS "dispatcher container not restarted since start" \
    || record FAIL "dispatcher container not restarted since start" "$started0 -> $started1"
  local logs
  logs="$(dc logs --no-color dispatcher api 2>&1)"
  if grep -q -E 'INNGEST_URL_INVALID|BAKERY_APP_DATABASE_ROLE_UNSAFE|Download |error: ' <<< "$logs"; then
    record FAIL "dispatcher and api logs hold no config, role or download errors" "$(grep -E 'INNGEST_URL_INVALID|BAKERY_APP_DATABASE_ROLE_UNSAFE|Download |error: ' <<< "$logs" | head -n 3 | tr '\n' ';')"
  else
    record PASS "dispatcher and api logs hold no config, role or download errors"
  fi
  # The dispatcher network has no egress; sample that nothing was reachable.
  local egress
  egress="$(dc exec -T dispatcher timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>&1 && echo reachable || echo blocked)"
  expect_match "private network has no egress (1.1.1.1:53)" "$egress" 'blocked$'
}

step_edge() {
  local base="https://bakery-qa.localhost:${edge_port}" body status headers
  body="$scratch_dir/body.json"
  status="$(edge_curl -o "$body" -w '%{http_code}' "$base/health/ready")"
  expect_eq "edge /health/ready status" "$status" 200
  expect_eq "edge /health/ready version is the candidate sha" "$(jq -r '.version // empty' "$body" 2> /dev/null)" "$candidate_sha"
  expect_eq "edge /livez status" "$(edge_curl -o /dev/null -w '%{http_code}' "$base/livez")" 200
  expect_eq "edge /v1/installation/status bootstrapped:false" \
    "$(edge_curl "$base/v1/installation/status" | jq -r '.bootstrapped' 2> /dev/null)" false
  status="$(edge_curl -o "$body" -w '%{http_code}' "$base/.well-known/oauth-protected-resource/mcp")"
  expect_eq "edge oauth-protected-resource/mcp status" "$status" 200
  expect_eq "edge oauth-protected-resource/mcp is JSON" "$(jq -e 'type == "object"' "$body" > /dev/null 2>&1 && echo json || echo other)" json
  status="$(edge_curl -o "$body" -w '%{http_code}' "$base/.well-known/oauth-authorization-server/api/auth")"
  expect_eq "edge oauth-authorization-server/api/auth status" "$status" 200
  headers="$(edge_curl -D - -o /dev/null -X POST "$base/mcp" -H 'content-type: application/json' -d '{}')"
  expect_match "edge /mcp answers 401" "$(head -n 1 <<< "$headers" | tr -d '\r')" ' 401'
  expect_match "edge /mcp carries WWW-Authenticate" "$headers" '[Ww][Ww][Ww]-[Aa]uthenticate:'
  local index asset
  index="$scratch_dir/index.html"
  edge_curl -D "$scratch_dir/index.headers" -o "$index" "$base/"
  expect_match "edge / is the SPA shell" "$(head -c 400 "$index")" '<!doctype html|<!DOCTYPE html'
  expect_match "edge / is no-store" "$(tr -d '\r' < "$scratch_dir/index.headers")" 'cache-control: no-store'
  asset="$(grep -o '/assets/[A-Za-z0-9._-]*\.js' "$index" | head -n 1)"
  [[ -n "$asset" ]] || { record FAIL "index references a hashed js asset"; return; }
  record INFO "hashed asset" "$asset"
  expect_match "edge asset is immutable" "$(edge_curl -D - -o /dev/null "$base$asset" | tr -d '\r' | tr 'A-Z' 'a-z')" 'cache-control: public, max-age=31536000, immutable'
  expect_eq "edge asset .map is 404" "$(edge_curl -o /dev/null -w '%{http_code}' "$base$asset.map")" 404
  edge_curl -D "$scratch_dir/spa.headers" -o "$scratch_dir/spa.html" "$base/some/spa/route"
  expect_eq "edge SPA route serves index.html" "$(cmp -s "$index" "$scratch_dir/spa.html" && echo same || echo different)" same
  expect_match "edge SPA route is no-store" "$(tr -d '\r' < "$scratch_dir/spa.headers")" 'cache-control: no-store'
  # Same checks from a client on the public network (the path real users take).
  expect_eq "client-a /livez through the edge" "$(client_curl client-a -o /dev/null -w '%{http_code}' "$base/livez")" 200
  expect_eq "client-b /health/ready through the edge" "$(client_curl client-b -o /dev/null -w '%{http_code}' "$base/health/ready")" 200
  # Private names do not resolve from the public network at all.
  local direct
  direct="$(dc exec -T client-a curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://api.railway.internal:8000/health/ready 2> /dev/null || true)"
  expect_eq "api.railway.internal is not reachable from the public clients" "$direct" 000
}

step_inngest() {
  local listen
  listen="$(dc exec -T inngest bash -c 'cat /proc/net/tcp6' | awk 'NR>1 && $4=="0A" {print $2}' | tr '\n' ' ')"
  printf '%s\n' "$listen" > "$evidence/outputs/inngest-tcp6-listeners.txt"
  expect_match "inngest listens on the tcp6 wildcard :8288" "$listen" '00000000000000000000000000000000:2060'
  local cmdlines
  cmdlines="$(dc exec -T inngest bash -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null; echo; done')"
  printf '%s\n' "$cmdlines" | grep -v '^$' > "$evidence/outputs/inngest-cmdlines.txt"
  if printf '%s' "$cmdlines" | grep -q -F -f <(secret_values); then
    record FAIL "inngest process arguments hold no secret"
  else
    record PASS "inngest process arguments hold no secret"
  fi
  # Reachable from the API over IPv4 by the private alias.
  local reply
  reply="$(internal_http api inngest.railway.internal 8288 GET /health | head -n 1 | tr -d '\r')"
  expect_match "api reaches http://inngest.railway.internal:8288/health" "$reply" ' 200'
  record INFO "api resolves inngest.railway.internal" "$(dc exec -T api getent ahosts inngest.railway.internal | awk '{print $1}' | sort -u | tr '\n' ' ')"

  # Env-name proofs: the start script passes configuration by environment only.
  local good bad
  good="$(internal_http api inngest.railway.internal 8288 POST '/e/__EVENT_KEY__' '{"name":"qa/proof.ping","data":{}}' | head -n 1 | tr -d '\r')"
  bad="$(internal_http api inngest.railway.internal 8288 POST '/e/not-the-event-key' '{"name":"qa/proof.ping","data":{}}' | head -n 1 | tr -d '\r')"
  record INFO "event ingest with the configured key" "$good"
  record INFO "event ingest with a wrong key" "$bad"
  expect_match "INNGEST_EVENT_KEY is honoured (configured key accepted)" "$good" ' 200'
  [[ "$bad" =~ \ (401|403) ]] \
    && record PASS "INNGEST_EVENT_KEY is honoured (wrong key refused)" "$bad" \
    || record FAIL "INNGEST_EVENT_KEY is honoured (wrong key refused)" "$bad"

  local gql apps=""
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    gql="$(internal_http api inngest.railway.internal 8288 POST /v0/gql '{"query":"{ apps { name functionCount error url } }"}' __SIGNING_KEY__)"
    apps="$(sed -n '/^\r\?$/,$p' <<< "$gql" | tr -d '\r' | grep -o '{"data".*}' | head -n 1)"
    [[ "$(jq -r '[.data.apps[]? | select(.functionCount > 0)] | length' <<< "$apps" 2> /dev/null)" -gt 0 ]] 2> /dev/null && break
    sleep 5
  done
  printf '%s\n' "$apps" > "$evidence/outputs/inngest-apps.json"
  expect_eq "inngest synced an app with functions (signing key + SDK URL honoured)" \
    "$(jq -r '[.data.apps[]? | select(.functionCount > 0)] | length > 0' <<< "$apps" 2> /dev/null)" true
  expect_eq "inngest app URL is the private SDK URL (INNGEST_SDK_URL honoured)" \
    "$(jq -r '[.data.apps[]? | .url] | any(. == "http://api.railway.internal:8000/api/inngest")' <<< "$apps" 2> /dev/null)" true
  expect_eq "inngest app reports no sync error" "$(jq -r '[.data.apps[]? | .error // empty] | length' <<< "$apps" 2> /dev/null)" 0
  local keys
  keys="$(dc exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli dbsize' | tr -d '\r')"
  record INFO "redis keys after inngest sync" "$keys"
  [[ "$keys" =~ ^[0-9]+$ && "$keys" -gt 0 ]] \
    && record PASS "INNGEST_REDIS_URI is honoured (inngest state lives in redis)" "$keys" \
    || record FAIL "INNGEST_REDIS_URI is honoured (inngest state lives in redis)" "$keys"
  local sessions
  sessions="$(pg -d railway -tAc "select count(*) from pg_stat_activity where usename = 'inngest'")"
  record INFO "inngest postgres sessions" "$sessions"

  # AC3: the private-host rule is opt-in. Same URL with the suffix unset and
  # the old `inngest` host form are both refused by the server in production.
  local out rc
  out="$(dc run --rm -T --no-deps -e BAKERY_INNGEST_PRIVATE_HOST_SUFFIX= api 2>&1)"
  rc=$?
  printf '%s\n' "$out" | tail -n 5 > "$evidence/outputs/negative-suffix-unset.txt"
  [[ "$rc" -ne 0 ]] && record PASS "AC3 suffix unset: server refuses http Inngest in production" "exit $rc" \
    || record FAIL "AC3 suffix unset: server refuses http Inngest in production" "exit $rc"
  expect_match "AC3 suffix unset: error names INNGEST_URL" "$out" 'INNGEST_URL'
  out="$(dc run --rm -T --no-deps -e INNGEST_URL=http://inngest:8288 api 2>&1)"
  rc=$?
  printf '%s\n' "$out" | tail -n 5 > "$evidence/outputs/negative-host-inngest.txt"
  [[ "$rc" -ne 0 ]] && record PASS "AC3 host 'inngest' without the private suffix rule is refused" "exit $rc" \
    || record FAIL "AC3 host 'inngest' without the private suffix rule is refused" "exit $rc"
  out="$(dc run --rm -T --no-deps -e INNGEST_URL=http://evil.example.com:8288 api 2>&1)"
  rc=$?
  [[ "$rc" -ne 0 ]] && record PASS "AC3 http to a non-private host is refused" "exit $rc" \
    || record FAIL "AC3 http to a non-private host is refused" "exit $rc"
}

step_seed() {
  local envcheck
  envcheck="$(dc exec -T api bash /workspace/infra/railway/server-entrypoint.sh envcheck)"
  printf '%s\n' "$envcheck" > "$evidence/outputs/envcheck.txt"
  local name
  for name in DATABASE_URL BAKERY_APP_DATABASE_URL BETTER_AUTH_SECRET BAKERY_PUBLIC_BASE_URL BAKERY_ENV; do
    expect_eq "envcheck $name" "$(grep -x "$name=set" <<< "$envcheck")" "$name=set"
  done
  local base="https://bakery-qa.localhost:${edge_port}" out rc
  out="$(python3 -B "$root/infra/railway/seed-admin.py" --transport compose \
    --compose-file "$compose_file" --compose-project "$project" --compose-env-file "$env_file" \
    --url "$base" --connect 127.0.0.1 --insecure --credentials "$credentials_file" 2>&1)"
  rc=$?
  printf '%s\n' "$out" > "$evidence/outputs/seed-admin-run1.json"
  expect_eq "seed-admin first run exit" "$rc" 0
  expect_eq "seed-admin reports bootstrapped" "$(jq -r '.bootstrapped_after' <<< "$out" 2> /dev/null)" true
  expect_eq "credentials file mode" "$(stat -c %a "$credentials_file" 2> /dev/null)" 600
  expect_eq "credentials setup_state" "$(jq -r '.setup_state' "$credentials_file" 2> /dev/null)" complete
  expect_eq "installation status bootstrapped:true" "$(edge_curl "$base/v1/installation/status" | jq -r '.bootstrapped' 2> /dev/null)" true
  out="$(python3 -B "$root/infra/railway/seed-admin.py" --transport compose \
    --compose-file "$compose_file" --compose-project "$project" --compose-env-file "$env_file" \
    --url "$base" --connect 127.0.0.1 --insecure --credentials "$credentials_file" 2>&1)"
  rc=$?
  printf '%s\n' "$out" > "$evidence/outputs/seed-admin-run2.json"
  expect_eq "seed-admin second run refuses (exit 2)" "$rc" 2
  expect_match "seed-admin second run reason" "$out" 'INSTALLATION_ALREADY_BOOTSTRAPPED'
}

rate_keys() {
  local table
  table="$(pg -d bakery -tAc "select quote_ident(schemaname) || '.' || quote_ident(tablename) from pg_tables where tablename = 'rateLimit' limit 1")"
  [[ -n "$table" ]] || { echo "NO_RATELIMIT_TABLE"; return 1; }
  pg -d bakery -tAc "select key || ' ' || count from $table order by key"
}

probe_sign_in() {
  # probe_sign_in <client> [extra curl args...]: wrong-password sign-in for the probe email.
  local client="$1"
  shift
  client_curl "$client" -o /dev/null -w '%{http_code}' -X POST \
    "https://bakery-qa.localhost:${edge_port}/api/auth/sign-in/email" \
    -H "Origin: https://bakery-qa.localhost:${edge_port}" -H 'Content-Type: application/json' \
    "$@" --data '{"email":"ratelimit-probe@bakery-qa.local","password":"not-the-password-0"}'
}

wait_api_healthy() {
  local deadline=$((SECONDS + 180)) id state
  while ((SECONDS < deadline)); do
    id="$(dc ps -q api)"
    state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2> /dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

step_ratelimit() {
  local code keys
  code="$(probe_sign_in client-a)"
  record INFO "client-a probe sign-in status" "$code"
  code="$(probe_sign_in client-b)"
  record INFO "client-b probe sign-in status" "$code"
  keys="$(rate_keys)"
  printf '%s\n' "$keys" > "$evidence/outputs/ratelimit-keys-1.txt"
  expect_match "AC4 rateLimit key for client-a 198.51.100.11" "$keys" '198\.51\.100\.11'
  expect_match "AC4 rateLimit key for client-b 198.51.100.12" "$keys" '198\.51\.100\.12'
  if grep -q '10\.250\.' <<< "$keys"; then record FAIL "AC4 no rateLimit key carries the web container address"; else record PASS "AC4 no rateLimit key carries the web container address"; fi
  local before after
  before="$(grep -F '198.51.100.11' <<< "$keys" | awk '{s += $NF} END {print s + 0}')"
  probe_sign_in client-a -H 'X-Real-IP: 203.0.113.77' -H 'X-Forwarded-For: 203.0.113.77' \
    -H 'X-Bakery-Remote-Addr: 203.0.113.77' -H 'Forwarded: for=203.0.113.77' > /dev/null
  keys="$(rate_keys)"
  printf '%s\n' "$keys" > "$evidence/outputs/ratelimit-keys-2-spoof.txt"
  if grep -q '203\.0\.113\.77' <<< "$keys"; then record FAIL "AC4 spoofed X-Real-IP/X-Forwarded-For/X-Bakery-Remote-Addr/Forwarded produce no key"; else record PASS "AC4 spoofed X-Real-IP/X-Forwarded-For/X-Bakery-Remote-Addr/Forwarded produce no key"; fi
  after="$(grep -F '198.51.100.11' <<< "$keys" | awk '{s += $NF} END {print s + 0}')"
  [[ -n "$before" && -n "$after" && "$after" -gt "$before" ]] \
    && record PASS "AC4 spoofed request counted against the real client key" "$before -> $after" \
    || record FAIL "AC4 spoofed request counted against the real client key" "$before -> $after"

  # Negative control: no trusted proxies configured -> every client shares the
  # web container's key (safe, coarse).
  PROOF_API_TRUSTED_PROXY_CIDRS= dc up -d --force-recreate --no-deps --wait --wait-timeout 180 api > "$evidence/outputs/api-recreate-untrusted.log" 2>&1
  expect_eq "api recreated without BAKERY_TRUSTED_PROXY_CIDRS healthy" "$?" 0
  probe_sign_in client-a > /dev/null
  probe_sign_in client-b > /dev/null
  keys="$(rate_keys)"
  printf '%s\n' "$keys" > "$evidence/outputs/ratelimit-keys-3-untrusted.txt"
  local shared
  shared="$(grep -E '10\.250\.0\.[0-9]+' <<< "$keys" | awk '{s += $NF} END {print s + 0}')"
  [[ -n "$shared" && "$shared" -ge 2 ]] \
    && record PASS "AC4 control: with no trusted proxies both clients share the web address key" "count $shared" \
    || record FAIL "AC4 control: with no trusted proxies both clients share the web address key" "count '${shared}'"
  # Restore the Railway configuration.
  dc up -d --force-recreate --no-deps --wait --wait-timeout 180 api > "$evidence/outputs/api-recreate-restored.log" 2>&1
  expect_eq "api restored with BAKERY_TRUSTED_PROXY_CIDRS healthy" "$?" 0
  expect_eq "restored api trust list is set" \
    "$(dc exec -T api bash -c '[[ -n "${BAKERY_TRUSTED_PROXY_CIDRS:-}" ]] && echo set || echo unset')" set
}

step_cookies() {
  [[ -f "$credentials_file" ]] || { record FAIL "credentials file present for the sign-in checks"; return 1; }
  local base="https://bakery-qa.localhost:${edge_port}" headers
  headers="$(jq -c '{email, password}' "$credentials_file" | edge_curl -D - -o /dev/null -X POST "$base/api/auth/sign-in/email" \
    -H "Origin: $base" -H 'Content-Type: application/json' --data @-)"
  printf '%s\n' "$headers" | tr -d '\r' | sed -E 's/^([Ss]et-[Cc]ookie: [^=]+=)[^;]*/\1<redacted>/' > "$evidence/outputs/signin-headers-redacted.txt"
  expect_match "sign-in status" "$(head -n 1 <<< "$headers" | tr -d '\r')" ' 200'
  local cookies line
  local -i bad=0 total=0
  cookies="$(tr -d '\r' <<< "$headers" | grep -i '^set-cookie:' || true)"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    total+=1
    [[ "$line" =~ ^[Ss]et-[Cc]ookie:\ __Secure- && "$line" =~ [Ss]ecure && "$line" =~ [Hh]ttp[Oo]nly && "$line" =~ [Ss]ame[Ss]ite=[Ll]ax ]] || bad+=1
  done <<< "$cookies"
  [[ "$total" -ge 1 && "$bad" -eq 0 ]] \
    && record PASS "session cookies are __Secure- prefixed with Secure; HttpOnly; SameSite=Lax" "$total cookies" \
    || record FAIL "session cookies are __Secure- prefixed with Secure; HttpOnly; SameSite=Lax" "$total cookies, $bad bad"
}

write_browser_spec() {
  cat > "$evidence/signin.spec.ts" << 'EOS'
import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

// Local-proof browser check (AC2): sign in through the edge with the seeded
// admin, load the shell, open the realtime socket, verify cookies and the
// credential-write key path. The password is read from a 0600 file and is never
// logged or written to the result file.
const base = process.env.PROOF_BASE_URL!;
const out = process.env.PROOF_OUT_DIR!;
const credentials = JSON.parse(readFileSync(process.env.PROOF_CREDENTIALS_FILE!, "utf8"));

test("sign in through the edge, realtime socket, cookies, key path", async ({ page, context }) => {
  test.setTimeout(180_000);
  const result: Record<string, unknown> = {};
  const consoleErrors: string[] = [];
  const appSockets: string[] = [];
  // Before sign-in the app probes /v1/me and similar and gets 401s, which the
  // browser logs as console errors. Those are expected; anything logged after
  // the sign-in response, and any page error, is not.
  let signedIn = false;
  const preSignInErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    (signedIn ? consoleErrors : preSignInErrors).push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/api/auth/sign-in/email" && response.status() === 200) signedIn = true;
    if (response.status() >= 400) failedResponses.push(`${signedIn ? "after" : "before"} sign-in: ${response.status()} ${response.request().method()} ${path}`);
  });
  page.on("websocket", (socket) => appSockets.push(new URL(socket.url()).pathname));

  await page.goto(`${base}/sign-in`);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  const meResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/me" && response.request().method() === "GET"
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const me = await meResponse;
  result.meStatus = me.status();
  expect(me.status()).toBe(200);
  const identity = await me.json();
  result.meKeys = Object.keys(identity).sort();

  const organizations = await page.request.get(`${base}/v1/organizations`);
  expect(organizations.status()).toBe(200);
  const organizationId: string = (await organizations.json()).items[0].id;
  result.organizationCount = 1;

  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page.locator("body")).not.toBeEmpty();
  result.landedPath = new URL(page.url()).pathname;
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/shell.png`, fullPage: false });

  // Realtime socket through the edge and the web proxy: first frame is hello.
  const socket = await page.evaluate((organization: string) =>
    new Promise<{ frame: string; closedEarly: boolean }>((resolve, reject) => {
      const ws = new WebSocket(`wss://${location.host}/v1/events?organizationId=${organization}`);
      let closed = false;
      const timer = setTimeout(() => reject(new Error("socket hello timeout")), 15_000);
      ws.onclose = () => { closed = true; };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("socketerror")); };
      ws.onmessage = (event) => {
        clearTimeout(timer);
        const frame = String(event.data);
        setTimeout(() => {
          const closedEarly = closed;
          ws.close();
          resolve({ frame, closedEarly });
        }, 5000);
      };
    }),
    organizationId,
  );
  const hello = JSON.parse(socket.frame);
  result.socketFirstFrameType = hello.type;
  result.socketProtocolVersion = hello.protocolVersion;
  result.socketClosedWithinFiveSeconds = socket.closedEarly;
  result.appSocketPaths = appSockets;
  expect(hello.type).toBe("hello");
  expect(hello.protocolVersion).toBe(1);
  expect(socket.closedEarly).toBe(false);

  const cookies = await context.cookies();
  const session = cookies.filter((cookie) => cookie.name.startsWith("__Secure-"));
  result.cookieNames = cookies.map((cookie) => cookie.name).sort();
  result.sessionCookiesAllSecure = session.length > 0 && session.every((cookie) => cookie.secure && cookie.httpOnly);
  expect(session.length).toBeGreaterThan(0);
  expect(session.every((cookie) => cookie.secure)).toBe(true);

  // Credential-write key path: the key file must load (no STATE_CONFLICT). The
  // write then needs GitHub, which the private network cannot reach.
  {
    const headers = {
      origin: base,
      "content-type": "application/json",
      "Bakery-Organization-Id": organizationId,
    };
    const slug = `proof-${crypto.randomUUID().slice(0, 8)}`;
    const application = await page.request.post(`${base}/v1/applications`, {
      headers: { ...headers, "Idempotency-Key": `proof-app-${crypto.randomUUID()}` },
      data: { slug, name: "Local proof", description: "Local proof application" },
    });
    result.applicationStatus = application.status();
    if (application.status() === 201) {
      const applicationId = (await application.json()).id;
      const secret = await page.request.post(`${base}/v1/secrets`, {
        headers: { ...headers, "Idempotency-Key": `proof-secret-${crypto.randomUUID()}` },
        data: {
          applicationId,
          name: "Local proof credential",
          provider: "github",
          value: "proof-not-a-real-token",
          allowedPrincipalIds: [],
          allowedActions: [],
        },
      });
      result.secretStatus = secret.status();
      const problem = await secret.json().catch(() => ({}));
      result.secretProblemType = String(problem.type ?? "").split("/").pop();
      result.secretProblemCode = problem.code ?? problem.errorCode ?? null;
      result.secretKeyLoaded = secret.status() !== 409;
    }
  }

  result.preSignInConsoleErrors = preSignInErrors;
  result.failedResponses = failedResponses;
  result.consoleErrors = consoleErrors;
  writeFileSync(`${out}/browser-result.json`, JSON.stringify(result, null, 2));
  expect(consoleErrors).toEqual([]);
});

EOS
  cat > "$evidence/playwright.proof.config.ts" << 'EOS'
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "signin.spec.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./pw-output",
  use: { ignoreHTTPSErrors: true, headless: true },
});
EOS
}

step_browser() {
  write_browser_spec
  local base="https://bakery-qa.localhost:${edge_port}" rc
  (
    cd "$root" || exit 1
    TMPDIR="$scratch_dir" PROOF_BASE_URL="$base" PROOF_OUT_DIR="$evidence" \
      PROOF_CREDENTIALS_FILE="$credentials_file" \
      heavy node_modules/.bin/playwright test --config "$evidence/playwright.proof.config.ts" --workers=1
  ) > "$evidence/outputs/browser-playwright.txt" 2>&1
  rc=$?
  expect_eq "playwright sign-in spec exit" "$rc" 0
  if [[ -f "$evidence/browser-result.json" ]]; then
    record INFO "browser result" "$(jq -c 'del(.consoleErrors, .meKeys)' "$evidence/browser-result.json")"
    expect_eq "AC2 /v1/me status after browser sign-in" "$(jq -r '.meStatus' "$evidence/browser-result.json")" 200
    expect_eq "AC2 realtime socket first frame is hello" "$(jq -r '.socketFirstFrameType' "$evidence/browser-result.json")" hello
    expect_eq "AC2 realtime socket stays open for 5 s" "$(jq -r '.socketClosedWithinFiveSeconds' "$evidence/browser-result.json")" false
    expect_eq "AC2 session cookies secure" "$(jq -r '.sessionCookiesAllSecure' "$evidence/browser-result.json")" true
    expect_eq "AC2 only failed response is the pre-sign-in /v1/me probe" "$(jq -c '.failedResponses' "$evidence/browser-result.json")" '["before sign-in: 401 GET /v1/me"]'
    expect_eq "AC2 console errors after sign-in" "$(jq -c '.consoleErrors' "$evidence/browser-result.json")" '[]'
  else
    record FAIL "browser result file written"
  fi
}

step_isolation() {
  local out
  out="$(dc exec -T -w /workspace/apps/server api deno run --cached-only --no-prompt \
    --allow-read=/workspace --allow-env --allow-sys=uid,statfs,osRelease \
    --allow-run=/usr/bin/systemd-run,/usr/bin/systemctl,/usr/bin/journalctl - << 'EOS' 2>&1
import { createDraftIsolation } from "file:///workspace/apps/server/src/modules/knowledge/draft-isolation.ts";
try {
  await createDraftIsolation().initialize("x");
  console.log(JSON.stringify({ outcome: "unexpected-success" }));
} catch (error) {
  const e = error as { name?: string; kind?: string; message?: string };
  console.log(JSON.stringify({ outcome: "error", name: e.name, kind: e.kind, message: e.message }));
}
EOS
)"
  printf '%s\n' "$out" > "$evidence/outputs/draft-isolation-probe.txt"
  local line
  line="$(grep -h '"outcome"' <<< "$out" | tail -n 1)"
  expect_eq "draft isolation without systemd: kind" "$(jq -r '.kind' <<< "$line" 2> /dev/null)" unavailable
  expect_eq "draft isolation without systemd: code" "$(jq -r '.message' <<< "$line" 2> /dev/null)" HOST_ISOLATION_UNAVAILABLE
  expect_eq "api still ready after the isolation probe" "$(edge_curl -o /dev/null -w '%{http_code}' "https://bakery-qa.localhost:${edge_port}/health/ready")" 200
  expect_eq "api container still running" "$(docker inspect -f '{{.State.Running}}' "$(dc ps -q api)")" true
}

step_secretskey() {
  expect_eq "secrets key file is mode 600 and 32 bytes" \
    "$(dc exec -T api stat -c '%a %s %U' /home/deno/.bakery/secrets.key | tr -d '\r')" '600 32 deno'
  # Every process of the api container except this scanner shell and its own
  # children (docker exec starts the scanner with the container's configured
  # environment, which is not what the api processes hold at runtime).
  local scan names_pid1 name forbidden_all=""
  local forbidden_names=(BAKERY_SECRETS_KEY_B64 DATABASE_URL BAKERY_BOOTSTRAP_DATABASE_URL BAKERY_OWNER_PASSWORD BAKERY_APP_PASSWORD BAKERY_INNGEST_DATABASE_PASSWORD)
  scan="$(dc exec -T api bash -s << 'EOS'
scanner=$$
under_scanner() {
  local pid="$1" ppid
  while [ -n "$pid" ] && [ "$pid" != 0 ]; do
    [ "$pid" = "$scanner" ] && return 0
    ppid=$(awk '{print $4}' "/proc/$pid/stat" 2> /dev/null) || return 1
    [ "$ppid" = "$pid" ] && return 1
    pid="$ppid"
  done
  return 1
}
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  [ -r "$p/cmdline" ] || continue
  under_scanner "$pid" && continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2> /dev/null) || continue
  echo "PROCESS $pid $cmd"
  tr '\0' '\n' < "$p/environ" 2> /dev/null | sed 's/=.*//' | sort | sed "s/^/ENV $pid /"
done
EOS
)"
  printf '%s\n' "$scan" > "$evidence/outputs/api-process-env-names.txt"
  expect_match "container PID 1 is tini, not the Deno base entrypoint" "$(grep -E '^PROCESS 1 ' <<< "$scan")" '^PROCESS 1 /tini -s -- deno run .*src/main.ts'
  expect_match "api server process is deno run ... src/main.ts" "$(grep -E '^PROCESS [0-9]+ deno run .*src/main.ts' <<< "$scan" | head -n 1)" 'PROCESS [0-9]+ deno run .*src/main.ts'
  expect_eq "PID 1 environment holds BAKERY_SECRETS_KEY_FILE" "$(grep -x 'ENV 1 BAKERY_SECRETS_KEY_FILE' <<< "$scan")" 'ENV 1 BAKERY_SECRETS_KEY_FILE'
  for name in "${forbidden_names[@]}"; do
    grep -q -E "^ENV [0-9]+ ${name}\$" <<< "$scan" && forbidden_all+="$name "
  done
  expect_eq "no api container process (PID 1 included) holds the key B64, owner, app, inngest or superuser variables" "${forbidden_all:-none}" none
  names_pid1="$(grep -E '^ENV 1 ' <<< "$scan" | sed 's/^ENV 1 //')"
  expect_eq "PID 1 sees BAKERY_TRUSTED_PROXY_CIDRS and the private-host suffix" \
    "$(grep -x -E 'BAKERY_TRUSTED_PROXY_CIDRS|BAKERY_INNGEST_PRIVATE_HOST_SUFFIX' <<< "$names_pid1" | sort | tr '\n' ' ')" \
    'BAKERY_INNGEST_PRIVATE_HOST_SUFFIX BAKERY_TRUSTED_PROXY_CIDRS '
  if [[ -f "$evidence/browser-result.json" ]]; then
    expect_eq "credential write passes the key-load stage (not STATE_CONFLICT)" \
      "$(jq -r '.secretKeyLoaded' "$evidence/browser-result.json")" true
    record INFO "credential write response" "$(jq -c '{applicationStatus, secretStatus, secretProblemType}' "$evidence/browser-result.json")"
  else
    record FAIL "browser result available for the key-path check"
  fi
}

step_redeploy() {
  local url="https://bakery-qa.localhost:${edge_port}/health/ready" loop_log="$scratch_dir/redeploy-codes.txt" loop_pid
  : > "$loop_log"
  (
    while :; do
      edge_curl -o /dev/null -w '%{http_code}\n' "$url" >> "$loop_log" 2> /dev/null
      sleep 0.2
    done
  ) &
  loop_pid=$!
  sleep 2
  # Railway order: pre-deploy first (old API still serving), then the new deployment.
  dc run --rm -T --no-deps api-predeploy > "$evidence/outputs/predeploy-before-redeploy.txt" 2>&1
  expect_eq "pre-deploy before redeploy exit" "$?" 0
  dc up -d --force-recreate --no-deps --wait --wait-timeout 180 api > "$evidence/outputs/api-redeploy.log" 2>&1
  expect_eq "api redeploy healthy" "$?" 0
  sleep 3
  kill "$loop_pid" 2> /dev/null
  wait "$loop_pid" 2> /dev/null
  local total ok bad502
  total="$(grep -c . "$loop_log")"
  ok="$(grep -c '^200$' "$loop_log")"
  bad502="$(grep -c '^50[0-9]$' "$loop_log")"
  record INFO "redeploy gap, requests through the edge" "total=$total ok=$ok 5xx=$bad502 other=$((total - ok - bad502))"
  sort "$loop_log" | uniq -c > "$evidence/outputs/redeploy-status-histogram.txt"
  expect_eq "redeploy gap 5xx responses (lb_try_duration 10s)" "$bad502" 0
}

cpu_ticks() {
  dc exec -T inngest bash -c 'read -r -a f < /proc/1/stat; echo $((f[13] + f[14]))' | tr -d '\r'
}

step_tickprobe() {
  # Idle CPU of the default configuration (tick 1000, pool 20/5)...
  sleep 20
  local a b default_cpu probe_cpu conns_default conns_probe
  a="$(cpu_ticks)"
  sleep 30
  b="$(cpu_ticks)"
  default_cpu=$((b - a))
  conns_default="$(pg -d railway -tAc "select count(*) from pg_stat_activity where usename = 'inngest'")"
  record INFO "inngest idle cpu ticks over 30 s, INNGEST_TICK=1000 default" "$default_cpu"
  record INFO "inngest postgres sessions, default pool" "$conns_default"
  # ...against tick 150 and a pool of 3: proves the environment names are read.
  PROOF_INNGEST_TICK=150 PROOF_INNGEST_MAX_OPEN=3 PROOF_INNGEST_MAX_IDLE=1 \
    dc up -d --force-recreate --no-deps --wait --wait-timeout 240 inngest > "$evidence/outputs/inngest-probe-recreate.log" 2>&1
  expect_eq "inngest recreated with tick 150 healthy" "$?" 0
  sleep 20
  a="$(cpu_ticks)"
  sleep 30
  b="$(cpu_ticks)"
  probe_cpu=$((b - a))
  conns_probe="$(pg -d railway -tAc "select count(*) from pg_stat_activity where usename = 'inngest'")"
  record INFO "inngest idle cpu ticks over 30 s, INNGEST_TICK=150" "$probe_cpu"
  record INFO "inngest postgres sessions, INNGEST_POSTGRES_MAX_OPEN_CONNS=3" "$conns_probe"
  [[ "$probe_cpu" -gt 0 && $((default_cpu * 100)) -lt $((probe_cpu * 80)) ]] \
    && record PASS "INNGEST_TICK is honoured (idle cpu 1000 ms < 80% of 150 ms)" "$default_cpu vs $probe_cpu ticks" \
    || record FAIL "INNGEST_TICK is honoured (idle cpu 1000 ms < 80% of 150 ms)" "$default_cpu vs $probe_cpu ticks"
  [[ "$conns_probe" =~ ^[0-9]+$ && "$conns_probe" -le 3 && "$conns_default" -gt 3 ]] \
    && record PASS "INNGEST_POSTGRES_MAX_OPEN_CONNS / MAX_IDLE_CONNS are honoured (sessions drop)" "$conns_default -> $conns_probe" \
    || record FAIL "INNGEST_POSTGRES_MAX_OPEN_CONNS / MAX_IDLE_CONNS are honoured (sessions drop)" "$conns_default -> $conns_probe"
  # Back to the Railway configuration.
  dc up -d --force-recreate --no-deps --wait --wait-timeout 240 inngest > "$evidence/outputs/inngest-restore.log" 2>&1
  expect_eq "inngest restored to the default configuration healthy" "$?" 0
}

step_leaks() {
  local service
  for service in postgres redis api dispatcher inngest web edge; do
    dc logs --no-color "$service" > "$evidence/logs/$service.log" 2>&1
  done
  local hits
  hits="$(grep -l -F -f <(secret_values) "$evidence/logs/"*.log "$evidence/outputs/"* "$evidence/checks.tsv" 2> /dev/null || true)"
  if [[ -n "$hits" ]]; then
    record FAIL "no secret value appears in any log or evidence file" "$(printf '%s' "$hits" | tr '\n' ' ')"
    local file
    for file in $hits; do rm -f "$file"; done
  else
    record PASS "no secret value appears in any log or evidence file (7 service logs, outputs, checks)"
  fi
}

verify_teardown() {
  local left=""
  left+="$(docker ps -a -q --filter "label=com.docker.compose.project=$project")"
  left+="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  left+="$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  if [[ -z "$left" ]]; then
    record PASS "teardown: no containers, volumes or networks left for $project"
    return 0
  fi
  record FAIL "teardown: no containers, volumes or networks left for $project" "$left"
  return 1
}

do_teardown() {
  if [[ -f "$env_file" ]]; then
    dc down -v --remove-orphans --timeout 20 > "$evidence/outputs/teardown.log" 2>&1
  else
    docker ps -a -q --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f > /dev/null 2>&1
    docker network ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker network rm > /dev/null 2>&1
    docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm > /dev/null 2>&1
  fi
  if verify_teardown; then
    rm -f "$env_file" "$credentials_file" "$release_file"
    [[ ! -e "$env_file" && ! -e "$credentials_file" ]] && record PASS "teardown: secrets env file and credentials file removed" \
      || record FAIL "teardown: secrets env file and credentials file removed"
  fi
}

write_readme() {
  {
    printf '# Local Railway-like proof\n\n'
    printf 'Candidate sha: `%s`\n\n' "$(cat "$evidence/candidate-sha.txt" 2> /dev/null)"
    printf 'Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '| Result | Check | Detail |\n|---|---|---|\n'
    awk -F'\t' '{gsub(/\|/, "\\|", $3); printf "| %s | %s | %s |\n", $1, $2, $3}' "$evidence/checks.tsv"
    printf '\nPASS %s, FAIL %s, INFO %s\n' \
      "$(grep -c '^PASS' "$evidence/checks.tsv")" "$(grep -c '^FAIL' "$evidence/checks.tsv")" "$(grep -c '^INFO' "$evidence/checks.tsv")"
  } > "$evidence/README.md"
}

cleanup_on_exit() {
  local rc=$?
  rm -f "$release_file"
  if ((partial == 0 && keep == 0 && teardown_only == 0)); then
    do_teardown
  fi
  write_readme
  printf '\nchecks=%d failures=%d (evidence: %s)\n' "$checks" "$failures" "$evidence"
  if ((failures > 0)); then exit 1; fi
  exit "$rc"
}
trap cleanup_on_exit EXIT

if ((teardown_only)); then
  do_teardown
  exit 0
fi

if ((partial)); then
  steps=("${selected_steps[@]}")
  if [[ -f "$env_file" ]]; then
    edge_port="$(load_env_value EDGE_PORT)"
    candidate_sha="$(cat "$evidence/candidate-sha.txt" 2> /dev/null || git -C "$root" rev-parse HEAD)"
  fi
else
  steps=("${all_steps[@]}")
  : > "$evidence/checks.tsv"
fi

for step in "${steps[@]}"; do
  printf '\n== step %s ==\n' "$step"
  if ! declare -F "step_$step" > /dev/null; then
    record FAIL "known step $step"
    continue
  fi
  "step_$step" || { record FAIL "step $step completed"; [[ "$step" =~ ^(preflight|build|bringup|predeploy|start)$ ]] && break; }
done
