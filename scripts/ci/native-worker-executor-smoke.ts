import {
  createNativeExecutor,
  type ExecutionOutcome,
} from "../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

const [cgroupRoot, stateDir] = Deno.args;
if (!cgroupRoot || !stateDir) {
  throw new Error("NATIVE_CHILD_SMOKE_ARGS_INVALID");
}

const descendantScript = [
  "const descendant = new Deno.Command(Deno.execPath(), {",
  'args: ["eval", "setInterval(() => {}, 1000);"],',
  'detached: true, stdout: "null", stderr: "null"}).spawn();',
  "await new Promise(() => {});",
].join("\n");

const executor = createNativeExecutor({
  cgroupRoot,
  stateDir,
  actions: [{
    action: "harness.smoke",
    executable: Deno.execPath(),
    args: ["eval", descendantScript],
  }],
  terminationGraceMs: 2_000,
  probeIntervalMs: 25,
});
await executor.initialize?.();

const controller = new AbortController();
const execution = executor.execute(
  {
    action: "harness.smoke",
    attemptId: crypto.randomUUID(),
    fence: 1,
    skillRefs: [],
  } as unknown as JobAssignment,
  controller.signal,
);
setTimeout(() => controller.abort(), 1_000);
const outcome: ExecutionOutcome = await execution;
if (outcome.status !== "canceled") {
  throw new Error("NATIVE_CHILD_CLEANUP_UNEXPECTED_OUTCOME");
}
const cancellation = outcome.cancellation as Record<string, unknown>;
if (
  cancellation.cleanupStatus !== "complete" ||
  cancellation.terminationStatus !== "confirmed"
) {
  const identity = cancellation.executionIdentity as
    | Record<string, unknown>
    | undefined;
  const cgroupPath = identity?.cgroupPath;
  const evidence = typeof cgroupPath === "string"
    ? await Promise.all([
      Deno.readTextFile(`${cgroupPath}/cgroup.events`).catch(() => ""),
      Deno.readTextFile(`${cgroupPath}/cgroup.procs`).catch(() => ""),
    ])
    : ["", ""];
  throw new Error(
    `NATIVE_CHILD_CLEANUP_FAILED:${
      JSON.stringify({
        cancellation,
        cgroupEvents: evidence[0],
        cgroupProcs: evidence[1],
      })
    }`,
  );
}
const events = await Deno.readTextFile(`${cgroupRoot}/cgroup.events`);
if (!events.split("\n").includes("populated 0")) {
  throw new Error("NATIVE_CHILD_DESCENDANT_REMAINS");
}
console.log("NATIVE_CHILD_CLEANUP_CONFIRMED");
Deno.exit(0);
