#!/bin/bash
# Proves, on one host, that the artifact probe's sandbox is real (#437 slice 2).
#
# The rails prove the launcher *says* the right things. Only a host that can
# start the unit can prove the kernel and systemd agree, so this script does
# that and writes what it saw. It is QA's command, not a load test: each step
# starts one transient unit, misbehaves in one named way, and records what ended
# it.
#
# Writes into <outdir>, and touches nothing else. Every unit it starts is named
# `bakery-artifact-probe-<uuid>` and killed at the end, even on a failed step.
# Running it twice is safe: it reuses <outdir> and overwrites its own files.
#
#   scripts/qa/437-launcher-proof.sh [outdir]     (default: ./437-launcher-proof)
#
# Exit 0 means every step proved what it claims. Exit 1 means at least one did
# not, and summary.txt says which. Exit 2 means this host cannot start a user
# unit at all, which is not a defect in the probe but does mean nothing here
# was proven — the script says so instead of failing quietly.
set -u

outdir="${1:-./437-launcher-proof}"
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
launcher="$repo/infra/server-exec/artifact-probe.sh"
victim="$repo/scripts/qa/437-probe-victim.ts"
summary="$outdir/summary.txt"
failures=0
started_units=""

mkdir -p "$outdir" || exit 2
: >"$summary"

say() {
  printf '%s\n' "$*" | tee -a "$summary"
}

# record <label> <exit code>: one line per claim, and a failure counter that
# the final result is decided by.
record() {
  printf '%s\t%s\n' "$1" "$2" >>"$summary"
  [ "$2" -eq 0 ] || failures=$((failures + 1))
}

uid=$(id -u)
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$uid}
bus="$runtime_dir/bus"

cleanup() {
  for unit in $started_units; do
    systemctl --user reset-failed "$unit" >/dev/null 2>&1
  done
}
trap cleanup EXIT INT TERM

# --- property matching (tested: tests/rails/qa-launcher-proof-is-honest_test.ts) ---
# systemd renames properties in `systemctl show` output, and the renaming is
# invisible in the unit file: a unit asks for `RuntimeMaxSec=10s` and shows
# `RuntimeMaxUSec=10s`, and `CPUQuota=100%` shows as `CPUQuotaPerSecUSec=1s`.
# A proof that matched only one spelling could never go green on every host, so
# every check below accepts both and the tests pin that it does.
has_seconds_cap() { # has_seconds_cap <show output> <seconds>
  printf '%s\n' "$1" | grep -Eq "^RuntimeMax(Sec|USec)=$2$"
}

has_cpu_cap() { # has_cpu_cap <show output>: a CPU quota in either spelling
  printf '%s\n' "$1" | grep -Eq "^CPUQuota(PerSecUSec)?=(1s|1000000|100%)$"
}

has_exact() { # has_exact <show output> <property> <value>
  printf '%s\n' "$1" | grep -Eq "^$2=$3$"
}
# --- end property matching ---

say "# artifact probe launcher proof"
say "host: $(uname -srm)"
say "when: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "user unit bus: $bus"
say "launcher: $launcher"
say ""

# Step 0: this host can start a user unit at all.
if [ ! -S "$bus" ]; then
  say "step 0: cannot start a user unit: no bus at $bus"
  say "result: NOT PROVEN (this host cannot host the sandbox; run this on a host with a user bus)"
  exit 2
fi
if ! systemctl --user show --property=Version --value >/dev/null 2>&1; then
  say "step 0: cannot talk to the user manager"
  say "result: NOT PROVEN"
  exit 2
fi
say "systemd version: $(systemctl --user show --property=Version --value)"
record "step-0 user manager reachable" 0

# The probe's own launcher, given the UUID it expects, must start a unit whose
# properties are the ones the server declares and must say so in the unit file.
step_launcher() {
  local id unit code
  id=$(uuidgen | tr 'A-Z' 'a-z')
  unit="bakery-artifact-probe-$id"
  started_units="$started_units $unit"
  printf '%s' '{"path":"/dev/null","sizeBytes":0}' >"$outdir/frame.json"

  # The launcher runs under a deno parent, because that is the only parent it
  # will accept: a shell would get exit 70 and prove nothing about the sandbox.
  # The unit is sampled WHILE it runs, because systemd removes a transient unit
  # that exits successfully -- asking afterwards returns default values, which is
  # how a proof can report MemoryMax=infinity and look finished.
  deno run -A "$repo/scripts/qa/437-launcher-under-deno.ts" "$id" \
    "$outdir/frame.json" "$outdir/launcher" \
    >"$outdir/launcher-run.txt" 2>&1 &
  local runner=$!
  : >"$outdir/unit-properties.txt"
  local waited=0
  while kill -0 "$runner" 2>/dev/null && [ "$waited" -lt 200 ]; do
    systemctl --user show "$unit.service" \
      --property=LoadState --property=ActiveState --property=Result \
      --property=WorkingDirectory \
      --property=MemoryMax --property=MemorySwapMax \\
      --property=RuntimeMaxSec --property=RuntimeMaxUSec \\
      --property=CPUQuota --property=CPUQuotaPerSecUSec --property=TasksMax \\
      --property=PrivateNetwork \
      --property=NoNewPrivileges --property=ProtectSystem --property=KillMode \
      --property=OOMPolicy --property=IPAddressDeny 2>/dev/null \
      | grep -v '^$' >>"$outdir/unit-properties.txt"
    sleep 0.05
    waited=$((waited + 1))
  done
  wait "$runner"
  code=$?
  {
    printf 'unit: %s\nlauncher exit: %s\n\n' "$unit" "$code"
    printf -- '--- last sample of the live unit ---\n'
    tail -14 "$outdir/unit-properties.txt"
    printf -- '--- launcher stderr ---\n'
    tail -5 "$outdir/launcher-stderr.txt" 2>/dev/null
    printf -- '--- worker frame ---\n'
    cat "$outdir/launcher-stdout.txt" 2>/dev/null
  } >"$outdir/launcher-unit.txt"

  if [ "$code" -eq 69 ]; then
    say "step 1: launcher reported the host cannot start the unit (69)"
    record "step-1 launcher could start its unit" 1
    return 1
  fi
  if [ "$code" -ne 0 ]; then
    say "step 1: launcher exited $code (see launcher-unit.txt)"
    # 226 is NAMESPACE and 218 is the device-manager equivalent: systemd could
    # not build the unit's namespaces, so the unit never ran. That is a property
    # of the host, not of the probe, and it is NOT the same answer as "the caps
    # were missing" -- it means nothing here can be proven at all.
    case "$code" in
      218 | 226)
        say "step 1: systemd could not set up the unit's namespaces on this host"
        say "        (journal: systemctl --user status bakery-artifact-probe-*.service)"
        say "result: NOT PROVEN (this host cannot host the sandbox)"
        record "step-1 launcher could start its unit" 1
        exit 2
        ;;
    esac
    record "step-1 launcher could start its unit" 1
    return 1
  fi
  record "step-1 launcher could start its unit" 0

  # The caps the server declares, checked against what systemd was actually
  # told. A unit that runs uncapped is worse than no unit: it would make the
  # server believe a stranger's file cannot hurt it.
  local props ok=0 missing=""
  props=$(cat "$outdir/unit-properties.txt")
  local expected_memory=536870912
  local expected_runtime=10s
  has_exact "$props" MemoryMax "$expected_memory" || { ok=1; missing="$missing MemoryMax"; }
  has_seconds_cap "$props" "$expected_runtime" || { ok=1; missing="$missing RuntimeMax"; }
  has_cpu_cap "$props" || { ok=1; missing="$missing CPUQuota"; }
  has_exact "$props" PrivateNetwork yes || { ok=1; missing="$missing PrivateNetwork"; }
  has_exact "$props" NoNewPrivileges yes || { ok=1; missing="$missing NoNewPrivileges"; }
  has_exact "$props" WorkingDirectory "$repo" || { ok=1; missing="$missing WorkingDirectory"; }
  record "step-1 unit carried MemoryMax/RuntimeMax/CPUQuota/PrivateNetwork/NoNewPrivileges/WorkingDirectory" "$ok"
  if [ "$ok" -ne 0 ]; then
    say "step 1: the live unit was missing:$missing (see launcher-unit.txt)"
    say "        This is a defect in this script or in the launcher, not a limit of the host:"
    say "        the unit started, so the host can host the sandbox."
    say "result: HARNESS DEFECT — the caps were not observed, so nothing here is proven"
    exit 1
  fi

  # Saying a property and enforcing it are different claims, and this host shows
  # why: systemd accepted PrivateNetwork=yes here and then logged 'proceeding
  # without' because the user manager could not create the namespace. The
  # declaration is checked above; the enforcement is step 4, and only step 4 can
  # fail in the direction that matters.
  if grep -qi "proceeding without" "$outdir/unit-properties.txt" \
    "$outdir/launcher-stderr.txt" 2>/dev/null; then
    say "step 1: systemd warned it is proceeding WITHOUT a sandbox property"
    record "step-1 systemd did not degrade silently" 1
  else
    record "step-1 systemd did not degrade silently" 0
  fi
  return "$ok"
}

# Runs the victim module in a transient unit with the probe's own properties.
# It uses the same systemd-run flags as the launcher rather than the launcher
# itself, because the launcher runs the real probe and the real probe does not
# eat memory.
run_victim() {
  local mode=$1 seconds=${2:-120} id unit runtime
  id=$(uuidgen | tr 'A-Z' 'a-z')
  unit="bakery-artifact-probe-$id"
  started_units="$started_units $unit"
  runtime=10
  [ "$mode" = "time" ] && runtime=$seconds
  timeout $((runtime + 30)) systemd-run --user --pipe --wait --quiet \
    "--unit=$unit" \
    "--property=WorkingDirectory=$repo" \
    --property=MemoryMax=536870912 \
    --property=MemorySwapMax=0 \
    --property=TasksMax=32 \
    --property=CPUQuota=100% \
    "--property=RuntimeMaxSec=${runtime}s" \
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
    deno run --allow-read --allow-net "$victim" "$mode" "$seconds" >"$outdir/victim-$mode-stdout.txt" 2>"$outdir/victim-$mode-stderr.txt"
  local code=$?
  {
    printf 'unit: %s\nmode: %s\nexit: %s\n\n' "$unit" "$mode" "$code"
    systemctl --user show "$unit.service" --property=Id --property=Result \
      --property=ActiveState --property=MemoryMax \
      --property=RuntimeMaxSec --property=RuntimeMaxUSec \
      --property=CPUQuota --property=CPUQuotaPerSecUSec \
      --property=PrivateNetwork 2>&1
    printf '\n--- stdout (tail) ---\n'
    tail -5 "$outdir/victim-$mode-stdout.txt" 2>/dev/null
    printf '\n--- stderr (tail) ---\n'
    tail -5 "$outdir/victim-$mode-stderr.txt" 2>/dev/null
  } >"$outdir/victim-$mode.txt"
  printf '%s' "$unit"
  return "$code"
}

say ""
say "## step 1: the probe launcher starts a unit with the declared caps"
if step_launcher; then
  say "step 1: PASS (see launcher-unit.txt, unit-properties.txt)"
else
  say "step 1: FAIL (see launcher-unit.txt)"
  say ""
  say "## result: HARNESS DEFECT — the unit did not carry the declared caps"
  exit 1
fi

say ""
say "## step 2: the memory cap ends a worker that eats memory"
mem_unit=$(run_victim memory)
mem_code=$?
mem_result=$(systemctl --user show "$mem_unit.service" --property=Result --value 2>/dev/null)
oom_line=$(journalctl --user --unit "$mem_unit.service" --no-pager \
  --lines 50 --output=cat 2>/dev/null | grep -ciE "oom|memory" || true)
say "unit: $mem_unit"
say "result: ${mem_result:-unknown}   (want: oom-kill or signal)"
say "memory lines in journal: $oom_line"
# Either systemd reports it as killed by the OOM policy, or the kernel said so.
case "$mem_result" in
  oom-kill | signal) record "step-2 memory cap ended the worker" 0 ;;
  *)
    if [ "$oom_line" -gt 0 ]; then
      record "step-2 memory cap ended the worker (kernel OOM line)" 0
    else
      record "step-2 memory cap ended the worker" 1
    fi
    ;;
esac

say ""
say "## step 3: the time cap ends a worker that will not finish"
time_unit=$(run_victim time 120)
time_code=$?
time_result=$(systemctl --user show "$time_unit.service" --property=Result --value 2>/dev/null)
say "unit: $time_unit"
say "result: ${time_result:-unknown}   (want: timeout)"
say "exit: $time_code"
case "$time_result" in
  timeout) record "step-3 time cap ended the worker" 0 ;;
  # A wall-clock kill from outside is still the cap doing its job, but
  # RuntimeMaxSec is what the unit promised, so only that counts here.
  *) record "step-3 time cap ended the worker" 1 ;;
esac

say ""
say "## step 4: the private network refuses a connection"
net_unit=$(run_victim network)
net_code=$?
net_result=$(systemctl --user show "$net_unit.service" --property=Result --value 2>/dev/null)
net_out=$(cat "$outdir/victim-network-stdout.txt" 2>/dev/null)
say "unit: $net_unit"
say "result: ${net_result:-unknown}"
say "exit: $net_code"
say "worker said:"
printf '%s\n' "$net_out" | sed 's/^/  /' | tee -a "$summary"
# A connection that succeeded would say "connected" or "http 200"; either means
# the namespace is not closed and the worker reached the network.
if printf '%s' "$net_out" | grep -qE "network: connected|network: http 2"; then
  record "step-4 network denied" 1
elif printf '%s' "$net_out" | grep -q "^network: refused"; then
  record "step-4 network denied" 0
else
  record "step-4 network denied (no attempt recorded)" 1
fi

say ""
if [ "$failures" -eq 0 ]; then
  say "## result: PROVEN — $outdir holds the evidence"
  exit 0
fi
say "## result: NOT PROVEN — $failures step(s) failed, see above"
exit 1
