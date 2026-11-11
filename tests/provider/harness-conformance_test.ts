import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import {
  assertBoundedRedactedCapture,
  assertCanceledConformance,
  assertCompletedConformance,
  assertFaultConformance,
  assertHeartbeatStoppedAtReturn,
  assertUnconfirmedCancel,
  CONFORMANCE_ADAPTERS,
  CONFORMANCE_TEST_OPTIONS,
  type ConformanceAdapter,
  FAKE_NATIVE_SESSION_ID,
  normalizedShape,
  withConformanceRun,
} from "../helpers/harness-conformance.ts";
import type { ConformanceRun } from "../helpers/harness-conformance.ts";
import { gitText } from "../helpers/harness.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";

/**
 * One parametrized corpus run through the Codex, Claude Code and Pi harness
 * executors with sh fakes. Scenarios 1-7 of issue #391; each scenario stores
 * its normalized shape so the sameness test compares all three adapters.
 */

type Scenario = (adapter: ConformanceAdapter) => Promise<unknown>;

const HANG_LIMIT_MS = 1_500;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Scenario 1: schema and version. */
const schemaAndVersion: Scenario = async (adapter) => {
  let shape: unknown;
  await withConformanceRun(adapter, "complete", {}, async (run) => {
    await assertCompletedConformance(run);
    shape = normalizedShape(adapter, run.outcome);
  });
  return shape;
};

/**
 * Scenario 2: malformed or truncated output never fabricates completion. The
 * bounded redacted diagnostic is the native output stream. Codex completion is
 * proven by exit status only; its stdout is opaque and never parsed.
 */
const malformedOutput: Scenario = async (adapter) => {
  const shapes: unknown[] = [];
  for (const behavior of adapter.faultBehaviors) {
    await withConformanceRun(adapter, behavior, {}, async (run) => {
      await assertFaultConformance(run, {
        code: "HARNESS_EXIT_NONZERO",
        status: 502,
        retryable: false,
      });
      await assertBoundedRedactedCapture(run);
      shapes.push(normalizedShape(adapter, run.outcome));
    });
  }
  for (const shape of shapes) assertEquals(shape, shapes[0]);
  return shapes[0];
};

/** Hang fakes: unresponsive, and (Pi) honoring the RPC abort then exiting. */
const HANG_BEHAVIORS = ["hang", "hang-cooperative"] as const;

/**
 * Scenario 3: a hung run hits the explicit limit and the whole group is gone,
 * including when the leader honors the graceful abort and exits first.
 */
const hangTimeout: Scenario = async (adapter) => {
  const shapes: unknown[] = [];
  for (const behavior of HANG_BEHAVIORS) {
    await withConformanceRun(
      adapter,
      behavior,
      { timeLimitMs: HANG_LIMIT_MS },
      async (run) => {
        await assertFaultConformance(run, {
          code: "HARNESS_TIMEOUT",
          status: 504,
          retryable: true,
        });
        assert(await exists(join(run.markers, "started")));
        assert(run.elapsedMs < 10_000, `slow timeout: ${run.elapsedMs} ms`);
        await assertHeartbeatStoppedAtReturn(run);
        shapes.push(normalizedShape(adapter, run.outcome));
      },
    );
  }
  for (const shape of shapes) assertEquals(shape, shapes[0]);
  return shapes[0];
};

/** Scenario 4a: an already aborted signal proves cancel before anything starts. */
const preAbort: Scenario = async (adapter) => {
  let shape: unknown;
  await withConformanceRun(
    adapter,
    "hang",
    { preAbort: true },
    async (run) => {
      await assertCanceledConformance(run);
      assertFalse(
        await exists(join(run.markers, "started")),
        "a pre-aborted run must not start the harness",
      );
      shape = normalizedShape(adapter, run.outcome);
    },
  );
  return shape;
};

/** Scenario 4b: abort after start proves a confirmed teardown, cooperative or not. */
const abortAfterStart: Scenario = async (adapter) => {
  const shapes: unknown[] = [];
  for (const behavior of HANG_BEHAVIORS) {
    await withConformanceRun(
      adapter,
      behavior,
      { abortAfterStart: true },
      async (run) => {
        await assertCanceledConformance(run);
        assert(run.elapsedMs < 15_000, `slow cancel: ${run.elapsedMs} ms`);
        await assertHeartbeatStoppedAtReturn(run);
        shapes.push(normalizedShape(adapter, run.outcome));
      },
    );
  }
  for (const shape of shapes) assertEquals(shape, shapes[0]);
  return shapes[0];
};

const RESUME_FLAGS = ["--resume", "--session", "resume"];
const REVISION = "a".repeat(40);
const AGENT = "11111111-1111-4111-8111-111111111111";
const NATIVE = "22222222-2222-4222-8222-222222222222";
const TOKEN = "checkpoint-token-1";

type Json = Record<string, unknown>;

function checkpointOf(over: Json = {}): Json {
  const checkpoint: Json = {
    agentSessionId: AGENT,
    nativeSessionId: NATIVE,
    worktreeRevision: REVISION,
    checkpoint: TOKEN,
    ...over,
  };
  for (const [key, value] of Object.entries(checkpoint)) {
    if (value === undefined) delete checkpoint[key];
  }
  return checkpoint;
}

function requestOf(over: Json = {}): Json {
  const request: Json = {
    sessionId: NATIVE,
    worktreeRevision: REVISION,
    checkpoint: TOKEN,
    ...over,
  };
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) delete request[key];
  }
  return request;
}

type ResumeCase = {
  readonly name: string;
  readonly checkpoint?: Json | null;
  readonly request?: Json | null;
  readonly agentSessionId?: string;
};

/** Every mutation of the shared checkpoint and request that must start fresh. */
const RESUME_MUTATIONS: readonly ResumeCase[] = [
  {
    name: "wrong agentSessionId on the checkpoint",
    checkpoint: checkpointOf({ agentSessionId: "other" }),
  },
  {
    name: "assignment names a different agent session",
    agentSessionId: "other",
  },
  {
    name: "wrong nativeSessionId on the checkpoint",
    checkpoint: checkpointOf({ nativeSessionId: "other" }),
  },
  {
    name: "request names a different session",
    request: requestOf({ sessionId: "other" }),
  },
  {
    name: "checkpoint worktreeRevision changed",
    checkpoint: checkpointOf({ worktreeRevision: "b".repeat(40) }),
  },
  {
    name: "request worktreeRevision changed",
    request: requestOf({ worktreeRevision: "b".repeat(40) }),
  },
  {
    name: "checkpoint eligible:false",
    checkpoint: checkpointOf({ eligible: false }),
  },
  {
    name: "checkpoint resumeEligible:false",
    checkpoint: checkpointOf({ resumeEligible: false }),
  },
  {
    name: "checkpoint checkpointEligible:false",
    checkpoint: checkpointOf({ checkpointEligible: false }),
  },
  { name: "request eligible:false", request: requestOf({ eligible: false }) },
  {
    name: "request resumeEligible:false",
    request: requestOf({ resumeEligible: false }),
  },
  {
    name: "request checkpointEligible:false",
    request: requestOf({ checkpointEligible: false }),
  },
  {
    name: "checkpoint token missing",
    checkpoint: checkpointOf({ checkpoint: undefined }),
  },
  {
    name: "request token missing",
    request: requestOf({ checkpoint: undefined }),
  },
  {
    name: "request and checkpoint tokens differ",
    request: requestOf({ checkpoint: "another-token" }),
  },
  { name: "no checkpoint at all", checkpoint: null },
];

function selection(adapter: ConformanceAdapter, test: ResumeCase) {
  const checkpoint = test.checkpoint === undefined
    ? checkpointOf()
    : test.checkpoint;
  const request = test.request === undefined ? requestOf() : test.request;
  return adapter.selectResume(
    {
      agentSessionId: test.agentSessionId ?? AGENT,
      currentCheckpoints: checkpoint === null ? [] : [checkpoint],
    } as unknown as Pick<
      JobAssignment,
      "agentSessionId" | "currentCheckpoints"
    >,
    request === null ? {} : { resume: request },
    REVISION,
  );
}

async function argvOf(run: ConformanceRun): Promise<string[]> {
  return (await Deno.readTextFile(join(run.markers, "argv"))).split("\n")
    .filter(Boolean);
}

function resumeAssignment(
  checkpoint: Json,
  request: Json,
): (assignment: JobAssignment, baseSha: string) => JobAssignment {
  return (assignment, baseSha) => ({
    ...assignment,
    currentCheckpoints: [{ ...checkpoint, worktreeRevision: baseSha }],
    input: {
      ...(assignment.input as Json),
      resume: { ...request, worktreeRevision: baseSha },
    },
  } as unknown as JobAssignment);
}

/**
 * Scenario 5: resume eligibility. Every mutation of the shared checkpoint
 * starts fresh; the valid case selects a resume only where the adapter has
 * one; a run that cannot prove retained state never passes a resume flag.
 */
const resumeEligibility: Scenario = async (adapter) => {
  for (const test of RESUME_MUTATIONS) {
    assertEquals(
      selection(adapter, test),
      undefined,
      `${adapter.name}: ${test.name} must start fresh`,
    );
  }
  const valid = selection(adapter, { name: "valid" });
  if (adapter.resumeFlag === undefined) assertEquals(valid, undefined);
  else assert(valid !== undefined, `${adapter.name}: valid case must resume`);

  const runs: Array<[string, ReturnType<typeof resumeAssignment> | undefined]> =
    [
      ["no resume input", undefined],
    ];
  if (adapter.resumeFlag !== undefined) {
    runs.push(
      [
        "mismatched session",
        resumeAssignment(checkpointOf(), requestOf({ sessionId: "other" })),
      ],
      [
        "matching metadata without retained state",
        resumeAssignment(checkpointOf(), requestOf()),
      ],
    );
  }
  for (const [label, assignmentFor] of runs) {
    await withConformanceRun(
      adapter,
      "complete",
      { assignmentFor },
      async (run) => {
        await assertCompletedConformance(run);
        const argv = await argvOf(run);
        for (const flag of RESUME_FLAGS) {
          assertFalse(argv.includes(flag), `${label}: ${flag} must be absent`);
        }
      },
    );
  }
  return { mutationsAllFresh: true, noResumeFlagWithoutProof: true };
};

async function disposition(
  executor: WorkerExecutor,
  assignment: JobAssignment,
  action: "steer_message" | "follow_up_message",
): Promise<string> {
  // Mirrors supervisor-heartbeat.ts: no control means "rejected".
  return executor.control
    ? await executor.control(assignment, action, crypto.randomUUID(), "hello")
    : "rejected";
}

/**
 * Scenario 6: unsupported controls. Raw dispositions differ by design (Pi
 * reports `unsupported` during a run); the shared invariant is that the
 * supervisor never acknowledges: messageAcknowledged === (disposition ===
 * "accepted") === false.
 */
const unsupportedControls: Scenario = async (adapter) => {
  const expectedActive = adapter.name === "pi" ? "unsupported" : "rejected";
  const actions = ["steer_message", "follow_up_message"] as const;
  const acknowledged: boolean[] = [];

  await withConformanceRun(
    adapter,
    "hang",
    {
      abortAfterStart: true,
      capabilities: [],
      onStarted: async ({ executor, assignment }) => {
        const seen: string[] = [];
        for (const action of actions) {
          seen.push(await disposition(executor, assignment, action));
        }
        return seen;
      },
    },
    async (run) => {
      assertEquals(
        run.startedResult,
        [expectedActive, expectedActive],
        `${adapter.name}: raw disposition during an active run`,
      );
      for (const seen of run.startedResult as string[]) {
        acknowledged.push(seen === "accepted");
      }
      await assertCanceledConformance(run);
      for (const action of actions) {
        // No active run left: every adapter rejects.
        const idle = await disposition(run.executor, run.assignment, action);
        assertEquals(idle, "rejected");
        acknowledged.push(idle === "accepted");
      }
    },
  );

  await withConformanceRun(
    adapter,
    "complete",
    { capabilities: [] },
    async (run) => {
      await assertCompletedConformance(run);
      const result = (run.outcome as { result: Json }).result;
      assertEquals(result.capabilities ?? [], [], "advertised capabilities");
    },
  );

  let unsupported: unknown;
  await withConformanceRun(
    adapter,
    "complete",
    { action: "conformance.unsupported-action" },
    async (run) => {
      await assertFaultConformance(run, {
        code: "HARNESS_ACTION_UNSUPPORTED",
        status: 500,
        retryable: false,
      });
      assertFalse(
        await exists(join(run.markers, "started")),
        "an unsupported action must not start the harness",
      );
      unsupported = normalizedShape(adapter, run.outcome);
    },
  );
  return { acknowledged: acknowledged.some(Boolean), unsupported };
};

function telemetryOf(outcome: { result: unknown }): Json | undefined {
  return (outcome.result as Json).telemetry as Json | undefined;
}

/** Scenario 7: no run ever carries a usage receipt or an invented cost. */
const usageTruth: Scenario = async (adapter) => {
  let cost: unknown = "unset";
  await withConformanceRun(adapter, "complete", {}, async (run) => {
    await assertCompletedConformance(run);
    assertFalse("usage" in run.outcome, "no usage receipt");
    const outcome = run.outcome as { result: unknown };
    const telemetry = telemetryOf(outcome);
    if (adapter.name === "codex") {
      assertEquals(telemetry, undefined, "codex reports no telemetry");
      cost = null;
    } else if (adapter.name === "claude") {
      assertEquals(telemetry, { total_cost_usd: null });
      cost = telemetry!.total_cost_usd;
    } else {
      assertEquals(telemetry, { providerUsage: null, costUsd: null });
      cost = telemetry!.costUsd;
    }
  });
  await withConformanceRun(adapter, "complete-usage", {}, async (run) => {
    await assertCompletedConformance(run);
    assertFalse("usage" in run.outcome, "no usage receipt");
    const telemetry = telemetryOf(run.outcome as { result: unknown });
    if (adapter.name === "codex") assertEquals(telemetry, undefined);
    else if (adapter.name === "claude") {
      assertEquals(telemetry, { total_cost_usd: 0.0123 });
    } else {
      assertEquals(telemetry, {
        providerUsage: { input: 10, output: 5 },
        costUsd: null,
      });
    }
  });
  return { usageReceipt: false, costWhenUnreported: cost };
};

const MISSING_KILL_HELPER = "/nonexistent/bakery-kill";

/**
 * Scenario 8: when the group cannot be signaled (helper missing, and the
 * lane grants no broad run permission for Deno.kill) the adapter must say so:
 * an abort is unknown-termination, a timeout is a non-retryable teardown
 * fault. Needs the restricted lane grants, so it skips under a broad grant.
 */
const unconfirmedTeardown: Scenario = async (adapter) => {
  const broad = Deno.permissions.querySync({ name: "run" }).state ===
    "granted";
  if (broad) {
    // Real-CLI opt-in grants all run access, so Deno.kill always works.
    console.warn(
      `[${adapter.name}] skipped: broad --allow-run makes Deno.kill succeed`,
    );
    return { unconfirmed: true };
  }
  await withConformanceRun(
    adapter,
    "hang-silent",
    { abortAfterStart: true, groupKillExecutable: MISSING_KILL_HELPER },
    (run) => {
      assertUnconfirmedCancel(run);
      return Promise.resolve();
    },
  );
  await withConformanceRun(
    adapter,
    "hang-silent",
    {
      timeLimitMs: HANG_LIMIT_MS,
      groupKillExecutable: MISSING_KILL_HELPER,
    },
    async (run) => {
      await assertFaultConformance(run, {
        code: "HARNESS_TEARDOWN_UNCONFIRMED",
        status: 500,
        retryable: false,
      });
    },
  );
  return { unconfirmed: true };
};

const SCENARIOS: ReadonlyArray<readonly [string, Scenario]> = [
  ["1 schema and version", schemaAndVersion],
  [
    "2 malformed or truncated output fails closed and redacted",
    malformedOutput,
  ],
  ["3 hang hits the limit and the group dies", hangTimeout],
  ["4a pre-aborted signal proves cancel before start", preAbort],
  ["4b abort after start proves a confirmed teardown", abortAfterStart],
  ["5 resume eligibility never resumes without proof", resumeEligibility],
  ["6 unsupported controls are never acknowledged", unsupportedControls],
  ["7 usage truth: no receipt, no invented cost", usageTruth],
  ["8 unconfirmed group kill is reported, never proven", unconfirmedTeardown],
];

const shapes = new Map<string, unknown>();

for (const [title, scenario] of SCENARIOS) {
  for (const adapter of CONFORMANCE_ADAPTERS) {
    Deno.test({
      name: `[${adapter.name}] ${title}`,
      ...CONFORMANCE_TEST_OPTIONS,
      fn: async () => {
        shapes.set(`${title}:${adapter.name}`, await scenario(adapter));
      },
    });
  }
}

for (const [title, scenario] of SCENARIOS) {
  Deno.test({
    name: `[all] ${title}: normalized outcomes are the same across adapters`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      const observed: unknown[] = [];
      for (const adapter of CONFORMANCE_ADAPTERS) {
        const key = `${title}:${adapter.name}`;
        // A filtered run skips the per-adapter test; compute it on demand.
        observed.push(
          shapes.has(key) ? shapes.get(key) : await scenario(adapter),
        );
      }
      assertEquals(observed[1], observed[0], "claude differs from codex");
      assertEquals(observed[2], observed[0], "pi differs from codex");
    },
  });
}

/**
 * Missing credentials fail closed before the harness binary is launched, with
 * a dedicated non-retryable code instead of a misleading input fault.
 */
for (
  const [variant, remove] of [
    ["auth source directory", "directory"],
    ["auth file", "file"],
  ] as const
) {
  for (const adapter of CONFORMANCE_ADAPTERS) {
    Deno.test({
      name:
        `[${adapter.name}] missing ${variant} fails closed before spawn (#418)`,
      ...CONFORMANCE_TEST_OPTIONS,
      fn: async () => {
        await withConformanceRun(
          adapter,
          "complete",
          {
            prepare: async ({ markers }) => {
              const source = join(markers, "auth-source");
              if (remove === "directory") {
                await Deno.remove(source, { recursive: true });
              } else await Deno.remove(join(source, adapter.authFile));
            },
          },
          async (run) => {
            await assertFaultConformance(run, {
              code: "HARNESS_CREDENTIAL_UNAVAILABLE",
              status: 503,
              retryable: false,
            });
            assertFalse(
              await exists(join(run.markers, "launched")),
              "the harness binary must not launch without credentials",
            );
          },
        );
      },
    });
  }
}

/**
 * A retained session is bound to the CLI version that wrote it: a different
 * `--version` starts fresh; the same version resumes (the control).
 */
for (const adapter of CONFORMANCE_ADAPTERS) {
  Deno.test({
    name:
      `[${adapter.name}] a checkpoint from another CLI version never resumes (#418)`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      const retention = (
        assignment: JobAssignment,
        baseSha: string,
      ): JobAssignment => ({
        ...assignment,
        currentCheckpoints: [{
          agentSessionId: assignment.agentSessionId,
          nativeSessionId: FAKE_NATIVE_SESSION_ID,
          worktreeRevision: baseSha,
          checkpoint: "version-checkpoint-1",
        }],
      } as unknown as JobAssignment);
      await withConformanceRun(
        adapter,
        "isolation-probe",
        {
          assignmentFor: retention,
          prepare: ({ markers }) =>
            Deno.writeTextFile(join(markers, "version"), "v1\n"),
        },
        async (run) => {
          const first = run.outcome;
          assertEquals(first.status, "completed");
          if (first.status !== "completed") throw new Error("unreachable");
          // Pi returns its checkpoint; Claude keeps the one the input carried.
          const returned = (first.result as Record<string, unknown>)
            .checkpoint;
          const checkpoint = (returned ??
            (run.assignment.currentCheckpoints as unknown[])[0]) as Json;
          if (adapter.resumeFlag === undefined) return;
          const secondRun = async (version: string) => {
            await Deno.writeTextFile(join(run.markers, "version"), version);
            await gitText(run.repository, ["reset", "--hard", run.baseSha]);
            const outcome = await run.executor.execute(
              {
                ...run.assignment,
                attemptId: crypto.randomUUID(),
                currentCheckpoints: [checkpoint],
              } as unknown as JobAssignment,
              new AbortController().signal,
            );
            assertEquals(outcome.status, "completed");
            return await argvOf(run);
          };
          assert(
            (await secondRun("v1\n")).includes(adapter.resumeFlag),
            "same CLI version must resume (control)",
          );
          assertFalse(
            (await secondRun("v2\n")).includes(adapter.resumeFlag),
            "another CLI version must start fresh",
          );
        },
      );
    },
  });
}
