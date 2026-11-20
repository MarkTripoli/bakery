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
# Before the ledger, the summary or any step writes a line: a fresh output
# directory is the normal case, and a script that prints "No such file" on its
# first line has already taught the reader to distrust the rest of it.
mkdir -p "$outdir" || { printf '%s\n' "cannot create $outdir"; exit 2; }
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
launcher="$repo/infra/server-exec/artifact-probe.sh"
victim="$repo/scripts/qa/437-probe-victim.ts"
summary="$outdir/summary.txt"
failures=0
# --- unit ledger (tested: tests/rails/qa-launcher-proof-is-honest_test.ts) ---
# Every unit this script starts is written here, and cleanup resets whatever the
# file holds. A shell variable cannot do this job: `run_victim` is called as
# `$(run_victim ...)`, which is a subshell, so an append to a variable is lost
# when that subshell exits and the EXIT trap never learns the unit's name. A
# first version did exactly that and left a killed OOM victim and a killed
# timeout victim behind on mini1. A file is visible to the parent, the child and
# the trap alike.
unit_ledger="$outdir/started-units.txt"
: >"$unit_ledger"
record_unit() { printf '%s\n' "$1" >>"$unit_ledger"; }
reset_ledger() {
  [ -f "$unit_ledger" ] || return 0
  while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  done <"$unit_ledger"
  : >"$unit_ledger"
}
# --- end unit ledger ---

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
  reset_ledger
}
trap cleanup EXIT INT TERM

# --- worker arguments (tested) ---
# What the victim is told, per mode. The spool mode's second word is the
# DIRECTORY, not a duration: a first version forwarded the duration for every
# mode, so the worker tried to read a directory named "10" and step 5 could
# never see the fixture.
worker_args_for() { # worker_args_for <mode> <seconds> <spool dir> [outside path]
  if [ "$1" = "spool" ]; then
    if [ -n "${4:-}" ]; then
      printf '%s %s %s' "$1" "$3" "$4"
    else
      printf '%s %s' "$1" "$3"
    fi
  else
    printf '%s %s' "$1" "$2"
  fi
}
# --- end worker arguments ---

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
  record_unit "$unit"
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
      --property=MemoryMax --property=MemorySwapMax \
      --property=RuntimeMaxSec --property=RuntimeMaxUSec \
      --property=CPUQuota --property=CPUQuotaPerSecUSec --property=TasksMax \
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
  local mode=$1 seconds=${2:-120} spool=${3:-} grant=${4:-grant}
  local outside=${5:-} suffix=${6:-} id unit runtime wargs
  local write_flag="--deny-write" grant_prop=""
  # The worker that reads a spool must be ALLOWED to write it, or Deno refuses
  # the write itself and the step proves the permission flag rather than the
  # mount. The mount is what must refuse.
  if [ "$mode" = "spool" ]; then
    # Both paths, so Deno's own permission can never be the thing that refuses:
    # the only difference between the spool and the path outside it is the mount.
    write_flag="--allow-write=$spool"
    [ -n "$outside" ] && write_flag="--allow-write=$spool,$outside"
  fi
  # Word-split on purpose, and safe because the directory is one this script
  # made under the runtime directory: no spaces, no globbing characters.
  if [ -n "$spool" ] && [ "$grant" != "nogrant" ]; then
    grant_prop="--property=ReadOnlyPaths=$spool"
  fi
  wargs=$(worker_args_for "$mode" "$seconds" "$spool" "$outside")
  id=$(uuidgen | tr 'A-Z' 'a-z')
  unit="bakery-artifact-probe-$id"
  record_unit "$unit"
  # The unit's wall clock is the declared cap, always. The victim must WANT to
  # run longer than that, or it would finish on its own and the step would
  # report a success as "the time cap did nothing" -- which is exactly what a
  # first version of this did when the two were the same number.
  runtime=10
  [ "$mode" = "time" ] || seconds=10
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
    $grant_prop \
    deno run --allow-read --allow-net "$write_flag" "$victim" $wargs \
    >"$outdir/victim-$mode$suffix-stdout.txt" 2>"$outdir/victim-$mode$suffix-stderr.txt"
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
say "## step 4: the sandbox refuses a connection"
# Which property does the refusing is not this script's business: some hosts
# cannot build a network namespace and quietly skip PrivateNetwork, while
# RestrictAddressFamilies=AF_UNIX still refuses AF_INET. The unit carries both,
# the worker asks the only question with an answer, and this step reads it.
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
say "## step 5: the unit reads the spool and cannot write it"
# The spool is the one directory outside the repository the unit may read: it is
# how a blob whose store cannot hand over a path gets described. Three claims:
# the unit can read it (or a healthy file reports an unreadable one), it cannot
# write it (or a sandboxed process edits what it reads), and the refusal is the
# MOUNT rather than a dropped Deno permission -- a worker without --allow-write
# would refuse the write on a fully writable directory, which proves nothing.
#
# The directory lives under the runtime directory: outside /tmp, /var/tmp and
# $HOME (where the launcher refuses to grant), and writable by this user, which
# /var/lib is not.
spool_dir="$runtime_dir/bakery-spool-$$"
if ! mkdir -m 700 "$spool_dir" 2>"$outdir/spool-mkdir.txt"; then
  say "step 5: cannot make $spool_dir: $(cat "$outdir/spool-mkdir.txt")"
  say "result: HARNESS DEFECT — the spool directory could not be made"
  say "        (a runtime directory this user cannot write, or no XDG_RUNTIME_DIR)"
  exit 1
fi
printf 'probe-fixture-bytes\n' >"$spool_dir/probe-fixture.blob"

# The control, unsandboxed: the same worker, the same flags, the same directory.
# It must read the fixture AND write beside it. Without this, a "write-refused"
# line from the sandboxed run means whatever the reader assumes it means.
control=$(deno run --allow-read --allow-net "--allow-write=$spool_dir" \
  "$victim" spool "$spool_dir" 2>&1)
say "control (no sandbox) said:"
printf '%s\n' "$control" | sed 's/^/  /' | tee -a "$summary"
if printf '%s' "$control" | grep -q "^spool: read " &&
  printf '%s' "$control" | grep -q "^spool: wrote"; then
  record "step-5 control: an unsandboxed worker can read and write the spool" 0
else
  record "step-5 control: an unsandboxed worker can read and write the spool" 1
fi
rm -f "$spool_dir/probe-written-by-sandbox"

# A path outside the grant, in the unit's own working directory: writable by
# this user before the sandbox exists. If the sandbox cannot refuse THIS, it is
# not refusing the spool either, whatever the spool line says.
outside_probe="$runtime_dir/bakery-outside-$$"
: >"$outside_probe" 2>/dev/null || true
spool_unit=$(run_victim spool 10 "$spool_dir" grant "$outside_probe")
spool_code=$?
spool_out=$(cat "$outdir/victim-spool-stdout.txt" 2>/dev/null)
say "unit: $spool_unit"
say "spool: $spool_dir"
say "exit: $spool_code"
say "worker said:"
printf '%s\n' "$spool_out" | sed 's/^/  /' | tee -a "$summary"
if printf '%s' "$spool_out" | grep -q "^spool: read "; then
  record "step-5 the unit can read the spool" 0
else
  record "step-5 the unit can read the spool" 1
  # stderr matters here: a worker that cannot open the directory says why, and
  # that line is the difference between a broken harness and a broken sandbox.
  say "worker stderr (tail):"
  tail -5 "$outdir/victim-spool-stderr.txt" 2>/dev/null | sed 's/^/  /' | tee -a "$summary"
fi
if printf '%s' "$spool_out" | grep -q "^spool: write-refused"; then
  record "step-5 the unit cannot write the spool" 0
elif printf '%s' "$spool_out" | grep -q "^spool: wrote"; then
  # Which of two very different things happened? If a path OUTSIDE the grant is
  # writable too, this host is not enforcing read-only mounts at all -- systemd
  # skips them in a user unit it cannot set up, and says so only in the journal.
  # Then the spool claim is unmeasurable here, and calling it a harness defect
  # would hide a host that cannot host the sandbox it declares.
  if printf '%s' "$spool_out" | grep -q "^outside: wrote"; then
    say "step 5: the sandbox wrote both the spool and a path outside it"
    say "        systemd did not apply the read-only mounts in this user unit"
    record "step-5 the unit cannot write the spool (host skips read-only mounts)" 1
    rm -f "$outside_probe"
    say "result: NOT PROVEN (this host cannot enforce a read-only sandbox)"
    exit 2
  fi
  record "step-5 the unit cannot write the spool" 1
elif printf '%s' "$spool_out" | grep -q "^outside: write-refused"; then
  # Outside refused but the spool accepted: the mount works and the grant is
  # wrong, which is this script's defect and nobody else's.
  record "step-5 the unit cannot write the spool (the grant is wrong)" 1
else
  record "step-5 the unit cannot write the spool (no attempt recorded)" 1
fi
# Nothing the sandbox wrote may exist, whether it said so or not.
if [ -e "$spool_dir/probe-written-by-sandbox" ]; then
  record "step-5 nothing was written into the spool" 1
else
  record "step-5 nothing was written into the spool" 0
fi

# The real launcher, end to end: the shipped script, its own argv guard, its own
# grant, and the shipped worker. The victim above proves the mount refuses a
# write; this proves the launcher the server actually runs can read the spool it
# was told to grant, which a standalone systemd-run with copied properties cannot
# show.
spool_frame="$outdir/spool-frame.json"
printf '{"path":"%s","sizeBytes":20}' "$spool_dir/probe-fixture.blob" \
  >"$spool_frame"
deno run -A "$here/437-launcher-under-deno.ts" "$(uuidgen | tr 'A-Z' 'a-z')" \
  "$spool_frame" "$outdir/launcher-spool" "--spool-dir=$spool_dir" \
  >"$outdir/launcher-spool-console.txt" 2>&1
launcher_spool_code=$?
launcher_spool_out=$(cat "$outdir/launcher-spool-stdout.txt" 2>/dev/null)
say "real launcher with --spool-dir: exit $launcher_spool_code"
printf '%s\n' "$launcher_spool_out" | sed 's/^/  /' | tee -a "$summary"
if printf '%s' "$launcher_spool_out" | grep -q '"status":"described"' &&
  printf '%s' "$launcher_spool_out" | grep -q '"byteLength":20'; then
  record "step-5 the real launcher reads the spool through its own grant" 0
else
  record "step-5 the real launcher reads the spool through its own grant" 1
  tail -5 "$outdir/launcher-spool-stderr.txt" 2>/dev/null | sed 's/^/  /' |
    tee -a "$summary"
fi

# Diagnostic, never a claim: whether ProtectSystem=strict alone already makes the
# spool unwritable. The launcher always grants it read-only when it spools, so a
# value of "refused" here means the grant is belt and braces on this host and
# "wrote" means the grant is what refuses -- which is worth knowing, and is not
# a defect either way.
rm -f "$spool_dir/probe-written-by-sandbox"
nogrant_unit=$(run_victim spool 10 "$spool_dir" nogrant "" -nogrant)
nogrant_out=$(cat "$outdir/victim-spool-nogrant-stdout.txt" 2>/dev/null)
rm -f "$spool_dir/probe-written-by-sandbox"
say "without the grant (diagnostic, not a claim), the worker said:"
printf '%s\n' "$nogrant_out" | sed 's/^/  /' | tee -a "$summary"
rm -f "$outside_probe"
rm -rf "$spool_dir"

say "## step 6: both seals answer, through the real launcher"
# The server asks two questions before it names a file: can the unit reach the
# network, and can it write? Both are asked of the shipped launcher here, because
# a property the host silently skips is a property the server does not have, and
# only the answer says which it is.
#
# Each question is asked twice: once inside the unit, where the answer must be
# "no", and once with no sandbox at all, where the answer must be "yes". The
# second run is what makes the first mean anything. A worker started without the
# permission its question needs answers "no" on every host -- QA measured exactly
# that on mini1, both self-tests answering false with detail NotCapable -- and a
# preflight that accepted it could never fail.
worker="$repo/apps/server/src/modules/knowledge/probe-worker.ts"
for seal in network filesystem; do
  printf '{"selfTest":"%s"}' "$seal" >"$outdir/selftest-$seal.json"
  deno run -A "$here/437-launcher-under-deno.ts" "$(uuidgen | tr 'A-Z' 'a-z')" \
    "$outdir/selftest-$seal.json" "$outdir/selftest-$seal" \
    >"$outdir/selftest-$seal-console.txt" 2>&1
  seal_code=$?
  seal_out=$(cat "$outdir/selftest-$seal-stdout.txt" 2>/dev/null)
  say "$seal: exit $seal_code, answered: $seal_out"
  printf '%s\n' "$seal_out" >>"$summary"

  # The control: the same worker, the same frame, the one permission the
  # question needs, and no sandbox. It must answer "yes", or the sandboxed "no"
  # is Deno's permission check rather than the unit.
  if [ "$seal" = "network" ]; then
    control_out=$(printf '{"selfTest":"network"}' | deno run --cached-only \
      --no-prompt --deny-import --frozen "--allow-net=1.1.1.1:443" "$worker" 2>&1)
    want='"reachable":true'
    sealed='"reachable":false'
  else
    control_dir="$runtime_dir/bakery-canary-control-$$"
    mkdir -m 700 "$control_dir"
    control_out=$(cd "$control_dir" && printf '{"selfTest":"filesystem"}' |
      deno run --cached-only --no-prompt --deny-import --frozen \
        "--allow-write=$control_dir/.bakery-probe-filesystem-self-test" \
        "$worker" 2>&1)
    rm -rf "$control_dir"
    want='"writable":true'
    sealed='"writable":false'
  fi
  say "$seal control (no sandbox) said: $control_out"
  printf '%s\n' "$control_out" >>"$summary"
  if printf '%s' "$control_out" | grep -q "$want"; then
    record "step-6 the $seal control can answer yes without a sandbox" 0
  else
    record "step-6 the $seal control can answer yes without a sandbox" 1
  fi
  # A "no" that is Deno's own permission error is not a seal, and must not be
  # recorded as one.
  if printf '%s' "$seal_out" | grep -q '"detail":"NotCapable"'; then
    record "step-6 the $seal seal holds (the worker lacked the permission)" 1
  elif printf '%s' "$seal_out" | grep -q "$sealed"; then
    record "step-6 the $seal seal holds" 0
  else
    record "step-6 the $seal seal holds" 1
  fi
done

say ""
if [ "$failures" -eq 0 ]; then
  say "## result: PROVEN — $outdir holds the evidence"
  exit 0
fi
say "## result: NOT PROVEN — $failures step(s) failed, see above"
exit 1
