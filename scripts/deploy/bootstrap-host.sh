#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 && "$(uname -m)" == aarch64 ]] || { echo ARM64_ROOT_REQUIRED >&2; exit 77; }
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || { echo DEBIAN_13_REQUIRED >&2; exit 78; }
public_ip= public_host= acme_email= deploy_public_key=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip) public_ip=$2;;
    --public-host) public_host=$2;;
    --acme-email) acme_email=$2;;
    --deploy-public-key) deploy_public_key=$2;;
    *) echo UNKNOWN_BOOTSTRAP_ARGUMENT >&2; exit 64;;
  esac
  shift 2
done
[[ -n "$public_ip" && -n "$public_host" && -n "$acme_email" && -f "$deploy_public_key" ]] || exit 64
repo=$(cd "$(dirname "$0")/../.." && pwd)
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends --yes ca-certificates curl unzip git bubblewrap util-linux dbus-user-session uidmap docker.io docker-compose age sudo nftables python3
systemctl enable --now docker
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
download() {
  curl --fail --location --silent --show-error "$1" -o "$temporary/$2"
  printf '%s  %s\n' "$3" "$temporary/$2" | sha256sum --check --status
}
download https://github.com/denoland/deno/releases/download/v2.9.1/deno-aarch64-unknown-linux-gnu.zip deno.zip 0a60d079fa79635a59803074dbbfe86ccc35746dc2c4f8d73f2e50338b3283a9
unzip -q "$temporary/deno.zip" -d "$temporary/deno"
install -m 0755 "$temporary/deno/deno" /usr/bin/deno
download https://nodejs.org/download/release/v22.22.0/node-v22.22.0-linux-arm64.tar.xz node.tar.xz 1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f
tar -xf "$temporary/node.tar.xz" -C "$temporary"
install -m 0755 "$temporary/node-v22.22.0-linux-arm64/bin/node" /usr/bin/node
download https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_arm64.tar.gz caddy.tar.gz d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42
tar -xzf "$temporary/caddy.tar.gz" -C "$temporary" caddy
install -m 0755 "$temporary/caddy" /usr/bin/caddy
for user in bakery-api bakery-worker bakery-migrate bakery-caddy bakery-deploy; do
  if ! id "$user" > /dev/null 2>&1; then
    useradd --system --create-home --home-dir "/home/$user" --shell /bin/bash "$user"
  fi
done
loginctl enable-linger bakery-api
api_uid=$(id -u bakery-api)
systemctl start "user@$api_uid.service"
install -d -m 0755 /opt/bakery/{deploy,releases,slots,static,production} /etc/bakery /var/lib/bakery
install -d -o root -g root -m 0700 /opt/bakery/quarantine
install -d -m 0700 /var/lib/bakery/{deploy,backups,postgres,redis}
install -d -o bakery-api -g bakery-api -m 0700 /var/lib/bakery/skills /home/bakery-api/.cache/deno
install -d -o bakery-worker -g bakery-worker -m 0700 /var/lib/bakery/worker /home/bakery-worker/.cache/deno
install -d -o bakery-migrate -g bakery-migrate -m 0700 /home/bakery-migrate/.cache/deno
install -d -o bakery-deploy -g bakery-deploy -m 0700 /var/lib/bakery/incoming
install -m 0755 "$repo"/scripts/deploy/*.sh /opt/bakery/deploy/
install -m 0644 "$repo"/scripts/deploy/*.mjs /opt/bakery/deploy/
install -m 0644 "$repo/infra/production/compose.yaml" /opt/bakery/production/compose.yaml
install -m 0755 "$repo/infra/production/001-roles.sh" /opt/bakery/production/001-roles.sh
node --input-type=module - "$public_ip" "$public_host" "$acme_email" <<'JS'
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic, renderCaddy } from '/opt/bakery/deploy/release.mjs';
const [publicIp,publicHost,acmeEmail]=process.argv.slice(2);
const config={publicIp,publicHost,acmeEmail};
renderCaddy(config,null);
const path='/etc/bakery/deployment.json';
if(existsSync(path)&&JSON.stringify(JSON.parse(readFileSync(path,'utf8')))!==JSON.stringify(config)) throw Error('EXISTING_ORIGIN_CHANGE_REFUSED');
await writeAtomic(path,JSON.stringify(config)+'\n');
const state='/var/lib/bakery/deploy/state.json';
if(!existsSync(state)) await writeAtomic(state,JSON.stringify({format:1,phase:'committed',active:null,previous:null,migrations:{}})+'\n');
if(!existsSync('/etc/bakery/Caddyfile')) await writeAtomic('/etc/bakery/Caddyfile',renderCaddy(config,null),0o644);
JS
for unit in "$repo"/infra/production/systemd/*; do
  sed "s/BAKERY_API_UID/$api_uid/g" "$unit" > "/etc/systemd/system/${unit##*/}"
done
cat > /usr/local/sbin/bakery-release <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in bootstrap|deploy|rollback|recover) ;; *) exit 64;; esac
[[ "${1:-}" != bootstrap || "${SUDO_USER:-}" != bakery-deploy ]] || exit 77
exec /usr/bin/systemd-run --wait --pipe --collect --unit="bakery-release-$(cat /proc/sys/kernel/random/uuid)" \
  --property=RuntimeMaxSec=30min --property=TimeoutStopSec=15 --property=ExecStopPost=/usr/local/sbin/bakery-recover \
  /usr/bin/flock --exclusive --timeout 300 /run/lock/bakery-deploy.lock /usr/bin/node /opt/bakery/deploy/release.mjs "$@"
SH
cat > /usr/local/sbin/bakery-recover <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/flock --exclusive --timeout 300 /run/lock/bakery-deploy.lock /usr/bin/node /opt/bakery/deploy/release.mjs recover
SH
cat > /usr/local/sbin/bakery-ssh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
read -r command sha checksum extra <<< "${SSH_ORIGINAL_COMMAND:-}"
[[ -z "$extra" ]] || exit 64
case "$command" in
  upload)
    [[ "$sha" =~ ^[a-f0-9]{40}$ && "$checksum" =~ ^[a-f0-9]{64}$ ]] || exit 64
    umask 077
    file=$(mktemp /var/lib/bakery/incoming/.pending-XXXXXXXX)
    trap 'rm -f "$file"' EXIT
    head -c 1073741824 > "$file"
    printf '%s  %s\n' "$checksum" "$file" | sha256sum --check --status
    mv -f "$file" "/var/lib/bakery/incoming/$sha.tar.gz"
    ;;
  deploy)
    [[ "$sha" =~ ^[a-f0-9]{40}$ && "$checksum" =~ ^[a-f0-9]{64}$ ]] || exit 64
    exec sudo -n /usr/local/sbin/bakery-release deploy "$sha" "$checksum";;
  rollback)
    [[ "$sha" =~ ^[a-f0-9]{40}$ && -z "$checksum" ]] || exit 64
    exec sudo -n /usr/local/sbin/bakery-release rollback "$sha";;
  recover)
    [[ -z "$sha$checksum" ]] || exit 64
    exec sudo -n /usr/local/sbin/bakery-release recover;;
  *) exit 64;;
esac
SH
chmod 0755 /usr/local/sbin/bakery-release /usr/local/sbin/bakery-ssh /usr/local/sbin/bakery-recover
printf '%s\n' 'bakery-deploy ALL=(root) NOPASSWD: /usr/local/sbin/bakery-release' > /etc/sudoers.d/bakery-deploy
chmod 0440 /etc/sudoers.d/bakery-deploy
visudo -cf /etc/sudoers.d/bakery-deploy
install -d -o bakery-deploy -g bakery-deploy -m 0700 /home/bakery-deploy/.ssh
{ printf '%s ' 'restrict,command="/usr/local/sbin/bakery-ssh"'; cat "$deploy_public_key"; } > /home/bakery-deploy/.ssh/authorized_keys
chown bakery-deploy:bakery-deploy /home/bakery-deploy/.ssh/authorized_keys
chmod 0600 /home/bakery-deploy/.ssh/authorized_keys
systemctl daemon-reload
cat > /etc/bakery/firewall.nft <<'NFT'
table inet bakery_private_tls {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname != "lo" tcp dport 8443 drop
  }
}
NFT
if nft list table inet bakery_private_tls > /dev/null 2>&1; then
  nft delete table inet bakery_private_tls
fi
nft -f /etc/bakery/firewall.nft
cat > /etc/systemd/system/bakery-firewall.service <<'UNIT'
[Unit]
Description=Bakery private Inngest TLS firewall
Before=bakery-caddy.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -ec 'if ! /usr/sbin/nft list table inet bakery_private_tls; then /usr/sbin/nft -f /etc/bakery/firewall.nft; fi'
ExecStop=/usr/sbin/nft delete table inet bakery_private_tls
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bakery-firewall
systemctl enable --now bakery-caddy
systemctl enable bakery-recover.service
printf '%s\n' 'BOOTSTRAP_COMPLETE_CONSUMERS_NOT_STARTED' 'Root must install secrets, start infrastructure, upload immutable ARM release and run native probe before promotion.'
