#!/bin/sh
# The only way the Bakery server may run the artifact probe (chapter 25 §17.6).
#
# The probe reads bytes that a person uploaded, so it may not run in the server
# process: a malformed file must cost a subprocess, not the service. This
# launcher starts the fixed probe worker in a systemd transient unit with a
# memory cap, a CPU quota, a wall-clock limit, a private network namespace and,
# where the host can apply it, a read-only view of the filesystem. It ignores its environment and every other
# argument: the only input it accepts is one lower-case UUID to name the unit,
# plus an optional `--spool-dir=<absolute path>` naming the one directory
# outside the repository the unit may read. Exit 64 on anything else.
#
# The properties below are the draft worker's, plus the ones a media parser
# needs: a private /tmp and no network at all. The unit test
# tests/unit/artifact-probe-launcher_test.ts keeps them equal to the server's
# ARTIFACT_PROBE_UNIT_PROPERTIES and treats any divergence as a defect.
#
# The worker is given exactly one permission, chosen by the question in the
# frame, and the unit is what must refuse everything else. Two shipped defects
# came from getting this wrong, both found by QA on mini1: a worker with no
# `--allow-read` answered "unreadable" for a healthy file, so the probe could
# never describe anything; and a worker with no `--allow-net`/`--allow-write`
# answered "sealed" on every host, so the preflight could never fail. A
# permission the worker lacks is not a sandbox.
#
# No systemd on this host (a container, or no user bus): exit 69
# (EX_UNAVAILABLE), which the server reports as sandbox-unavailable. The probe
# is not run in-process as a fallback, for the reason this launcher exists.
[ "$#" -eq 1 ] || [ "$#" -eq 2 ] || exit 64

h='[0-9a-f]'
case "$1" in
  $h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h) ;;
  *) exit 64 ;;
esac
unit="bakery-artifact-probe-$1"

# The spool is where the server puts one bounded copy of a blob whose store
# cannot hand over a path (S3, bytea). Granting it read-only is the difference
# between describing those bytes and reporting an unreadable file, so a spool
# this launcher cannot honestly grant is refused here rather than believed
# later: `InaccessiblePaths` wins over `ReadOnlyPaths`, and a read-only grant on
# a directory under /tmp, /var/tmp or $HOME would be a promise systemd keeps and
# still leaves unreadable.
spool_dir=""
if [ "$#" -eq 2 ]; then
  case "$2" in
    --spool-dir=/*) spool_dir=${2#--spool-dir=} ;;
    *) exit 64 ;;
  esac
  case "$spool_dir" in
    /tmp/* | /var/tmp/* | "${HOME:-/nonexistent}"/*) exit 64 ;;
  esac
  [ -d "$spool_dir" ] && [ ! -L "$spool_dir" ] || exit 64
fi

# --- worker permissions (tested: tests/rails/qa-launcher-proof-is-honest_test.ts) ---
# The self-test constants are the contracts' own, and a rail keeps them equal:
# a launcher that asked a different address than the server would answer a
# question nobody asked.
self_test_host="1.1.1.1"
self_test_port="443"
self_test_canary=".bakery-probe-filesystem-self-test"

worker_permission() { # worker_permission <frame> <repo root>
  case "$1" in
    *'"selfTest":"network"'*)
      printf '%s' "--allow-net=$self_test_host:$self_test_port"
      ;;
    *'"selfTest":"filesystem"'*)
      printf '%s' "--allow-write=$2/$self_test_canary"
      ;;
    *)
      # The path the server named, and only that path. A quote or a backslash in
      # it would make this extraction a guess, so it is refused rather than
      # half-read: the server never sends one, and a launcher that guessed would
      # be granting something nobody asked for.
      path=$(printf '%s' "$1" | sed -n 's/.*"path":"\([^"\\]*\)".*/\1/p')
      [ -n "$path" ] || return 1
      printf '%s' "--allow-read=$path"
      ;;
  esac
}
# --- end worker permissions ---

uid=$(/usr/bin/id -u) || exit 70
case "$uid" in *[!0-9]* | "") exit 70 ;; esac
# The runtime directory is the caller's when the caller set one: that is how
# systemd's own user manager finds it, and honouring it is what lets a test put
# a real socket somewhere other than /run/user/<uid>. It is only trusted when it
# is a directory this user owns, so it cannot be pointed at someone else's bus.
runtime_dir="/run/user/$uid"
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] &&
  [ -O "$XDG_RUNTIME_DIR" ]; then
  runtime_dir=$XDG_RUNTIME_DIR
fi
# Two different things, and confusing them is why this line is commented: the
# socket PATH is what -S tests, the D-Bus ADDRESS is what the child is told.
bus_path="$runtime_dir/bus"
bus="unix:path=$bus_path"

# No user bus or no systemd (a container): unavailable, not a refused probe.
# Checked before the parent's executable, because a process launched under a
# wrapper is still told the truth about the host: this host has no user bus, and
# saying so is more useful than saying "not the server".
[ -x /usr/bin/systemd-run ] && [ -x /usr/bin/systemctl ] || exit 69
[ -S "$bus_path" ] || exit 69

deno=$(/usr/bin/readlink "/proc/$PPID/exe") || exit 70
case "$deno" in /*/deno) ;; *) exit 70 ;; esac

here=$(cd "$(/usr/bin/dirname "$0")" && pwd -P) || exit 70
worker="$here/../../apps/server/src/modules/knowledge/probe-worker.ts"
[ -f "$worker" ] || exit 70
# Deno resolves a bare specifier and its lockfile from the working directory, so
# a unit that starts in $HOME cannot find either: the worker exits 226 before it
# reads a byte. The unit is pinned to the repository root. `ProtectSystem=strict`
# is declared to make that directory read-only, but a user manager that cannot
# set up the mount runs it writable and says so only in the journal, so the
# server asks a canary question rather than trusting the property.
repo_root=$(cd "$here/../.." && pwd -P) || exit 70

# `--collect` is not decoration: without it a unit that was killed for its
# memory or its wall clock stays in the user manager as a failed unit for ever,
# one per hostile upload, until someone runs `systemctl --user reset-failed`.
# The properties are accumulated rather than written as one long `exec` line so
# the spool grant can be conditional: a deployment that hands the probe a path
# in place never asks for a directory to be mounted, and an unconditional grant
# of a directory that does not exist is a unit systemd refuses to start.
set -- \
  --user \
  --pipe \
  --wait \
  --quiet \
  "--unit=$unit" \
  "--property=WorkingDirectory=$repo_root" \
  --property=MemoryMax=536870912 \
  --property=MemorySwapMax=0 \
  --property=TasksMax=32 \
  --property=CPUQuota=100% \
  --property=RuntimeMaxSec=10s \
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
  --property=InaccessiblePaths=/var/tmp
if [ -n "$spool_dir" ]; then
  set -- "$@" "--property=ReadOnlyPaths=$spool_dir"
fi

# The frame is read here, not by the worker, because the permission depends on
# the question it asks. It is then handed to the unit unchanged: the worker still
# reads its own frame, and the launcher still decides nothing about the answer.
frame=$(cat) || exit 70
permission=$(worker_permission "$frame" "$repo_root") || exit 64

printf '%s' "$frame" | /usr/bin/env -i XDG_RUNTIME_DIR="$runtime_dir" \
  DBUS_SESSION_BUS_ADDRESS="$bus" LC_ALL=C \
  /usr/bin/systemd-run --collect "$@" \
  "$deno" run --cached-only --no-prompt --deny-import --frozen \
  "$permission" "$worker"
exit $?
