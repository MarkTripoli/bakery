#!/usr/bin/env bash
# Provision one Bakery self-hosted CI runner host. Runs as root on a fresh
# Ubuntu 26.04 server. Idempotent: every step checks before it changes.
#
# Secrets arrive on stdin as KEY=value lines, never as arguments:
#   RUNNER_TOKEN=<repo registration token>   required until the runner is configured
#   TS_AUTHKEY=<tailscale auth key>          optional; skipped when absent or already joined
#
# Usage (normally via scripts/ops/ci-runner/provision.sh):
#   provision-host.sh <runner-name> <hostname> < secrets
set -euo pipefail

runner_name="${1:?Usage: provision-host.sh <runner-name> <hostname>}"
host_name="${2:?Usage: provision-host.sh <runner-name> <hostname>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
files="$here/files"

RUNNER_VERSION=2.337.0
RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
RUNNER_DIR=/opt/actions-runner
REPO_URL=https://github.com/MarkTripoli/bakery
CI_USER=ci-runner
CI_UID=1001
TS_TAG=tag:dev-machines

RUNNER_TOKEN=""
TS_AUTHKEY=""
if [ ! -t 0 ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      RUNNER_TOKEN) RUNNER_TOKEN="$value" ;;
      TS_AUTHKEY) TS_AUTHKEY="$value" ;;
    esac
  done
fi

log() { printf '== %s\n' "$*"; }
as_ci() {
  runuser -u "$CI_USER" -- env HOME=/home/$CI_USER XDG_RUNTIME_DIR=/run/user/$CI_UID \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$CI_UID/bus "$@"
}

# A busy runner's job shares this host's user manager and rootless daemon; maintenance and probes
# can disturb it (one e2e journey timed out while probes ran). Only touch idle or new hosts.
if pgrep -u $CI_USER -f "$RUNNER_DIR/bin/Runner.Worker" >/dev/null 2>&1; then
  echo "$runner_name is running a job; rerun when it is idle" >&2
  exit 1
fi

log "hostname $host_name"
[ "$(hostname)" = "$host_name" ] || hostnamectl set-hostname "$host_name"

log "apt packages"
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /etc/apt/sources.list.d/tailscale.list ]; then
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/resolute.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/resolute.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
fi
apt-get update -q
apt-get install -y -q --no-install-recommends \
  docker.io docker-compose-v2 rootlesskit slirp4netns uidmap dbus-user-session fuse-overlayfs \
  bubblewrap postgresql-client zip unzip jq git curl ca-certificates gnupg build-essential \
  nodejs xvfb sysstat tmux htop tailscale tailscale-archive-keyring \
  libicu78 libkrb5-3 liblttng-ust1t64 \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libdrm2 \
  libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libx11-6 \
  libxcb1 libpango-1.0-0 libcairo2 libasound2t64 libglib2.0-0t64 libdbus-1-3 libfontconfig1 \
  libfreetype6 fonts-liberation fonts-noto-color-emoji fonts-freefont-ttf fonts-ipafont-gothic \
  fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei xfonts-cyrillic xfonts-scalable

log "rootful docker off (no consumer; ci-runner uses its own rootless daemon)"
systemctl disable --now docker.socket docker.service containerd.service 2>/dev/null || true
# Stopping docker.socket leaves the socket inode behind; nothing listens on it, remove it.
# One captured ss result decides; an ss failure aborts (set -e) instead of looking like "no listener".
unix_listeners="$(ss -xlH)"
if ! grep -q -E ' (/var)?/run/docker\.sock ' <<<"$unix_listeners"; then
  rm -f /run/docker.sock /var/run/docker.sock
fi

log "swap 8G + swappiness"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || { fallocate -l 8G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
install -m 0644 "$files/99-ci-swap.conf" /etc/sysctl.d/99-ci-swap.conf
sysctl -q -p /etc/sysctl.d/99-ci-swap.conf

log "apparmor: userns for systemd user managers"
install -m 0644 "$files/bakery-systemd-user-userns" /etc/apparmor.d/bakery-systemd-user-userns
apparmor_parser -r -W /etc/apparmor.d/bakery-systemd-user-userns

log "user $CI_USER"
if ! id "$CI_USER" >/dev/null 2>&1; then
  useradd -m -u $CI_UID -U -s /bin/bash -K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0 "$CI_USER"
fi
chmod 0750 /home/$CI_USER
for f in /etc/subuid /etc/subgid; do
  grep -q "^$CI_USER:" "$f" || echo "$CI_USER:165536:65536" >>"$f"
done
# Isolation: refuse, rather than silently repair, an account with extra groups or sudo rights.
[ "$(id -nG "$CI_USER")" = "$CI_USER" ] || { echo "$CI_USER has extra groups: $(id -nG "$CI_USER")" >&2; exit 1; }
sudo -l -U "$CI_USER" 2>&1 | grep -q 'is not allowed to run sudo' ||
  { echo "$CI_USER has sudo rights; remove them first" >&2; exit 1; }
loginctl enable-linger "$CI_USER"
for _ in $(seq 1 30); do [ -S /run/user/$CI_UID/bus ] && break; sleep 1; done
[ -S /run/user/$CI_UID/bus ] || { echo "user bus for $CI_USER did not appear" >&2; exit 1; }
# A manager started before the profile was loaded runs unconfined-by-name; re-exec picks it up.
label="$(cat /proc/"$(systemctl show -p MainPID --value user@$CI_UID.service)"/attr/current)"
case "$label" in bakery-systemd-user-userns*) ;; *) as_ci systemctl --user daemon-reexec; sleep 2 ;; esac

log "rootless docker"
install -d -o $CI_USER -g $CI_USER /home/$CI_USER/.config /home/$CI_USER/.config/systemd \
  /home/$CI_USER/.config/systemd/user
install -m 0644 -o $CI_USER -g $CI_USER "$files/docker.service" \
  /home/$CI_USER/.config/systemd/user/docker.service
as_ci systemctl --user daemon-reload
as_ci systemctl --user enable --now docker.service
for _ in $(seq 1 30); do [ -S /run/user/$CI_UID/docker.sock ] && break; sleep 1; done
as_ci env DOCKER_HOST=unix:///run/user/$CI_UID/docker.sock docker info --format '{{.ServerVersion}} {{.SecurityOptions}}'

log "actions runner $RUNNER_VERSION -> $RUNNER_DIR"
if [ ! -x $RUNNER_DIR/config.sh ]; then
  install -d -o $CI_USER -g $CI_USER $RUNNER_DIR
  tarball=/tmp/actions-runner-$RUNNER_VERSION.tar.gz
  curl -fsSL -o "$tarball" \
    https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz
  echo "$RUNNER_SHA256  $tarball" | sha256sum -c -
  runuser -u $CI_USER -- tar -xzf "$tarball" -C $RUNNER_DIR
  rm -f "$tarball"
fi
if [ ! -f $RUNNER_DIR/.runner ]; then
  [ -n "$RUNNER_TOKEN" ] || { echo "RUNNER_TOKEN required on stdin to register" >&2; exit 1; }
  (cd $RUNNER_DIR && runuser -u $CI_USER -- env -i HOME=/home/$CI_USER LANG=en_US.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin \
    ./config.sh --unattended --url $REPO_URL --token "$RUNNER_TOKEN" --name "$runner_name" \
    --labels hetzner,amd --work _work --replace)
fi
unit="actions.runner.MarkTripoli-bakery.$runner_name.service"
[ -f /etc/systemd/system/$unit ] || (cd $RUNNER_DIR && ./svc.sh install $CI_USER)
install -d /etc/systemd/system/$unit.d
changed=0
for f in "$files"/runner-dropins/*.conf; do
  cmp -s "$f" /etc/systemd/system/$unit.d/"$(basename "$f")" || changed=1
done
# KillMode=control-group means a restart ends any in-flight job. Install changed drop-ins only
# while the runner is stopped or idle, so an interrupted run leaves them pending for the rerun.
# The idle check to restart window is not atomic: run this when the runner is idle.
if [ $changed = 1 ] && systemctl is-active --quiet $unit &&
  pgrep -u $CI_USER -f "$RUNNER_DIR/bin/Runner.Worker" >/dev/null; then
  echo "drop-ins changed but a job is running; rerun when $runner_name is idle" >&2
  exit 1
fi
for f in "$files"/runner-dropins/*.conf; do
  install -m 0644 "$f" /etc/systemd/system/$unit.d/"$(basename "$f")"
done
systemctl daemon-reload
systemctl enable $unit
if ! systemctl is-active --quiet $unit; then
  systemctl start $unit
elif [ $changed = 1 ]; then
  systemctl restart $unit
fi

log "tailscale"
if tailscale status --self >/dev/null 2>&1; then
  echo "already joined"
elif [ -n "$TS_AUTHKEY" ]; then
  systemctl enable --now tailscaled
  keyfile="$(mktemp)"
  printf '%s' "$TS_AUTHKEY" >"$keyfile"
  tailscale up --auth-key="file:$keyfile" --hostname="$host_name" --advertise-tags="$TS_TAG"
  rm -f "$keyfile"
else
  echo "skipped: no TS_AUTHKEY"
fi

log "verify"
fail=0
check() { if "${@:2}" >/dev/null 2>&1; then echo "$1=ok"; else echo "$1=FAIL"; fail=1; fi; }
check runner systemctl is-active --quiet $unit
check no_sudo sh -c "sudo -l -U $CI_USER 2>&1 | grep -q 'is not allowed to run sudo'"
check groups_only_own test "$(id -nG $CI_USER)" = "$CI_USER"
check userns_profile grep -q '^bakery-systemd-user-userns' "/proc/$(systemctl show -p MainPID --value user@$CI_UID.service)/attr/current"
check sandbox_unit as_ci systemd-run --user --wait --quiet -p PrivateUsers=yes -p PrivateNetwork=yes /usr/bin/true
check rootless_docker_run as_ci env DOCKER_HOST=unix:///run/user/$CI_UID/docker.sock docker run --rm hello-world
check no_rootful_socket sh -c "l=\$(ss -xlH) && ! printf '%s\\n' \"\$l\" | grep -q -E ' (/var)?/run/docker\\.sock ' && test ! -e /run/docker.sock && test ! -e /var/run/docker.sock"
echo "tailscale: $(tailscale status --json 2>/dev/null | jq -c '{BackendState, HostName: .Self.HostName, Tags: .Self.Tags}' || echo none)"
exit $fail
