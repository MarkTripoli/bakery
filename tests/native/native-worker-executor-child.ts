import {
  createNativeExecutor,
  type NativeActionDefinition,
} from "../../apps/worker/src/executor.ts";
import type { NativeOutputSink } from "../../apps/worker/src/native-output.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";

const [cgroupRoot, stateDir, markerPath, crashWindow] = Deno.args;
if (!cgroupRoot || !stateDir || !markerPath) {
  throw new Error("NATIVE_CHILD_ARGUMENTS_REQUIRED");
}

const pauseAtCrashWindow = async (phase: string): Promise<void> => {
  await Deno.writeTextFile(
    markerPath,
    JSON.stringify({ phase, pid: Deno.pid }),
  );
  await new Promise(() => undefined);
};

const script = crashWindow === "after-remove" ? "Deno.exit(0);" : [
  "await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({ pid: Deno.pid })));",
  "await new Promise(() => {});",
].join("\n");
const action: NativeActionDefinition = {
  action: "harness.implement",
  executable: Deno.execPath(),
  args: ["eval", script],
};
const executor = createNativeExecutor({
  cgroupRoot,
  stateDir,
  actions: [action],
  terminationGraceMs: 600,
  probeIntervalMs: 10,
  testHooks: crashWindow === "after-create"
    ? { afterCgroupCreated: () => pauseAtCrashWindow("after-create") }
    : crashWindow === "after-remove"
    ? { afterCgroupRemoved: () => pauseAtCrashWindow("after-remove") }
    : undefined,
});
const output: NativeOutputSink = {
  async write(channel, chunk) {
    if (channel === "stdout") await Deno.writeFile(markerPath, chunk);
  },
  sourceLost() {
    return Promise.resolve();
  },
};
await executor.execute(
  localAssignment(),
  new AbortController().signal,
  output,
);
