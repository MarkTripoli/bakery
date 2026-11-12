#!/bin/sh
# The only way the Bakery server may use systemd for draft isolation
# (--allow-run names this path, never systemd-run, systemctl or journalctl:
# systemd-run starts any command, and systemctl can link and start any unit).
# It takes an operation and one draft job id (a lower-case UUID), ignores its
# environment and every other argument, and execs exactly one fixed command
# against the unit bakery-draft-<id>.service. Exit 64 on anything else.
#
# `run` starts the fixed draft worker module with the server's own Deno (the
# kernel's /proc link of this launcher's parent, which the server cannot
# choose) and the pinned unit properties below; the unit test
# tests/unit/server-exec-launchers_test.ts keeps them equal to the server's.
[ "$#" -ge 1 ] || exit 64
op=$1
shift


uid=$(/usr/bin/id -u) || exit 70
case "$uid" in *[!0-9]* | "") exit 70 ;; esac
runtime_dir=/run/user/$uid
bus="unix:path=$runtime_dir/bus"

h='[0-9a-f]'
unit_for() {
  case "$1" in
    $h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h) ;;
    *) exit 64 ;;
  esac
  unit="bakery-draft-$1"
}

# Every operation reaches user_exec only after its arguments are valid, so
# bad input is always 64. No systemd on this host (a container): exit 69
# (EX_UNAVAILABLE), which the server reports as host isolation unavailable.
need_systemd() {
  [ -x /usr/bin/systemd-run ] && [ -x /usr/bin/systemctl ] || exit 69
}

user_exec() {
  need_systemd
  exec /usr/bin/env -i XDG_RUNTIME_DIR="$runtime_dir" \
    DBUS_SESSION_BUS_ADDRESS="$bus" LC_ALL=C "$@"
}

case "$op" in
  run)
    [ "$#" -eq 2 ] || exit 64
    unit_for "$1"
    case "$2" in [1-9] | 1[0-9] | 2[0-9] | 30) ;; *) exit 64 ;; esac
    runtime_seconds=$2
    need_systemd
    deno=$(/usr/bin/readlink "/proc/$PPID/exe") || exit 70
    case "$deno" in /*/deno) ;; *) exit 70 ;; esac
    here=$(cd "$(/usr/bin/dirname "$0")" && pwd -P) || exit 70
    worker="$here/../../apps/server/src/modules/knowledge/draft-import-worker.ts"
    [ -f "$worker" ] || exit 70
    user_exec /usr/bin/systemd-run \
      --user \
      --pipe \
      --wait \
      --quiet \
      "--unit=$unit" \
      --property=MemoryMax=268435456 \
      --property=MemorySwapMax=0 \
      --property=TasksMax=32 \
      --property=CPUQuota=100% \
      "--property=RuntimeMaxSec=${runtime_seconds}s" \
      --property=TimeoutStopSec=100ms \
      --property=KillMode=control-group \
      --property=SendSIGKILL=yes \
      --property=OOMPolicy=kill \
      --property=PrivateNetwork=yes \
      --property=RestrictAddressFamilies=AF_UNIX \
      --property=ProtectSystem=strict \
      --property=ProtectHome=read-only \
      --property=PrivateDevices=yes \
      --property=NoNewPrivileges=yes \
      --property=LockPersonality=yes \
      --property=RestrictSUIDSGID=yes \
      --property=RemoveIPC=yes \
      --property=TemporaryFileSystem=/tmp:ro \
      --property=InaccessiblePaths=/var/tmp \
      "$deno" run --cached-only --no-prompt --deny-import --frozen "$worker"
    ;;
  kill)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user kill --kill-who=all --signal=KILL "$unit.service"
    ;;
  stop)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user stop "$unit.service"
    ;;
  reset-failed)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user reset-failed "$unit.service"
    ;;
  show-boundary)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user show "$unit.service" \
      --property=LoadState --property=ActiveState --property=ControlGroup \
      --property=MainPID
    ;;
  show-private-users)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user show "$unit.service" \
      --property=PrivateUsers --value
    ;;
  status)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/systemctl --user status "$unit.service" --no-pager \
      --lines=8 --output=short --full
    ;;
  journal)
    [ "$#" -eq 1 ] || exit 64
    unit_for "$1"
    user_exec /usr/bin/journalctl --user --unit "$unit.service" --no-pager \
      --lines 20 --output=cat
    ;;
  manager-version)
    [ "$#" -eq 0 ] || exit 64
    user_exec /usr/bin/systemctl --user show --property=Version --value
    ;;
  *)
    exit 64
    ;;
esac
