#!/bin/sh
# The only way the Bakery server may run the artifact probe (chapter 25 §17.6).
#
# The probe reads bytes that a person uploaded, so it may not run in the server
# process: a malformed file must cost a subprocess, not the service. This
# launcher starts the fixed probe worker in a systemd transient unit with a
# memory cap, a CPU quota, a wall-clock limit, a private network namespace and a
# read-only view of the filesystem. It ignores its environment and every other
# argument: the only input it accepts is one lower-case UUID to name the unit.
# Exit 64 on anything else.
#
# The properties below are the draft worker's, plus the ones a media parser
# needs: a private /tmp and no network at all. The unit test
# tests/unit/artifact-probe-launcher_test.ts keeps them equal to the server's
# ARTIFACT_PROBE_UNIT_PROPERTIES and treats any divergence as a defect.
#
# No systemd on this host (a container, or no user bus): exit 69
# (EX_UNAVAILABLE), which the server reports as sandbox-unavailable. The probe
# is not run in-process as a fallback, for the reason this launcher exists.
[ "$#" -eq 1 ] || exit 64

h='[0-9a-f]'
case "$1" in
  $h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h) ;;
  *) exit 64 ;;
esac
unit="bakery-artifact-probe-$1"

uid=$(/usr/bin/id -u) || exit 70
case "$uid" in *[!0-9]* | "") exit 70 ;; esac
runtime_dir=/run/user/$uid
bus="unix:path=$runtime_dir/bus"

# No user bus or no systemd (a container): unavailable, not a refused probe.
# Checked before the parent's executable, because a process launched under a
# wrapper is still told the truth about the host: this host has no user bus, and
# saying so is more useful than saying "not the server".
[ -x /usr/bin/systemd-run ] && [ -x /usr/bin/systemctl ] || exit 69
[ -S "$bus" ] || exit 69

deno=$(/usr/bin/readlink "/proc/$PPID/exe") || exit 70
case "$deno" in /*/deno) ;; *) exit 70 ;; esac

here=$(cd "$(/usr/bin/dirname "$0")" && pwd -P) || exit 70
worker="$here/../../apps/server/src/modules/knowledge/probe-worker.ts"
[ -f "$worker" ] || exit 70

exec /usr/bin/env -i XDG_RUNTIME_DIR="$runtime_dir" \
  DBUS_SESSION_BUS_ADDRESS="$bus" LC_ALL=C \
  /usr/bin/systemd-run \
  --user \
  --pipe \
  --wait \
  --quiet \
  "--unit=$unit" \
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
  --property=InaccessiblePaths=/var/tmp \
  "$deno" run --cached-only --no-prompt --deny-import --frozen "$worker"
