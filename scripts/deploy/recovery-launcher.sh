#!/usr/bin/env bash
set -euo pipefail
# The independent recovery launcher (issue #50, AC3). It recovers an
# installation whose current release is broken, without the Bakery API, without
# the UI and without any code from the broken release: it is bash, the host's
# Node (node: built-ins only), psql inside the Postgres container and the other
# host scripts in this directory. It never listens on a port.
#
#   recovery-launcher.sh diagnose [--environment <env>]
#   recovery-launcher.sh rollback --confirm <known-good commit sha> [--environment <env>]
#   recovery-launcher.sh restore <set> <age identity> --confirm <set name>
#
# diagnose   reads only: compose service states, the API's health answer, the
#            newest deployment ledger rows (bakery.deployments, straight from
#            Postgres), the restore record (bakery.installation_restores), the
#            migration ledger and the release pointer. It prints one JSON report
#            with every secret from the host env files redacted.
# rollback   switches the local release target's pointer (current.json, the
#            layout of delivery/local-release-target.ts) back to the newest
#            healthy or degraded release in the deployment ledger, after the
#            staged artifact's digest is checked, then starts the API on it.
#            The operator must type that release's commit sha. The ledger is
#            not written: a failed row is already not serving, and the newest
#            healthy or degraded row is the release the ledger says serves.
# restore    runs restore.sh (which drills, backs up, replaces the stores and
#            applies the restore fence) with the same typed confirmation.
#
# After a rollback or restore it verifies: every migration checksum recorded
# before is unchanged, core table row counts are unchanged (rollback), no
# external effect row changed (rollback) or every unsettled effect is held by a
# restore record that is still in force (restore), and the API answers healthy
# on the expected release. Then it prints the report and writes it under
# $state/deploy/recovery/.
#
# Exit 0: done and verified. 64: bad arguments. 65: confirmation missing or not
# the target's own name. 69: no known-good release to go back to. 70: the staged
# release is missing or its digest does not match. 71: recovery ran but the
# verification failed. 77: not root, or run behind an HTTP gateway.
# Any other code is the restore.sh exit code, passed through.
#
# BAKERY_BACKUP_SANDBOX is for tests only, as in restore.sh: it roots the paths
# and skips the root check, and is refused unless BAKERY_ENV=test.
if [[ -n "${GATEWAY_INTERFACE:-}${REQUEST_METHOD:-}${HTTP_HOST:-}" ]]; then
  echo "RECOVERY_LAUNCHER_REFUSES_HTTP: this runs only from a host terminal, never behind a web server." >&2
  exit 77
fi
if [[ -n "${BAKERY_BACKUP_SANDBOX:-}" ]]; then
  if [[ "${BAKERY_ENV:-}" != test ]]; then
    echo "BAKERY_BACKUP_SANDBOX is only honoured when BAKERY_ENV=test; refusing to run" >&2
    exit 64
  fi
  root=$BAKERY_BACKUP_SANDBOX/opt/bakery
  state=$BAKERY_BACKUP_SANDBOX/var/lib/bakery
  etc=$BAKERY_BACKUP_SANDBOX/etc/bakery
else
  [[ "$(id -u)" == 0 ]] || exit 77
  root=/opt/bakery
  state=/var/lib/bakery
  etc=/etc/bakery
fi
umask 077
usage="usage: recovery-launcher.sh diagnose | rollback --confirm <known-good commit sha> | restore <set> <age identity> --confirm <set name>  [--environment <env>]"
command=${1:-}
shift || true
environment=production
confirm="" set_dir="" identity="" confirm_given=false
case "$command" in
  diagnose|rollback) ;;
  restore)
    set_dir=${1:-} identity=${2:-}
    shift 2 || { echo "$usage" >&2; exit 64; }
    ;;
  *) echo "$usage" >&2; exit 64;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) confirm=${2:-}; confirm_given=true; shift 2 || shift;;
    --environment) environment=${2:-}; shift 2 || shift;;
    *) echo "$usage" >&2; exit 64;;
  esac
done
[[ "$environment" =~ ^(preview|staging|production)$ ]] || { echo "$usage" >&2; exit 64; }

target=${BAKERY_RECOVERY_TARGET:-$state/release-target}
state_file=$state/deploy/state.json
compose=(docker compose --env-file "$etc/infra.env" -f "$root/production/compose.yaml")
sql() {
  "${compose[@]}" exec -T postgres psql -U postgres -d bakery -v ON_ERROR_STOP=1 -Atq -c "$1"
}
active_slot() {
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(s.active&&s.active.slot||"blue")}catch{process.stdout.write("blue")}' "$state_file"
}
health_url() {
  local port=18000
  [[ "$(active_slot)" == blue ]] || port=18001
  printf '%s' "${BAKERY_RECOVERY_HEALTH_URL:-http://127.0.0.1:$port/health/ready}"
}
# One line of JSON from a query, or the error, so diagnose never stops early.
query_json() {
  local out
  if out=$(sql "$1" 2>&1); then printf '%s' "${out:-null}"; else node -e 'process.stdout.write(JSON.stringify({error:process.argv[1].slice(0,300)}))' "$out"; fi
}
LEDGER_SQL="select coalesce(json_agg(r order by r.created_at desc), '[]') from (select id, repository_id, environment, commit_sha, artifact_digest, status, previous_deployment_id, created_at from bakery.deployments where environment = '$environment' order by created_at desc, id desc limit 10) r"
RESTORE_SQL="select coalesce(json_agg(r order by r.restored_at desc), '[]') from (select id, backup_name, cutoff_at, restored_at, effects_held, released_at from bakery.installation_restores order by restored_at desc limit 3) r"
MIGRATIONS_SQL="select coalesce(json_object_agg(version, checksum order by version), '{}') from bakery.schema_migrations"
CORE_TABLES=(organizations principals repositories workflow_runs deployments external_effects artifact_versions)
counts_sql() {
  local parts=() table
  for table in "${CORE_TABLES[@]}"; do parts+=("'$table', (select count(*) from bakery.$table)"); done
  local IFS=,
  printf 'select json_build_object(%s)' "${parts[*]}"
}
EFFECTS_SQL="select json_build_object('byStatus', (select coalesce(json_object_agg(status, n), '{}') from (select status, count(*) n from bakery.external_effects group by status) s), 'digest', (select md5(coalesce(string_agg(id::text || ':' || status || ':' || updated_at::text, ',' order by id), '')) from bakery.external_effects), 'unsettled', (select count(*) from bakery.external_effects where status in ('prepared', 'submitted')))"

snapshot() {
  local services health
  services=$("${compose[@]}" ps --all --format json 2>&1 || true)
  health=$(curl --silent --show-error --max-time 5 "$(health_url)" 2>&1 || true)
  node --input-type=module - "$target" "$(health_url)" "$services" "$health" \
    "$(query_json "$LEDGER_SQL")" "$(query_json "$RESTORE_SQL")" \
    "$(query_json "$MIGRATIONS_SQL")" "$(query_json "$(counts_sql)")" "$(query_json "$EFFECTS_SQL")" <<'JS'
import { readFileSync } from 'node:fs';
const [target, url, services, health, ledger, restores, migrations, counts, effects] = process.argv.slice(2);
const parse = (text) => { try { return JSON.parse(text); } catch { return { error: String(text).slice(0, 300) }; } };
const lines = (text) => String(text).split('\n').filter(Boolean).map(parse);
// docker compose ps prints one object per line (or one array): keep the state only.
const listed = services.trim().startsWith('[') ? parse(services) : lines(services);
const compose = Array.isArray(listed) ? listed.map((s) => ({ service: s.Service ?? s.Name ?? null, state: s.State ?? null, health: s.Health || null })) : listed;
let pointer = null;
try { pointer = JSON.parse(readFileSync(target + '/current.json', 'utf8')); } catch { pointer = null; }
const answer = parse(health);
const report = {
  format: 1,
  at: new Date().toISOString(),
  compose,
  health: { url, ok: answer && answer.state === 'ok' && typeof answer.version === 'string', version: answer && typeof answer.version === 'string' ? answer.version : null, state: answer && typeof answer.state === 'string' ? answer.state : null, error: answer && answer.error ? answer.error : null },
  pointer: pointer && { releaseId: pointer.releaseId ?? null, commitSha: pointer.commitSha ?? null, deploymentId: pointer.deploymentId ?? null },
  ledger: parse(ledger),
  restores: parse(restores),
  migrations: parse(migrations),
  counts: parse(counts),
  effects: parse(effects),
};
process.stdout.write(JSON.stringify(report));
JS
}

# Every value of a secret-looking key in the host env files, and any password in
# a URL, is replaced before a report leaves this script.
read -r -d '' REDACT_JS <<'JS' || true
import { readFileSync, readdirSync } from 'node:fs';
const etc = process.argv[1];
const secrets = [];
let names = [];
try { names = readdirSync(etc).filter((n) => n.endsWith('.env')); } catch {}
for (const name of names) {
  let text = '';
  try { text = readFileSync(etc + '/' + name, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !/PASSWORD|SECRET|KEY|TOKEN|URL|DSN|CREDENTIAL|PRIVATE/i.test(m[1])) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 6) secrets.push(value);
  }
}
let text = readFileSync(0, 'utf8');
for (const s of secrets.sort((a, b) => b.length - a.length)) text = text.split(s).join('[redacted]');
text = text.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\/@\s"]*):[^@\s"]*@/gi, '$1:[redacted]@');
text = text.replace(/AGE-SECRET-KEY-[A-Z0-9-]+/g, '[redacted]');
process.stdout.write(text + '\n');
JS
redact() {
  node --input-type=module -e "$REDACT_JS" "$etc"
}

if [[ "$command" == diagnose ]]; then
  snapshot | redact
  exit 0
fi

# Both mutating commands need the target's own name typed.
if [[ "$command" == restore ]]; then
  if [[ ! -d "$set_dir" || ! -f "$identity" || "$confirm_given" != true ]]; then echo "$usage" >&2; exit 64; fi
  if [[ "$confirm" != "$(basename "$set_dir")" ]]; then
    echo "RECOVERY_CONFIRMATION_REQUIRED: a restore replaces the whole installation. Run it again with --confirm $(basename "$set_dir"). Nothing was changed." >&2
    exit 65
  fi
fi
before=$(snapshot)

if [[ "$command" == rollback ]]; then
  [[ "$confirm_given" == true ]] || { echo "$usage" >&2; exit 64; }
  # The known-good release: the newest healthy or degraded ledger row of the
  # repository whose newest row is the release now in trouble, other than the
  # commit the pointer serves, with its staged artifact in the target.
  plan=$(node --input-type=module - "$target" "$before" <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
const [target, snapshotText] = process.argv.slice(2);
const report = JSON.parse(snapshotText);
const rows = Array.isArray(report.ledger) ? report.ledger : [];
const fail = (code, reason) => { process.stdout.write(JSON.stringify({ code, reason })); process.exit(0); };
if (rows.length === 0) fail(69, 'the deployment ledger has no rows for this environment');
const repository = rows[0].repository_id;
const serving = report.pointer && report.pointer.commitSha;
const good = rows.find((r) => r.repository_id === repository && (r.status === 'healthy' || r.status === 'degraded') && r.commit_sha !== serving);
if (!good) fail(69, 'no healthy or degraded release other than the one serving is in the ledger');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
let release = null;
for (const name of readdirSync(target + '/releases')) {
  const file = read(target + '/releases/' + name + '/release.json');
  if (file.headSha === good.commit_sha && file.artifactDigest === good.artifact_digest) release = file;
}
if (!release) fail(70, 'the known-good release ' + good.commit_sha + ' is not staged in ' + target);
const bytes = readFileSync(target + '/releases/' + release.releaseId + '/artifact.bin');
if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== release.artifactDigest) fail(70, 'the staged artifact of ' + good.commit_sha + ' does not match its digest');
let deploymentId = 'ledger:' + good.id;
try {
  for (const name of readdirSync(target + '/deployments')) {
    const record = read(target + '/deployments/' + name);
    if (record.releaseId === release.releaseId && record.switched) deploymentId = record.deploymentId;
  }
} catch {}
process.stdout.write(JSON.stringify({ code: 0, ledgerId: good.id, pointer: { releaseId: release.releaseId, commitSha: good.commit_sha, deploymentId } }));
JS
)
  code=$(node -p 'JSON.parse(process.argv[1]).code' "$plan")
  if [[ "$code" != 0 ]]; then
    echo "RECOVERY_REFUSED: $(node -p 'JSON.parse(process.argv[1]).reason' "$plan"). Nothing was changed." >&2
    exit "$code"
  fi
  expected=$(node -p 'JSON.parse(process.argv[1]).pointer.commitSha' "$plan")
  if [[ "$confirm" != "$expected" ]]; then
    echo "RECOVERY_CONFIRMATION_REQUIRED: this switches $environment back to $expected. Run it again with --confirm $expected. Nothing was changed." >&2
    exit 65
  fi
  # Write then rename, as the target does, so a crash leaves one pointer or the other.
  node --input-type=module - "$target" "$plan" <<'JS'
import { renameSync, writeFileSync } from 'node:fs';
const [target, plan] = process.argv.slice(2);
const next = target + '/current.json.recovery-' + process.pid;
writeFileSync(next, JSON.stringify(JSON.parse(plan).pointer), { mode: 0o600 });
renameSync(next, target + '/current.json');
JS
  # A failed start must not end the run here: the pointer has already moved,
  # so the operator still needs the verification and the record below.
  set +e
  bash "$root/deploy/runtime.sh" api-start "$(active_slot)" "$expected" >&2
  api_start=$?
  set -e
else
  set +e
  bash "$root/deploy/restore.sh" "$set_dir" "$identity" --confirm "$confirm" >&2
  restored=$?
  set -e
  [[ "$restored" == 0 ]] || exit "$restored"
  expected=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).active.sha)}catch{}' "$state_file")
fi

# Verification: wait for the API to answer, then compare against the snapshot.
for attempt in $(seq 1 "${BAKERY_RECOVERY_HEALTH_TRIES:-30}"); do
  answer=$(curl --silent --max-time 5 "$(health_url)" 2>/dev/null || true)
  if node -e 'const a=JSON.parse(process.argv[1]);process.exit(a.state==="ok"&&a.version===process.argv[2]?0:1)' "$answer" "$expected" 2>/dev/null; then break; fi
  sleep 1
done
after=$(snapshot)
mkdir -p "$state/deploy/recovery"
record=$state/deploy/recovery/$(date -u +%Y%m%dT%H%M%SZ)-$command.json
set +e
node --input-type=module - "$command" "$expected" "$(basename "${set_dir:-none}")" "$before" "$after" "${api_start:-}" <<'JS' | redact | tee "$record"
const [command, expected, setName, beforeText, afterText, apiStart] = process.argv.slice(2);
const before = JSON.parse(beforeText);
const after = JSON.parse(afterText);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
if (command === 'rollback') check('api_start', apiStart === '0', { exitCode: Number(apiStart) });
check('health', after.health.ok && after.health.version === expected, { expected, observed: after.health.version });
const drifted = Object.entries(before.migrations ?? {}).filter(([v, c]) => (after.migrations ?? {})[v] !== c).map(([v]) => v);
check('migration_checksums', typeof before.migrations === 'object' && !before.migrations.error && drifted.length === 0, { drifted });
if (command === 'rollback') {
  check('core_row_counts', !before.counts.error && same(before.counts, after.counts), { before: before.counts, after: after.counts });
  check('no_external_replay', !before.effects.error && same(before.effects, after.effects), { before: before.effects.byStatus, after: after.effects.byStatus });
} else {
  const held = Array.isArray(after.restores) ? after.restores.find((r) => r.backup_name === setName && r.released_at === null) : null;
  check('restore_fence_holds', held && after.effects.unsettled === 0, { restoreId: held ? held.id : null, unsettled: after.effects.unsettled });
}
const ok = checks.every((c) => c.ok);
process.stdout.write(JSON.stringify({ format: 1, command, outcome: ok ? 'RECOVERY_VERIFIED' : 'RECOVERY_VERIFY_FAILED', expected, checks, after }));
process.exit(ok ? 0 : 71);
JS
verified=${PIPESTATUS[0]}
set -e
exit "$verified"
