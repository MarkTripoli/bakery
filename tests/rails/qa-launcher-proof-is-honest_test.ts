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
const code = script.split("\n").filter((line) =>
  !line.trimStart().startsWith("#")
).join("\n");

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

Deno.test("the proof cleans up after itself and stays in its own directory", () => {
  assert(code.includes("trap cleanup EXIT"), "every unit is cleaned up");
  assert(code.includes("reset-failed"), "failed units do not accumulate");
  // Every write goes through $outdir; a bare redirect to a fixed path would
  // leave files behind wherever QA happened to run it.
  const redirects = code.match(/>\s*"?[^"$\s&>]+/g) ?? [];
  for (const redirect of redirects) {
    assert(
      redirect.includes("$outdir") || redirect.includes("$summary") ||
        redirect.includes("/dev/null"),
      `a write outside the output directory: ${redirect}`,
    );
  }
  assertEquals(code.includes("rm -rf"), false, "it deletes nothing");
});
