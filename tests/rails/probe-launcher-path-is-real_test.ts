/**
 * The launcher the server runs by default must be a file that exists (#740).
 *
 * QA's finding: `repositoryRoot` was built with four `../` from
 * `modules/knowledge/`, which lands on `apps/`, so the constant named
 * `<repo>/apps/infra/server-exec/artifact-probe.sh`. Nothing there, spawn
 * ENOENT, and `probe.ts` read that as `sandbox-unavailable` -- so in production
 * the probe could never run, and every test passed a `launcherPath` override so
 * nothing noticed. The server's `--allow-run` grant did not name the launcher
 * either, which would have failed the same way one layer later.
 */
import { assert, assertEquals } from "@std/assert";
import { SERVER_ARTIFACT_PROBE_LAUNCHER } from "../../apps/server/src/modules/knowledge/probe.ts";

const repoRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("the default launcher is the file the repository ships", async () => {
  assertEquals(
    SERVER_ARTIFACT_PROBE_LAUNCHER,
    `${repoRoot}/infra/server-exec/artifact-probe.sh`,
  );
  const info = await Deno.stat(SERVER_ARTIFACT_PROBE_LAUNCHER);
  assert(info.isFile, "the default launcher is not a file");
  // Executable, or the spawn fails for a different reason than the path.
  assert(
    (info.mode ?? 0) & 0o111,
    "the default launcher is not executable",
  );
});

Deno.test("the server's run grant names the launcher it will spawn", async () => {
  const script = await Deno.readTextFile(
    new URL("../../apps/server/scripts/run-main.sh", import.meta.url),
  );
  const grant = script.split("\n").find((line) =>
    line.startsWith("run_grant=")
  );
  assert(grant !== undefined, "run-main.sh has no run_grant");
  assert(
    grant.includes("infra/server-exec/artifact-probe.sh"),
    `the grant does not name the probe launcher: ${grant}`,
  );
  // And the launcher is not the only thing it names: the other fixed launchers
  // stay, so this rail cannot be satisfied by widening the grant to everything.
  for (const other of ["git.sh", "draft-systemd.sh", "/usr/bin/stat"]) {
    assert(grant.includes(other), `the grant lost ${other}`);
  }
});
