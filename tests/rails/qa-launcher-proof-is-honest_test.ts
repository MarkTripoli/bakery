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
  assertEquals(exitTwos.length, 3, "only a host that cannot start a unit");
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
        redirect.includes("/dev/null"),
      `a write outside the output directory: ${redirect}`,
    );
  }
  assertEquals(script.includes("rm -rf"), false, "it deletes nothing");
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
