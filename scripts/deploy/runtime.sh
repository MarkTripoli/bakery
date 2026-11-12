#!/usr/bin/env bash
set -euo pipefail

probe_release_environment() {
  local sha=${1:?sha required}
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || return 64
  export BAKERY_VERSION=$sha BAKERY_SENTRY_RELEASE="bakery@$sha"
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
root=/opt/bakery
state=/var/lib/bakery
action=${1:?action required}
shift

api_environment() {
  export HOME=/home/bakery-api DENO_DIR=/home/bakery-api/.cache/deno
  local uid
  uid=$(id -u bakery-api)
  export XDG_RUNTIME_DIR="/run/user/$uid"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
}

case "$action" in
  api)
    slot=${1:?slot required}
    [[ "$slot" == blue || "$slot" == green ]] || exit 64
    api_environment
    cd "$root/slots/$slot/apps/server"
    exec bash scripts/run-main.sh
    ;;
  dispatch)
    api_environment
    cd "$root/background/apps/server"
    exec deno run --allow-env "--allow-run=$root/background/infra/server-exec/dispatch.sh" scripts/run-dispatch.ts
    ;;
  worker)
    export HOME=/home/bakery-worker
    membership=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
    [[ "$membership" == */supervisor ]] || { echo DELEGATE_SUBGROUP_REQUIRED >&2; exit 78; }
    export BAKERY_WORKER_CGROUP_ROOT="/sys/fs/cgroup${membership%/supervisor}"
    test -w "$BAKERY_WORKER_CGROUP_ROOT/cgroup.subtree_control"
    printf '%s\n' '+pids +memory' > "$BAKERY_WORKER_CGROUP_ROOT/cgroup.subtree_control"
    cd "$root/background/apps/worker"
    exec bash scripts/run-worker.sh
    ;;
  worker-probe)
    sha=${1:?sha required}
    probe_release_environment "$sha"
    export HOME=/home/bakery-worker
    membership=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
    [[ "$membership" == */supervisor ]] || exit 78
    export BAKERY_WORKER_CGROUP_ROOT="/sys/fs/cgroup${membership%/supervisor}"
    printf '%s\n' '+pids +memory' > "$BAKERY_WORKER_CGROUP_ROOT/cgroup.subtree_control"
    export BAKERY_WORKER_STATE_DIR
    BAKERY_WORKER_STATE_DIR=$(mktemp -d /var/lib/bakery/worker/.probe-XXXXXXXX)
    trap 'rm -rf "$BAKERY_WORKER_STATE_DIR"' EXIT
    cd "$root/releases/$sha/apps/worker"
    mapfile -t grants < <(deno run --allow-env scripts/worker-permissions.ts)
    [[ ${#grants[@]} == 5 ]] || exit 78
    deno run --no-prompt --preload=src/cgroup-permission-preload.ts --allow-env \
      "--allow-read=${grants[0]}" "--allow-write=${grants[1]}" "--allow-net=${grants[2]}" \
      "--allow-run=${grants[3]}" "--allow-sys=${grants[4]}" ../../scripts/deploy/probe-native.mjs worker
    ;;
esac

[[ "$action" != worker-probe ]] || exit 0

[[ "$(id -u)" == 0 ]] || { echo ROOT_REQUIRED >&2; exit 77; }
compose=(docker compose --env-file /etc/bakery/infra.env -f "$root/production/compose.yaml")
valid_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
link_release() {
  local target=$1 path=$2
  ln -sfnT "$target" "$path.next"
  mv -Tf "$path.next" "$path"
}
stop_worker() {
  if systemctl is-active --quiet bakery-worker; then
    systemctl stop bakery-worker
  elif [[ -L "$root/background" ]]; then
    [[ "$(systemctl show bakery-worker --property=Result --value)" == success ]] || {
      echo WORKER_QUIESCENCE_UNCONFIRMED >&2
      exit 78
    }
  else
    return
  fi
  node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
const launch = readFileSync('/etc/bakery/worker-launch.env', 'utf8').trim().split('=')[1];
const receipt = JSON.parse(readFileSync('/var/lib/bakery/worker/shutdown-complete.json', 'utf8'));
if (receipt.event !== 'bakery.worker.shutdown-complete.v1' || receipt.launchId !== launch || receipt.signal !== 'SIGTERM' || receipt.outcome !== 'drained') throw Error('WORKER_QUIESCENCE_UNCONFIRMED');
JS
}

case "$action" in
  prepare)
    sha=${1:?sha required}
    checksum=${2:?checksum required}
    valid_sha "$sha" || exit 64
    release="$root/releases/$sha"
    node --input-type=module - "$sha" "$checksum" <<'JS'
import { prepareRelease } from '/opt/bakery/deploy/release.mjs';
const [sha, checksum] = process.argv.slice(2);
await prepareRelease({sha, checksum, incoming:'/var/lib/bakery/incoming',quarantine:'/opt/bakery/quarantine',releases:'/opt/bakery/releases'});
JS
    export HOME=/home/bakery-api DENO_DIR=/home/bakery-api/.cache/deno
    (cd "$release" && runuser --preserve-environment -u bakery-api -- deno cache --frozen --node-modules-dir=manual apps/server/src/main.ts apps/server/src/dispatch.ts apps/server/src/modules/knowledge/draft-import-worker.ts)
    export HOME=/home/bakery-worker DENO_DIR=/home/bakery-worker/.cache/deno
    (cd "$release" && runuser --preserve-environment -u bakery-worker -- deno cache --frozen --node-modules-dir=manual apps/worker/src/main.ts)
    node --input-type=module - "$release" <<'JS'
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { digest, writeAtomic } from '/opt/bakery/deploy/release.mjs';
const source=process.argv[2], data=JSON.parse(readFileSync(join(source,'release.json'),'utf8'));
for (const [path, expected] of Object.entries(data.assets)) {
  const dest=join('/opt/bakery/static',path);
  if (existsSync(dest)) {if(digest(readFileSync(dest))!==expected) throw Error('IMMUTABLE_ASSET_COLLISION');}
  else {mkdirSync(dirname(dest),{recursive:true,mode:0o755});await writeAtomic(dest,readFileSync(join(source,'apps/web/dist',path)),0o644);}
}
JS
    ;;
  api-start)
    slot=${1:?slot required} sha=${2:?sha required}
    [[ "$slot" == blue || "$slot" == green ]] || exit 64
    valid_sha "$sha" || exit 64
    systemctl stop "bakery-api@$slot"
    link_release "$root/releases/$sha" "$root/slots/$slot"
    port=18000
    [[ "$slot" == blue ]] || port=18001
    printf '%s\n' "BAKERY_SERVER_PORT=$port" "BAKERY_VERSION=$sha" "BAKERY_SENTRY_RELEASE=bakery@$sha" > "/etc/bakery/$slot.env"
    systemctl start "bakery-api@$slot"
    ;;
  api-stop)
    [[ "${1:-}" == blue || "${1:-}" == green ]] || exit 64
    systemctl stop "bakery-api@$1"
    ;;
  proxy)
    [[ "${1:-}" == /etc/bakery/Caddyfile.next ]] || exit 64
    caddy validate --config "$1" --adapter caddyfile
    cp /etc/bakery/Caddyfile /etc/bakery/Caddyfile.previous
    mv -f "$1" /etc/bakery/Caddyfile
    if ! caddy reload --config /etc/bakery/Caddyfile --adapter caddyfile --address unix//run/bakery-caddy/admin.sock; then
      mv -f /etc/bakery/Caddyfile.previous /etc/bakery/Caddyfile
      caddy reload --config /etc/bakery/Caddyfile --adapter caddyfile --address unix//run/bakery-caddy/admin.sock
      exit 1
    fi
    ;;
  migrate)
    sha=${1:?sha required}
    valid_sha "$sha" || exit 64
    set -a
    source /etc/bakery/owner.env
    set +a
    export HOME=/home/bakery-migrate DENO_DIR=/home/bakery-migrate/.cache/deno
    cd "$root/releases/$sha/apps/server"
    runuser --preserve-environment -u bakery-migrate -- deno run --no-prompt --allow-env --allow-net --allow-read=src/platform/migrations,src/modules/auth/migrations,src/modules/work/migrations,src/modules/projects/migrations,src/modules/agents/migrations,src/modules/repository-rules/migrations,src/modules/integrations/migrations,src/modules/delivery/migrations src/tasks.ts migrate
    ;;
  background)
    sha=${1:?sha required}
    stop_worker
    systemctl stop bakery-dispatch
    if [[ "$sha" == stop ]]; then exit 0; fi
    valid_sha "$sha" || exit 64
    link_release "$root/releases/$sha" "$root/background"
    printf '%s\n' "BAKERY_VERSION=$sha" "BAKERY_SENTRY_RELEASE=bakery@$sha" > /etc/bakery/background.env
    printf 'BAKERY_WORKER_LAUNCH_ID=%s\n' "$(cat /proc/sys/kernel/random/uuid)" > /etc/bakery/worker-launch.env
    rm -f "$state/worker/shutdown-complete.json"
    systemctl start bakery-dispatch bakery-worker
    ;;
  background-check)
    systemctl is-active --quiet bakery-dispatch bakery-worker
    public_ip=$(node -p 'JSON.parse(require("fs").readFileSync("/etc/bakery/deployment.json")).publicIp')
    curl --fail --silent --show-error --max-time 10 "https://$public_ip:8443/health" > /dev/null
    for attempt in $(seq 1 30); do
    identity=$(node - <<'JS'
const fs=require('node:fs');
const data=JSON.parse(fs.readFileSync('/var/lib/bakery/worker/registration.json','utf8'));
const {workerHostId:id,workerSessionId:session,workerSessionGeneration:generation}=data;
if(!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9-]{36}$/.test(session)||!/^[1-9][0-9]*$/.test(generation)) process.exit(1);
console.log([id,session,generation].join(' '));
JS
    ) || { sleep 1; continue; }
      read -r host_id session_id generation <<< "$identity"
      if "${compose[@]}" exec -T postgres psql -U postgres -d bakery -Atqc "select exists (select 1 from bakery.worker_hosts where id='$host_id' and worker_session_id='$session_id' and worker_session_generation=$generation and status='online' and desired_mode='accepting' and architecture='arm64' and archived_at is null and last_heartbeat_at > now() - interval '30 seconds')" | grep -qx t; then
        exit 0
      fi
      sleep 1
    done
    exit 1
    ;;
  infrastructure)
    "${compose[@]}" up --detach --wait postgres redis
    ;;
  services)
    "${compose[@]}" up --detach --wait inngest
    ;;
  boot-background)
    sha=${1:?sha required}
    valid_sha "$sha" || exit 64
    for unit in bakery-worker bakery-dispatch; do
      ! systemctl is-active --quiet "$unit" || exit 78
      group=$(systemctl show "$unit" --property=ControlGroup --value)
      if [[ -n "$group" && -f "/sys/fs/cgroup$group/cgroup.events" ]]; then
        grep -qx 'populated 0' "/sys/fs/cgroup$group/cgroup.events" || exit 78
      fi
    done
    "${compose[@]}" up --detach --wait inngest
    link_release "$root/releases/$sha" "$root/background"
    printf '%s\n' "BAKERY_VERSION=$sha" "BAKERY_SENTRY_RELEASE=bakery@$sha" > /etc/bakery/background.env
    printf 'BAKERY_WORKER_LAUNCH_ID=%s\n' "$(cat /proc/sys/kernel/random/uuid)" > /etc/bakery/worker-launch.env
    rm -f "$state/worker/shutdown-complete.json"
    systemctl start bakery-dispatch bakery-worker
    ;;
  probe)
    sha=${1:?sha required}
    valid_sha "$sha" || exit 64
    api_environment
    (cd "$root/releases/$sha" && runuser --preserve-environment -u bakery-api -- deno run --no-prompt --allow-env --allow-read "--allow-run=$root/releases/$sha/infra/server-exec/draft-systemd.sh" --allow-sys=uid scripts/deploy/probe-native.mjs api)
    systemd-run --wait --pipe --collect --unit="bakery-native-probe-$(cat /proc/sys/kernel/random/uuid)" \
      --property=User=bakery-worker --property=Group=bakery-worker --property='Delegate=memory pids' \
      --property=DelegateSubgroup=supervisor --property=EnvironmentFile=/etc/bakery/worker.env \
      "$root/deploy/runtime.sh" worker-probe "$sha"
    ;;
  backup)
    exec bash "$root/deploy/backup.sh"
    ;;
  *) echo UNKNOWN_DEPLOY_ACTION >&2; exit 64 ;;
esac
