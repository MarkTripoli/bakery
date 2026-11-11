import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { createClaudeHarnessExecutor } from "../../apps/worker/src/claude-harness.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { createPiHarnessExecutor } from "../../apps/worker/src/pi-harness.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  CONFORMANCE_TEST_OPTIONS,
  conformanceAssignment,
  nativeCaptureFixture,
  publishFor,
} from "../helpers/harness-conformance.ts";
import {
  gitText,
  prepareScratchRepository,
  realHarnessGate,
  resolveHarnessExecutable,
} from "../helpers/harness.ts";

/**
 * Opt-in real-CLI conformance. Each case runs the real CLI against a scratch
 * repository with the operator's own login, so it bills the operator's account
 * and never runs in CI.
 */

const NO_OP_BOUND_MS = 180_000;
const ABORT_AFTER_MS = 5_000;
const ABORT_RETURN_BOUND_MS = 30_000;

type RealAdapter = "codex" | "claude" | "pi";
const REAL_ADAPTERS: readonly RealAdapter[] = ["codex", "claude", "pi"];

/** The operator's login source, resolved like the worker's own config does. */
function authSource(adapter: RealAdapter): string {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME_REQUIRED_FOR_REAL_CLI_CONFORMANCE");
  if (adapter === "claude") {
    return Deno.env.get("BAKERY_CLAUDE_AUTH_SOURCE_DIR")?.trim() ||
      Deno.env.get("CLAUDE_CONFIG_DIR")?.trim() || join(home, ".claude");
  }
  if (adapter === "pi") {
    return Deno.env.get("PI_CODING_AGENT_DIR")?.trim() ||
      join(home, ".pi", "agent");
  }
  return Deno.env.get("BAKERY_CODEX_AUTH_SOURCE_DIR")?.trim() ||
    Deno.env.get("CODEX_HOME")?.trim() || join(home, ".codex");
}

function realExecutor(
  adapter: RealAdapter,
  options: {
    readonly executable: string;
    readonly repository: string;
    readonly stateDir: string;
    readonly publishCount: { count: number };
    readonly timeLimitMs: number;
  },
): WorkerExecutor {
  const common = {
    publishFor: publishFor(options.publishCount),
    repositoryFor: () => options.repository,
    timeLimitMs: options.timeLimitMs,
  };
  if (adapter === "codex") {
    return createCodexHarnessExecutor({
      ...common,
      codexExecutable: options.executable,
      stateDir: options.stateDir,
      authSourceDir: authSource("codex"),
    });
  }
  if (adapter === "claude") {
    return createClaudeHarnessExecutor({
      ...common,
      claudeExecutable: options.executable,
      stateDir: options.stateDir,
      authSourceDir: authSource("claude"),
    });
  }
  return createPiHarnessExecutor({
    ...common,
    piExecutable: options.executable,
    stateDir: options.stateDir,
    piAgentSourceDir: authSource("pi"),
    capabilities: ["stream", "resume", "steer", "follow_up"],
  });
}

const VERSION_FIELD = {
  codex: "codexVersion",
  claude: "claudeCodeVersion",
  pi: "piVersion",
} as const;

async function withRealRun(
  adapter: RealAdapter,
  timeLimitMs: number,
  body: (context: {
    readonly execute: (signal: AbortSignal) => ReturnType<
      WorkerExecutor["execute"]
    >;
    readonly repository: string;
    readonly baseSha: string;
    readonly publishCount: { count: number };
    readonly assignmentSessionId: string;
  }) => Promise<void>,
): Promise<void> {
  const executable = await resolveHarnessExecutable(adapter);
  assert(executable !== undefined, "gate passed without an executable");
  const scratch = await prepareScratchRepository(
    `bakery-real-${adapter}-`,
  );
  const stateDir = await Deno.makeTempDir({
    prefix: `bakery-real-state-${adapter}-`,
  });
  const assignment = await conformanceAssignment(scratch.dir);
  const fixture = await nativeCaptureFixture(assignment, []);
  const publishCount = { count: 0 };
  try {
    const executor = realExecutor(adapter, {
      executable,
      repository: scratch.dir,
      stateDir,
      publishCount,
      timeLimitMs,
    });
    await body({
      execute: (signal) =>
        executor.execute(assignment, signal, fixture.capture),
      repository: scratch.dir,
      baseSha: scratch.baseSha,
      publishCount,
      assignmentSessionId: assignment.agentSessionId as string,
    });
  } finally {
    await Deno.remove(fixture.directory, { recursive: true }).catch(() =>
      undefined
    );
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    await Deno.remove(scratch.dir, { recursive: true }).catch(() => undefined);
  }
}

for (const adapter of REAL_ADAPTERS) {
  const gate = await realHarnessGate(adapter);
  const skipped = gate !== true;
  const suffix = skipped ? ` [skipped: ${gate}]` : "";
  if (skipped) console.warn(`real-cli [${adapter}] skipped: ${gate}`);

  Deno.test({
    name: `real CLI [${adapter}] bounded no-op run${suffix}`,
    ignore: skipped,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withRealRun(adapter, NO_OP_BOUND_MS, async (run) => {
        const outcome = await run.execute(
          AbortSignal.timeout(NO_OP_BOUND_MS + 30_000),
        );
        if (outcome.status === "completed") {
          const result = workerActionOutputSchema("harness.implement").parse(
            outcome.result,
          ) as Record<string, unknown>;
          const head = await gitText(run.repository, ["rev-parse", "HEAD"]);
          assertEquals(result.baseSha, run.baseSha);
          assertEquals(result.headSha, head);
          assertEquals(result.sessionId, run.assignmentSessionId);
          const version = result[VERSION_FIELD[adapter]];
          assert(
            typeof version === "string" && version.length > 0,
            "completed run must report the CLI version",
          );
          console.warn(
            `real-cli [${adapter}] completed version=${version} head=${head}`,
          );
        } else if (outcome.status === "failed") {
          const problem = contractSchemas.Problem.parse(
            outcome.fault,
          ) as Record<string, unknown>;
          assertEquals(run.publishCount.count, 0);
          console.warn(
            `real-cli [${adapter}] failed code=${problem.code} status=${problem.status}`,
          );
        } else {
          throw new Error(
            `unexpected outcome ${outcome.status} for an unaborted run`,
          );
        }
      });
    },
  });

  Deno.test({
    name:
      `real CLI [${adapter}] abort after 5 s returns canceled evidence${suffix}`,
    ignore: skipped,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withRealRun(adapter, NO_OP_BOUND_MS, async (run) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
        const startedAt = Date.now();
        const outcome = await run.execute(controller.signal);
        clearTimeout(timer);
        const elapsed = Date.now() - startedAt;
        assert(
          elapsed < ABORT_AFTER_MS + ABORT_RETURN_BOUND_MS,
          `abort took ${elapsed} ms to return`,
        );
        if (outcome.status === "canceled") {
          const cancellation = outcome.cancellation as Record<string, unknown>;
          assertEquals(cancellation.processExited, true);
          assertEquals(cancellation.cleanupStatus, "complete");
          assertEquals(cancellation.terminationStatus, "confirmed");
          assertEquals(run.publishCount.count, 0);
          assertEquals(
            await gitText(run.repository, ["rev-parse", "HEAD"]),
            run.baseSha,
          );
        } else {
          // The CLI settled before the abort fired: the outcome must still be
          // a schema-valid terminal state, never an invented cancellation.
          assert(outcome.status === "completed" || outcome.status === "failed");
          console.warn(
            `real-cli [${adapter}] settled as ${outcome.status} before abort (${elapsed} ms)`,
          );
        }
        console.warn(`real-cli [${adapter}] abort returned in ${elapsed} ms`);
      });
    },
  });
}
