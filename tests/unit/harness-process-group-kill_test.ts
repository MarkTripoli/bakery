import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import {
  harnessCanceledOutcome,
  harnessTeardownFault,
  killHarnessProcessGroup,
  runBoundedHarness,
  spawnHarnessProcess,
} from "../../apps/worker/src/harness-common.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

const BOUNDED_HEARTBEAT =
  'i=0; while [ $i -lt 300 ]; do date +%s%N >> "$BEAT"; i=$((i+1)); sleep 0.1; done';

async function beatLines(path: string): Promise<number> {
  try {
    return (await Deno.readTextFile(path)).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the heartbeat wrote a line, so slow runners do not race the kill. */
async function waitForBeat(beat: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await beatLines(beat) === 0) await sleep(50);
}

/** The heartbeat must be stopped at call time: sample, wait, sample again. */
async function assertHeartbeatStopped(beat: string): Promise<void> {
  await sleep(100);
  const first = await beatLines(beat);
  await sleep(600);
  assertEquals(await beatLines(beat), first, "grandchild still beating");
}

/** Best-effort cleanup: the script records its group leader pid beside the beat file. */
async function killLeftoverHeartbeat(beat: string): Promise<void> {
  try {
    const pgid = (await Deno.readTextFile(`${beat}.pgid`)).trim();
    await new Deno.Command("/usr/bin/kill", {
      args: ["-s", "KILL", "--", `-${pgid}`],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Already gone or never started.
  }
}

async function detachedScript(): Promise<
  { dir: string; beat: string; script: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-group-kill-" });
  const beat = join(dir, "beat");
  const script =
    `BEAT=${beat}; echo $$ > ${beat}.pgid; ( ${BOUNDED_HEARTBEAT} ) >/dev/null 2>&1 &\nexec sleep 30`;
  return { dir, beat, script };
}

// ExecutionOutcome carries loosely typed objects; narrow them once here.
type OutcomeLike = { status: string; cancellation?: unknown; fault?: unknown };
function cancellation(outcome: OutcomeLike) {
  return outcome.cancellation as {
    processExited: boolean;
    terminationStatus: string;
  };
}
function faultOf(outcome: OutcomeLike) {
  return outcome.fault as { code: string; retryable: boolean };
}

const OPTIONS = { sanitizeResources: false, sanitizeOps: false } as const;

Deno.test({
  name: "attached grandchild dies with the awaited group kill",
  ...OPTIONS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "bakery-group-kill-" });
    const beat = join(dir, "beat");
    try {
      const child = await spawnHarnessProcess({
        executable: "/bin/sh",
        args: [
          "-c",
          `BEAT=${beat}; echo $$ > ${beat}.pgid; ( ${BOUNDED_HEARTBEAT} ) &\nsleep 30`,
        ],
        cwd: dir,
        environment: { HOME: dir },
      });
      await waitForBeat(beat);
      assert(await beatLines(beat) > 0, "heartbeat never started");
      const started = Date.now();
      const teardown = await killHarnessProcessGroup(child);
      assertEquals(teardown.status, "confirmed");
      await child.status;
      assert(Date.now() - started < 5_000);
      await assertHeartbeatStopped(beat);
    } finally {
      await killLeftoverHeartbeat(beat);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

for (const trigger of ["timeout", "abort"] as const) {
  Deno.test({
    name: `detached grandchild is already stopped when ${trigger} returns`,
    ...OPTIONS,
    fn: async () => {
      const { dir, beat, script } = await detachedScript();
      const controller = new AbortController();
      try {
        const started = Date.now();
        const pending = runBoundedHarness({
          executable: "/bin/sh",
          args: ["-c", script],
          cwd: dir,
          prompt: "",
          timeLimitMs: trigger === "timeout" ? 500 : 30_000,
          signal: controller.signal,
          environment: { HOME: dir },
        });
        if (trigger === "abort") {
          await waitForBeat(beat);
          controller.abort();
        }
        const run = await pending;
        assert(Date.now() - started < 5_000);
        assertEquals(run.timedOut, trigger === "timeout");
        assert(run.teardown !== "not-needed");
        assertEquals(run.teardown.status, "confirmed");
        assert(await beatLines(beat) > 0, "heartbeat never started");
        await assertHeartbeatStopped(beat);
      } finally {
        await killLeftoverHeartbeat(beat);
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "missing group-kill helper reports unconfirmed and still stops the child",
  ...OPTIONS,
  fn: async () => {
    const { dir, beat, script } = await detachedScript();
    const controller = new AbortController();
    try {
      const started = Date.now();
      const pending = runBoundedHarness({
        executable: "/bin/sh",
        args: ["-c", script],
        cwd: dir,
        prompt: "",
        timeLimitMs: 30_000,
        signal: controller.signal,
        groupKillExecutable: "/nonexistent/kill",
        environment: { HOME: dir },
      });
      await waitForBeat(beat);
      controller.abort();
      const run = await pending;
      assert(Date.now() - started < 5_000);
      assert(run.teardown !== "not-needed");
      assertEquals(run.teardown.status, "unconfirmed");
      assertEquals(run.teardown.reason, "group-kill-helper-unavailable");
    } finally {
      await killLeftoverHeartbeat(beat);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("teardown mapping helpers keep unconfirmed runs non-replayable", () => {
  for (
    const proven of ["not-needed", {
      status: "confirmed",
      via: "kill-helper",
    }] as const
  ) {
    const outcome = harnessCanceledOutcome(proven);
    assert(outcome.status === "canceled");
    assertEquals(cancellation(outcome).terminationStatus, "confirmed");
    assert(cancellation(outcome).processExited);
  }
  const unknown = harnessCanceledOutcome({
    status: "unconfirmed",
    via: "none",
    reason: "group-kill-helper-unavailable",
  });
  assert(unknown.status === "canceled");
  assertEquals(cancellation(unknown).terminationStatus, "unknown");
  assertFalse(cancellation(unknown).processExited);

  const fault = harnessTeardownFault("PI", {
    status: "unconfirmed",
    via: "none",
    reason: "group-kill-helper-exit-1",
  });
  assert(fault.status === "failed");
  assertEquals(faultOf(fault).code, "PI_HARNESS_TEARDOWN_UNCONFIRMED");
  assertEquals(faultOf(fault).retryable, false);
  assert(contractSchemas.Problem.safeParse(fault.fault).success);
});

Deno.test({
  name: "an already-empty group is confirmed, not unconfirmed",
  ...OPTIONS,
  fn: async () => {
    const child = await spawnHarnessProcess({
      executable: "/bin/sh",
      args: ["-c", "exit 0"],
      cwd: "/",
      environment: { HOME: "/" },
    });
    await child.stdin.close();
    await child.status;
    await child.stdout.cancel();
    await child.stderr.cancel();
    const viaDefault = await killHarnessProcessGroup(child);
    assertEquals(viaDefault.status, "confirmed");
    // Force the helper path regardless of the run grant: the helper exits 1
    // with "No such process", which must read as an empty group.
    const viaHelper = await killHarnessProcessGroup(
      child,
      "/usr/bin/kill",
    );
    assertEquals(viaHelper.status, "confirmed");
  },
});
