import { assertEquals } from "@std/assert";
import {
  jobCommand,
  PLUGIN_JOB_CAPABILITY,
  selectPluginRuntime,
} from "../../apps/worker/src/plugin-job-select.ts";
import type { ContainmentRuntime } from "../../apps/worker/src/plugin-job-runtime.ts";

/**
 * Which runtime a worker runs plugin jobs in, and when it runs none (#29,
 * B14.02): a runtime must be switched on AND prove its boundary on this host.
 */

function fake(name: string, supported: boolean, probed: string[]) {
  return (): ContainmentRuntime => ({
    name,
    probe: () => {
      probed.push(name);
      return Promise.resolve(
        supported
          ? { supported: true, runtime: name }
          : { supported: false, runtime: name, reason: `${name} cannot` },
      );
    },
    start: () => Promise.reject(new Error("not started in this test")),
  });
}

Deno.test("with nothing enabled no runtime is chosen and none is even probed", async () => {
  const probed: string[] = [];
  const choice = await selectPluginRuntime({}, {
    docker: fake("docker", true, probed),
    bwrap: fake("bwrap", true, probed),
  });
  assertEquals(choice.kind, "none");
  assertEquals(probed, []);
  assertEquals(
    (choice as { reasons: readonly string[] }).reasons,
    ["plugin jobs are not enabled on this worker"],
  );
});

Deno.test("an enabled runtime that proves its boundary is chosen; a disabled one is never probed", async () => {
  const probed: string[] = [];
  const choice = await selectPluginRuntime(
    { BAKERY_PLUGIN_JOBS_DOCKER: "1" },
    {
      docker: fake("docker", true, probed),
      bwrap: fake("bwrap", true, probed),
    },
  );
  assertEquals(choice.kind, "selected");
  assertEquals(
    (choice as { runtime: ContainmentRuntime }).runtime.name,
    "docker",
  );
  assertEquals(probed, ["docker"]);
});

Deno.test("docker is tried before bubblewrap, and a failed probe falls through to the next", async () => {
  const probed: string[] = [];
  const choice = await selectPluginRuntime(
    { BAKERY_PLUGIN_JOBS_DOCKER: "1", BAKERY_PLUGIN_JOBS_BWRAP: "1" },
    {
      docker: fake("docker", false, probed),
      bwrap: fake("bwrap", true, probed),
    },
  );
  assertEquals(
    (choice as { runtime: ContainmentRuntime }).runtime.name,
    "bwrap",
  );
  assertEquals(probed, ["docker", "bwrap"]);
});

Deno.test("when every enabled runtime fails its probe none is chosen and each reason is kept", async () => {
  const probed: string[] = [];
  const choice = await selectPluginRuntime(
    { BAKERY_PLUGIN_JOBS_DOCKER: "1", BAKERY_PLUGIN_JOBS_BWRAP: "1" },
    {
      docker: fake("docker", false, probed),
      bwrap: fake("bwrap", false, probed),
    },
  );
  assertEquals(choice.kind, "none");
  assertEquals(
    (choice as { reasons: readonly string[] }).reasons,
    ["docker: docker cannot", "bwrap: bwrap cannot"],
  );
});

Deno.test("only the exact flag value 1 enables a runtime", async () => {
  for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
    const probed: string[] = [];
    const choice = await selectPluginRuntime(
      { BAKERY_PLUGIN_JOBS_DOCKER: value },
      { docker: fake("docker", true, probed) },
    );
    assertEquals(choice.kind, "none", JSON.stringify(value));
    assertEquals(probed, []);
  }
});

Deno.test("the job command is the configured runner, or a locked-down deno, then the entry under /code", () => {
  assertEquals(jobCommand({}, "jobs/a.js"), [
    "deno",
    "run",
    "--no-prompt",
    "--no-remote",
    "/code/jobs/a.js",
  ]);
  assertEquals(
    jobCommand({ BAKERY_PLUGIN_JOB_COMMAND: "node  --check" }, "x.js"),
    ["node", "--check", "/code/x.js"],
  );
  assertEquals(
    jobCommand({ BAKERY_PLUGIN_JOB_COMMAND: "   " }, "x.js")[0],
    "deno",
  );
});

Deno.test("the capability a worker advertises is the one the action requires", async () => {
  const transport = JSON.parse(
    await Deno.readTextFile("docs/technical-design/transport-schemas.json"),
  );
  assertEquals(
    transport.workerActions["plugin.job"].capabilities,
    [PLUGIN_JOB_CAPABILITY],
  );
});
