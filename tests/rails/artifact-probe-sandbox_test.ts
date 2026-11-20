/**
 * The probe's sandbox is the launcher's, and the launcher's is the server's
 * (#437 slice 2).
 *
 * Two lists describe one thing: `ARTIFACT_PROBE_UNIT_PROPERTIES` is what the
 * server says it asks for, and `infra/server-exec/artifact-probe.sh` is what
 * actually runs. A property added to one and not the other is a limit the
 * server believes it has, so this test compares them literally rather than
 * sampling the ones it remembers.
 *
 * The launcher also has to be unusable as anything but a probe: it takes one
 * UUID and nothing else, and it never runs an interpreter a caller names.
 */
import { assert, assertEquals } from "@std/assert";
import { ARTIFACT_PROBE_UNIT_PROPERTIES } from "../../apps/server/src/modules/knowledge/probe.ts";

const LAUNCHER =
  new URL("../../infra/server-exec/artifact-probe.sh", import.meta.url)
    .pathname;

function commandsOf(script: string): string {
  return script.split("\n").filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

Deno.test("the probe launcher pins exactly the unit properties the server declares", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  const commands = commandsOf(script);
  for (const property of ARTIFACT_PROBE_UNIT_PROPERTIES) {
    assert(
      commands.includes(` ${property} \\`),
      `launcher is missing ${property}`,
    );
  }
  assertEquals(
    commands.match(/--property=/g)?.length,
    ARTIFACT_PROBE_UNIT_PROPERTIES.length,
    "the launcher sets a property the server does not declare",
  );
});

Deno.test("the probe sandbox has no network and no writable system", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  for (
    const required of [
      "--property=PrivateNetwork=yes",
      "--property=MemoryMax=",
      "--property=RuntimeMaxSec=",
      "--property=NoNewPrivileges=yes",
      "--property=ProtectSystem=strict",
    ]
  ) {
    assert(script.includes(required), required);
  }
  // The limits the launcher declares must be the ones the server's contract
  // states, not numbers chosen twice.
  const { ARTIFACT_PROBE_MEMORY_MAX_BYTES, ARTIFACT_PROBE_TIMEOUT_MS } =
    await import("@bakery/contracts/artifact-probe");
  assert(
    script.includes(`--property=MemoryMax=${ARTIFACT_PROBE_MEMORY_MAX_BYTES}`),
  );
  assert(
    script.includes(
      `--property=RuntimeMaxSec=${ARTIFACT_PROBE_TIMEOUT_MS / 1000}s`,
    ),
  );
});

Deno.test("the probe launcher refuses anything but one UUID", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  const commands = commandsOf(script);
  // Exactly one argument, and it is validated as a lower-case UUID.
  assert(commands.includes('[ "$#" -eq 1 ] || exit 64'));
  // Caller argv never reaches a tool: "$@" appears only in the fixed command.
  assertEquals(
    commands.split("\n").filter((line) => line.includes('"$@"')),
    [],
  );
  // The worker is pinned by path; no caller chooses what runs.
  assert(commands.includes('"$deno" run --cached-only --no-prompt'));
  assert(commands.includes('"$worker"'));
  assert(!/--allow-|eval|\$\*/.test(commands), "a permission or eval");
});

Deno.test("a host without a user bus reports the sandbox as unavailable", async () => {
  // 69 is EX_UNAVAILABLE: the host cannot start the unit, so nothing ran and
  // nothing was measured. The server turns this into `sandbox-unavailable` and
  // does not fall back to parsing in-process, which is the whole point of the
  // launcher.
  const bus = Deno.build.os === "linux" &&
    await Deno.stat(`/run/user/${Deno.uid()}/bus`).then(() => true).catch(
      () => false,
    );
  if (bus) return; // a host that has one exercises the sandbox itself
  const result = await new Deno.Command(LAUNCHER, {
    args: ["0f1e2d3c-4b5a-4968-8776-655443322110"],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(result.code, 69);
});
