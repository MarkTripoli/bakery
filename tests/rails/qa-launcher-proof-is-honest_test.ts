/**
 * QA's sandbox proof is a script, so it is tested like one (#437 slice 2).
 *
 * `scripts/qa/437-launcher-proof.sh` runs on a host I do not control, as a
 * person who should not have to debug it. Two mistakes would waste that time:
 * a step that reports success when the host did nothing, and a script that
 * touches anything outside its output directory. Both are checked here by
 * reading the script, because this host has no user bus to run it on.
 */
import { assert, assertEquals } from "@std/assert";
import {
  ARTIFACT_PROBE_MEMORY_MAX_BYTES,
  ARTIFACT_PROBE_TIMEOUT_MS,
} from "@bakery/contracts/artifact-probe";

const script = await Deno.readTextFile(
  new URL("../../scripts/qa/437-launcher-proof.sh", import.meta.url),
);
// `code` is the script with comments stripped, for assertions about commands.
// Structural assertions (markers, file names) read `script` itself: the markers
// are comments, and a slice of `code` would silently be empty.
const code = script.split("\n").filter((line) =>
  !line.trimStart().startsWith("#")
)
  // Inline comments go too: `has_seconds_cap() { # <show output> <seconds> }`
  // otherwise reads as a redirect once quotes and prose are in the same line.
  .map((line) => line.replace(/\s+#.*$/, ""))
  .join("\n");

Deno.test("the proof is honest about a host that cannot run the sandbox", () => {
  // No bus is NOT PROVEN and exit 2, never a pass and never a silent zero.
  assert(code.includes('[ ! -S "$bus" ]'), "the bus is checked");
  assert(code.includes("NOT PROVEN"), "it can say so");
  assert(
    /exit 2/.test(code.slice(code.indexOf("NOT PROVEN"))),
    "an unprovable host exits non-zero",
  );
  // A step that fails must make the whole run fail.
  assert(code.includes("failures=$((failures + 1))"));
  assert(/if \[ "\$failures" -eq 0 \]/.test(code));
});

Deno.test("every claim is decided by what the unit reported, not by the run finishing", () => {
  // The memory step wants systemd's OOM verdict or a kernel line.
  assert(code.includes("oom-kill"), "systemd's oom-kill is accepted");
  assert(code.includes("journalctl"), "the kernel's view is consulted");
  // The time step wants Result=timeout specifically; being killed by the
  // harness's own `timeout` would not prove RuntimeMaxSec.
  assert(code.includes('timeout) record "step-3 time cap ended the worker" 0'));
  // The network step fails on a successful connection, not on a missing one.
  assert(code.includes("network: connected"));
});

Deno.test("the proof reads the property names the host actually reports", async () => {
  // systemd 261 shows `RuntimeMaxUSec=10s` for a unit that asked for
  // `RuntimeMaxSec=10s`, and `CPUQuotaPerSecUSec=1s` for `CPUQuota=100%`. A
  // proof matching one spelling can never go green everywhere, and this is not
  // a theoretical worry: it is how the first real run failed, on a host whose
  // unit had every cap set.
  const matching = script.slice(
    script.indexOf("# --- property matching"),
    script.indexOf("# --- end property matching ---"),
  );
  assert(matching.includes("RuntimeMax(Sec|USec)="), "both time-cap spellings");
  assert(
    matching.includes("CPUQuota(PerSecUSec)?"),
    "both CPU-quota spellings",
  );
  // And the helpers are exercised rather than trusted: run them against the two
  // shapes, in sh, with the block lifted out of the script.
  const dir = await Deno.makeTempDir({ prefix: "bakery-qa-matching-" });
  const probe = `${dir}/probe.sh`;
  await Deno.writeTextFile(
    probe,
    `${matching}
has_seconds_cap "$1" 10s && echo time-ok || echo time-no
has_seconds_cap "$1" 30s && echo wrong-value-ok || echo wrong-value-no
has_cpu_cap "$1" && echo cpu-ok || echo cpu-no
has_exact "$1" PrivateNetwork yes && echo net-ok || echo net-no
`,
  );
  const run = async (sample: string): Promise<string[]> => {
    const out = await new Deno.Command("/bin/sh", {
      args: [probe, sample],
    }).output();
    return new TextDecoder().decode(out.stdout).trim().split("\n");
  };
  // The 261 shape.
  assertEquals(
    await run(
      "MemoryMax=536870912\nRuntimeMaxUSec=10s\nCPUQuotaPerSecUSec=1s\nPrivateNetwork=yes",
    ),
    ["time-ok", "wrong-value-no", "cpu-ok", "net-ok"],
  );
  // The older shape, and a unit with the cap genuinely missing.
  assertEquals(
    await run("RuntimeMaxSec=10s\nCPUQuota=100%\nPrivateNetwork=yes"),
    ["time-ok", "wrong-value-no", "cpu-ok", "net-ok"],
  );
  assertEquals(
    await run("RuntimeMaxUSec=infinity\nPrivateNetwork=yes"),
    ["time-no", "wrong-value-no", "cpu-no", "net-ok"],
  );
});

Deno.test("a defect in the proof is never reported as a limit of the host", () => {
  // The first real run exited 2 "this host cannot host the sandbox" while the
  // host had started the unit with every cap set. A harness bug dressed as a
  // host limit sends the next person to the wrong machine.
  assert(code.includes("HARNESS DEFECT"), "a caps mismatch says so");
  const harnessDefect = code.slice(code.indexOf("HARNESS DEFECT"));
  assert(/exit 1/.test(harnessDefect.slice(0, 400)), "and exits 1, not 2");
  // Only a host that cannot start a unit exits 2.
  const exitTwos = script.split("\n").filter((line) =>
    /^\s*exit 2\s*$/.test(line)
  );
  // No bus, an unaskable manager, and a unit whose namespaces could not be
  // built. Nothing else: a caps mismatch is a defect in this script, and
  // reporting it as a host limit is what sent the first real run looking at the
  // wrong machine.
  // No bus, an unaskable manager, a unit whose namespaces could not be built,
  // and a host that cannot enforce a read-only sandbox. Each is a fact about the
  // machine. A step that cannot make its own fixture, or that mislabels what it
  // observed, is a defect in this script and exits 1.
  assertEquals(exitTwos.length, 4, "only a host that cannot host the sandbox");
});

Deno.test("the worker is told where the spool is, not how long to run", async () => {
  // Step 5 ran with the duration in the spool's place, so the worker tried to
  // read a directory named "10" and the fixture was never seen. The mapping is
  // a function now, lifted out of the script and run here for both modes.
  const block = script.slice(
    script.indexOf("# --- worker arguments"),
    script.indexOf("# --- end worker arguments ---"),
  );
  const driver = await Deno.makeTempFile({ prefix: "bakery-qa-wargs-" });
  await Deno.writeTextFile(
    driver,
    `${block}
printf '%s|%s\n' "$(worker_args_for spool 10 /run/user/1000/spool)" "$(worker_args_for time 120 '')"
printf 'outside:%s\n' "$(worker_args_for spool 10 /run/user/1000/spool /run/user/1000/out)"
`,
  );
  const result = await new Deno.Command("/bin/sh", { args: [driver] }).output();
  assertEquals(
    new TextDecoder().decode(result.stdout).trim().split("\n"),
    [
      "spool /run/user/1000/spool|time 120",
      // The path outside the grant travels with it: both are needed to tell a
      // skipped read-only mount from a broken grant.
      "outside:spool /run/user/1000/spool /run/user/1000/out",
    ],
  );
});

Deno.test("the spool worker refuses on the mount, not on its own permissions", async () => {
  // QA's finding: the sandboxed worker said "NotCapable" because it had no
  // --allow-write at all, and the identical unsandboxed worker said the same
  // thing. A permission flag is not a sandbox. Both halves are run here: given
  // the write permission the worker writes, and given only read it cannot -- so
  // a refusal inside the unit can only come from the mount.
  const dir = await Deno.makeTempDir({ prefix: "bakery-qa-spool-" });
  await Deno.writeTextFile(
    `${dir}/probe-fixture.blob`,
    "probe-fixture-bytes\n",
  );
  const victim =
    new URL("../../scripts/qa/437-probe-victim.ts", import.meta.url)
      .pathname;
  const run = async (args: string[]) => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...args, victim, "spool", dir],
    }).output();
    return new TextDecoder().decode(out.stdout);
  };
  const permitted = await run(["--allow-read", `--allow-write=${dir}`]);
  assertEquals(permitted.includes("spool: read 20 bytes"), true, permitted);
  assertEquals(permitted.includes("spool: wrote"), true, permitted);
  await Deno.remove(`${dir}/probe-written-by-sandbox`).catch(() => {});
  const denied = await run(["--allow-read"]);
  assertEquals(denied.includes("spool: read 20 bytes"), true, denied);
  assertEquals(denied.includes("spool: write-refused"), true, denied);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("step 5 runs the launcher the server ships, not a copy of it", () => {
  // QA's gap: the spool step used a standalone systemd-run with the launcher's
  // properties copied in, so the launcher's own argv guard and grant were never
  // exercised end to end. The step now sends a real probe frame through the real
  // script, with the spool directory on its command line.
  assert(
    script.includes('"$here/437-launcher-under-deno.ts"'),
    "step 5 goes through the launcher's deno parent",
  );
  assert(
    script.includes('"--spool-dir=$spool_dir"'),
    "step 5 hands the launcher the spool directory",
  );
  assert(
    script.includes('"$outdir/launcher-spool"'),
    "the launcher's own output is kept, not the victim's",
  );
  // And the two spool runs must not overwrite each other: the grant run's lines
  // are the evidence, and a later diagnostic run must not erase them.
  assert(
    script.includes("victim-spool-nogrant-stdout.txt"),
    "the no-grant run writes its own files",
  );
});

Deno.test("the shipped worker can read a real file with the launcher's flags", async () => {
  // QA's finding: the launcher ran the worker with no `--allow-read`, so the
  // shipped probe answered "unreadable" for a healthy file, with or without a
  // sandbox. The probe had never described anything end to end. This runs the
  // real worker with the flags the launcher derives from a real frame, on a real
  // file, and requires a description.
  const launcher = await Deno.readTextFile(
    new URL("../../infra/server-exec/artifact-probe.sh", import.meta.url),
  );
  const block = launcher.slice(
    launcher.indexOf("# --- worker permissions"),
    launcher.indexOf("# --- end worker permissions ---"),
  );
  const dir = await Deno.makeTempDir({ prefix: "bakery-qa-worker-" });
  const file = `${dir}/fixture.blob`;
  await Deno.writeTextFile(file, "probe-fixture-bytes\n");
  const frame = JSON.stringify({ path: file, sizeBytes: 20 });
  const driver = await Deno.makeTempFile({ prefix: "bakery-qa-perm-" });
  await Deno.writeTextFile(
    driver,
    `${block}
worker_permission '${frame}' '${dir}'
`,
  );
  const permission = new TextDecoder().decode(
    (await new Deno.Command("/bin/sh", { args: [driver] }).output()).stdout,
  ).trim();
  assertEquals(permission, `--allow-read=${file}`);
  const worker = new URL(
    "../../apps/server/src/modules/knowledge/probe-worker.ts",
    import.meta.url,
  ).pathname;
  const run = async (args: string[]) => {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--no-prompt",
        "--deny-import",
        "--frozen",
        ...args,
        worker,
      ],
      stdin: "piped",
      stdout: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(frame));
    await writer.close();
    const out = await new Response(child.stdout).text();
    await child.status;
    return out;
  };
  const described = await run([permission]);
  assertEquals(described.includes('"status":"described"'), true, described);
  assertEquals(described.includes('"byteLength":20'), true, described);
  // And without it, the defect QA found: the same worker cannot read the file.
  const refused = await run([]);
  assertEquals(refused.includes('"code":"unreadable"'), true, refused);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("the launcher asks the same questions the contracts declare", async () => {
  const launcher = await Deno.readTextFile(
    new URL("../../infra/server-exec/artifact-probe.sh", import.meta.url),
  );
  const contracts = await Deno.readTextFile(
    new URL("../../packages/contracts/src/artifact-probe.ts", import.meta.url),
  );
  for (
    const [name, value] of [
      ["self_test_host", "1.1.1.1"],
      ["self_test_port", "443"],
      ["self_test_canary", ".bakery-probe-filesystem-self-test"],
    ]
  ) {
    assert(launcher.includes(`${name}="${value}"`), `${name} is ${value}`);
    // The port is a number in the contracts, the rest are strings.
    assert(
      contracts.includes(`"${value}"`) || contracts.includes(`= ${value};`),
      `contracts declare ${value}`,
    );
  }
});

Deno.test("both seals are asked of the real launcher", () => {
  assert(script.includes("for seal in network filesystem; do"));
  assert(script.includes('"$outdir/selftest-$seal.json"'));
  assert(script.includes('"reachable":false'));
  assert(script.includes('"writable":false'));
});

Deno.test("a unit recorded from a subshell is still cleaned up", async () => {
  // The first green run on mini1 left two killed units behind: `run_victim` is
  // called as `$(run_victim ...)`, so its append to a shell variable was lost
  // when the subshell exited, and the EXIT trap never learned the unit's name.
  // The ledger is a file for exactly this reason, and this test runs the real
  // functions from the script against a fake `systemctl` to prove it.
  const ledger = script.slice(
    script.indexOf("# --- unit ledger"),
    script.indexOf("# --- end unit ledger ---"),
  );
  assert(ledger.includes("record_unit"), "the ledger has a recorder");
  assert(ledger.includes("reset_ledger"), "and a resetter");
  const dir = await Deno.makeTempDir({ prefix: "bakery-qa-ledger-" });
  const calls = `${dir}/calls.txt`;
  await Deno.writeTextFile(
    `${dir}/systemctl`,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${calls}"\nexit 0\n`,
  );
  await Deno.chmod(`${dir}/systemctl`, 0o755);
  const driver = `${dir}/driver.sh`;
  await Deno.writeTextFile(
    driver,
    `outdir=${dir}
failures=0
${ledger}
# Exactly the call shape that leaked: a subshell whose appends vanish.
name=$(record_unit bakery-artifact-probe-aaa && printf 'bakery-artifact-probe-aaa')
record_unit bakery-artifact-probe-bbb
reset_ledger
printf 'remaining=%s\\n' "$(wc -l <"$unit_ledger" | tr -d ' ')"
`,
  );
  const result = await new Deno.Command("/bin/sh", {
    args: [driver],
    env: { PATH: `${dir}:/usr/bin:/bin` },
  }).output();
  const out = new TextDecoder().decode(result.stdout);
  const recorded = await Deno.readTextFile(calls);
  assertEquals(result.code, 0, out);
  assertEquals(
    recorded.split("\n").filter((line) =>
      line.startsWith("--user reset-failed")
    ),
    [
      "--user reset-failed bakery-artifact-probe-aaa",
      "--user reset-failed bakery-artifact-probe-bbb",
    ].sort(),
    "both units are reset, including the one recorded inside a subshell",
  );
  assertEquals(out.includes("remaining=0"), true, "the ledger is emptied");
});

Deno.test("the proof keeps its unit names where a subshell cannot lose them", () => {
  // The bug was a shell variable appended to inside `$(run_victim ...)`. Reading
  // the script text is the cheap half; the test above runs the mechanism.
  assert(!script.includes("started_units"), "no shell-variable ledger");
  assert(script.includes('unit_ledger="$outdir/started-units.txt"'));
  assert(/cleanup\(\) \{[\s\S]{0,80}reset_ledger/.test(script));
  assert(script.includes("trap cleanup EXIT"));
});

Deno.test("every file the proof tells you to look at is a file it writes", () => {
  // The first real run said "see launch-unit.txt" and no such file existed; the
  // file is launcher-unit.txt. A reader chasing a missing artefact is exactly
  // the cost this script exists to avoid.
  const informed = script.split("\n").filter((line) => line.includes("outdir/"))
    .join("\n");
  assert(!script.includes("launch-unit.txt"), "no stale file name");
  for (
    const name of [
      "summary.txt",
      "launcher-unit.txt",
      "unit-properties.txt",
      "launcher-stdout.txt",
      "launcher-stderr.txt",
      "frame.json",
    ]
  ) {
    assert(informed.includes(name), `never written: ${name}`);
  }
});

Deno.test("the proof cleans up after itself and stays in its own directory", () => {
  assert(script.includes("trap cleanup EXIT"), "every unit is cleaned up");
  assert(script.includes("reset-failed"), "failed units do not accumulate");
  // Every redirect target is under $outdir, which is the only directory the
  // script may write to. Redirects into a name built at run time are checked by
  // their prefix, which is where the safety lives anyway.
  // `code` has comments stripped, inline ones included: an inline comment is
  // prose, and `<seconds>` in prose is not a redirect.
  const redirects = code.split("\n")
    .flatMap((line) => line.match(/>>?\s*(?!&)\S+/g) ?? []);
  for (const redirect of redirects) {
    assert(
      redirect.includes("$outdir") || redirect.includes("$summary") ||
        // The unit ledger is `$outdir/started-units.txt` behind a variable, so
        // it is checked by the variable rather than by the path.
        redirect.includes("$unit_ledger") || redirect.includes("/dev/null") ||
        // The spool fixture is the one deliberate write outside the output
        // directory: the sandbox may only be granted a directory that is not
        // under /tmp, /var/tmp or $HOME. It is allowed here and pinned below.
        redirect.includes("$spool_dir") ||
        redirect.includes("$outside_probe") ||
        redirect.includes("$spool_frame") || redirect.includes("$outdir"),
      `a write outside the output directory: ${redirect}`,
    );
  }
  // The one directory outside the output directory it writes to is the spool
  // fixture, and it must be a place the launcher will grant, then be removed.
  // Under the runtime directory: writable by this user (which /var/lib is not)
  // and outside /tmp, /var/tmp and $HOME, where the launcher refuses to grant.
  assert(
    script.includes('spool_dir="$runtime_dir/bakery-spool-$$"'),
    "the spool fixture avoids /tmp, /var/tmp and $HOME",
  );
  assert(
    !script.includes("TMPDIR"),
    "no fallback to a directory the user may not own",
  );
  assertEquals(
    script.includes('rm -rf "$spool_dir"'),
    true,
    "the spool fixture is removed, not left in the host",
  );
  // Nothing else is deleted: the spool fixture and the canary control's own
  // directory, both of which this script made.
  assertEquals(
    code.split("\n").filter((line) => line.includes("rm -rf")).length,
    2,
  );
});

Deno.test("the caps it claims are the caps the server declares", () => {
  // Compared with the contract's own values, not with numbers retyped here: a
  // proof that checked different numbers than the launcher sets would pass
  // while the launcher is wrong.
  assert(
    code.includes(`expected_memory=${ARTIFACT_PROBE_MEMORY_MAX_BYTES}`),
    "the memory cap the proof checks is the declared one",
  );
  assert(
    code.includes(`expected_runtime=${ARTIFACT_PROBE_TIMEOUT_MS / 1000}s`),
    "the time cap the proof checks is the declared one",
  );
  // And the unit it starts for the misbehaving worker uses the same cap, or the
  // worker would be killed by a number nothing declares.
  assert(
    code.includes(`--property=MemoryMax=${ARTIFACT_PROBE_MEMORY_MAX_BYTES}`),
  );
});
