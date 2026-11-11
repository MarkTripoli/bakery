import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import {
  findingFingerprint,
  REVIEW_LOOP_LIMITS,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  createDeterministicExecutor,
  NATIVE_SUPPORTED_ACTIONS,
} from "../../../apps/worker/src/executor.ts";
import { main } from "../../../apps/worker/src/main.ts";
import {
  createScriptedHarnessExecutor,
  scriptedRepairPatch,
} from "../../../apps/worker/src/scripted-harness.ts";
import type { SupervisorState } from "../../../apps/worker/src/supervisor-state.ts";
import { supervisorConfig } from "../worker-execution/recovery-support.ts";
import { prepareScratchRepository } from "../harness.ts";
import { syntheticAuthSource } from "../harness-auth.ts";
import {
  recordingPublisher,
  waitFor,
} from "../deterministic-checks/runner-fixture.ts";
import { failedCheck, finding, fingerprintOf } from "./fixtures.ts";
import {
  candidateRepository,
  completed,
  disposeRepository,
  faultOf,
  legacyProfile,
  recordingInner,
  repairAssignment,
  reviewAssignment,
  reviewProfile,
} from "./worker-fixtures.ts";

/**
 * Cases for which worker advertises which of the new actions (`harness.repair`,
 * `review.independent`) and for the scripted test paths that stand in for the
 * real adapters in deterministic lanes (issue #94).
 */

const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

function wiringTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name: `wiring: ${name}`, ...SANITIZERS, fn });
}

type Wiring = "none" | "codex" | "pi" | "claude";

/**
 * Starts `main` for one wiring over the deterministic stand-in executor and
 * reports what the supervisor would put in its claim.
 */
async function advertisedFor(
  wiring: Wiring,
): Promise<{ actions: readonly string[]; checkIds: readonly string[] }> {
  const scratch = await prepareScratchRepository("bakery-wiring-main-");
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-wiring-state-" });
  const base = { ...supervisorConfig(stateDir), drainTimeoutMs: 500 };
  const harness = (name: string, executable: string) => ({
    name,
    executable,
    timeLimitMs: 5_000,
    repository: scratch.dir,
  });
  const config = wiring === "none" ? base : wiring === "codex"
    ? {
      ...base,
      codingHarness: harness("codex", "codex"),
      codexAuthSourceDir: syntheticAuthSource("auth.json"),
    }
    : wiring === "pi"
    ? { ...base, codingHarness: harness("pi", "pi") }
    : {
      ...base,
      codingHarness: harness("claude", "claude"),
      claudeAuthSourceDir: syntheticAuthSource(".credentials.json"),
    };
  let state: SupervisorState | undefined;
  let drain: Promise<void> | undefined;
  try {
    await main({
      config,
      executor: createDeterministicExecutor(),
      onSupervisor(supervisor) {
        state = (supervisor as unknown as { state: SupervisorState }).state;
        drain = supervisor.drain();
        supervisor.requestStop("TEST_WIRING_ADVERTISEMENT");
      },
    });
    await drain;
    const executor = state?.executor;
    return {
      actions: executor?.supportedActions ?? [],
      checkIds: (await executor?.readinessChecks?.() ?? []).map((check) =>
        check.checkId
      ),
    };
  } finally {
    await drain?.catch(() => undefined);
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    await Deno.remove(scratch.dir, { recursive: true }).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function registerWorkerWiringCases(): void {
  wiringTest(
    "a worker advertises repair with a coding harness and review only with Claude",
    async () => {
      const expected: Record<Wiring, Record<string, boolean>> = {
        // The deterministic stand-in is the bare inner executor of the harness
        // chain; the production default is the native list checked below.
        none: {
          "harness.implement": true,
          "harness.repair": false,
          "quality.check": false,
          "review.independent": false,
        },
        codex: {
          "harness.implement": true,
          "harness.repair": true,
          "quality.check": true,
          "review.independent": false,
        },
        pi: {
          "harness.implement": true,
          "harness.repair": true,
          "quality.check": true,
          "review.independent": false,
        },
        claude: {
          "harness.implement": true,
          "harness.repair": true,
          "quality.check": true,
          "review.independent": true,
        },
      };
      for (const [wiring, actions] of Object.entries(expected)) {
        const advertised = await advertisedFor(wiring as Wiring);
        for (const [action, present] of Object.entries(actions)) {
          assertEquals(
            advertised.actions.includes(action),
            present,
            `${wiring}: ${action}`,
          );
        }
        assertEquals(
          advertised.checkIds.includes("capability:reviewer"),
          wiring === "claude",
          `${wiring}: capability:reviewer`,
        );
      }
    },
  );

  wiringTest(
    "a worker with no coding harness advertises repair like implement",
    () => {
      // Both end in the same honest 501 fault, so a repair step is claimed and
      // refused instead of waiting for a host that can never run it.
      assert(NATIVE_SUPPORTED_ACTIONS.includes("harness.implement"));
      assert(NATIVE_SUPPORTED_ACTIONS.includes("harness.repair"));
      assertFalse(
        (NATIVE_SUPPORTED_ACTIONS as readonly string[]).includes(
          "review.independent",
        ),
      );
      return Promise.resolve();
    },
  );

  wiringTest(
    "the scripted harness advertises repair and review and delegates the rest",
    async () => {
      const inner = recordingInner(["harness.implement", "repository.inspect"]);
      const scripted = createScriptedHarnessExecutor({
        dir: "/nonexistent/scripted",
        inner,
        publishFor: recordingPublisher().publishFor,
      });
      assertEquals(scripted.supportedActions, [
        "harness.implement",
        "repository.inspect",
        "harness.repair",
        "review.independent",
      ]);
      const repository = await candidateRepository();
      try {
        const profile = await reviewProfile({ baseSha: repository.baseSha });
        await scripted.execute(
          reviewAssignment(repository, profile, { action: "quality.check" }),
          new AbortController().signal,
        );
        assertEquals(inner.calls, ["quality.check"]);
      } finally {
        await disposeRepository(repository);
      }
    },
  );

  async function scriptedRig() {
    const repository = await candidateRepository();
    const dir = join(repository.aux, "scripted");
    await Deno.mkdir(dir);
    const profile = await reviewProfile({ baseSha: repository.baseSha });
    const recorder = recordingPublisher();
    const scripted = createScriptedHarnessExecutor({
      dir,
      inner: recordingInner(),
      publishFor: recorder.publishFor,
    });
    return { repository, dir, profile, recorder, scripted };
  }

  /** Starts the job, waits until it announces itself, then releases it. */
  async function released(
    rig: Awaited<ReturnType<typeof scriptedRig>>,
    assignment: ReturnType<typeof reviewAssignment>,
  ) {
    const running = rig.scripted.execute(
      assignment,
      new AbortController().signal,
    );
    const started = join(rig.dir, `${assignment.jobId}.started`);
    await waitFor(() => exists(started), "the scripted job to start");
    assertEquals(
      (await Deno.readTextFile(started)).trim(),
      assignment.attemptId,
    );
    await Deno.writeTextFile(join(rig.dir, `${assignment.jobId}.release`), "");
    return await running;
  }

  wiringTest(
    "a scripted repair waits for its release and answers with a patch derived from its input",
    async () => {
      const rig = await scriptedRig();
      try {
        const assignment = repairAssignment(rig.profile, {
          revision: rig.repository.revision,
          findings: [finding({ fingerprint: fingerprintOf(3) })],
          failedChecks: [failedCheck(), failedCheck({ checkId: "lint" })],
        });
        const outcome = await released(rig, assignment);
        const result = workerActionOutputSchema("harness.repair").parse(
          completed(outcome),
        ) as Record<string, unknown>;
        const patch = scriptedRepairPatch(rig.repository.revision, 1, 2);
        assertEquals(result.baseSha, rig.repository.revision);
        assertEquals(result.headSha, await sha1Hex(patch));
        assertEquals(result.sessionId, assignment.agentSessionId);
        assertEquals(rig.recorder.publications.length, 1);
        const published = rig.recorder.publications[0].request;
        assertEquals(published.bytes, patch);
        assertEquals(published.subjectBaseSha, rig.repository.revision);
        assertStringIncludes(published.name, "scripted-repair-");
        assertStringIncludes(
          new TextDecoder().decode(patch),
          rig.repository.revision,
        );
        // A different revision gives a different candidate.
        assert(
          await sha1Hex(scriptedRepairPatch("a".repeat(40), 1, 2)) !==
            result.headSha,
        );
      } finally {
        await disposeRepository(rig.repository);
      }
    },
  );

  wiringTest(
    "a scripted repair refuses an empty or foreign input and honors cancellation",
    async () => {
      const rig = await scriptedRig();
      try {
        const empty = repairAssignment(rig.profile, {
          revision: rig.repository.revision,
          findings: [],
          failedChecks: [],
        });
        const fault = faultOf(
          await rig.scripted.execute(empty, new AbortController().signal),
        );
        assertEquals(fault.code, "SCRIPTED_HARNESS_INPUT_INVALID");
        assertFalse(await exists(join(rig.dir, `${empty.jobId}.started`)));

        const noSession = repairAssignment(rig.profile, {
          revision: rig.repository.revision,
          findings: [finding()],
          failedChecks: [],
        }, { agentSessionId: undefined });
        assertEquals(
          faultOf(
            await rig.scripted.execute(noSession, new AbortController().signal),
          ).code,
          "SCRIPTED_HARNESS_INPUT_INVALID",
        );

        const waiting = repairAssignment(rig.profile, {
          revision: rig.repository.revision,
          findings: [finding()],
          failedChecks: [],
        });
        const controller = new AbortController();
        const running = rig.scripted.execute(waiting, controller.signal);
        await waitFor(
          () => exists(join(rig.dir, `${waiting.jobId}.started`)),
          "the scripted repair to start",
        );
        controller.abort();
        assertEquals((await running).status, "canceled");
        assertEquals(rig.recorder.publications.length, 0);
      } finally {
        await disposeRepository(rig.repository);
      }
    },
  );

  wiringTest(
    "a scripted review is clean by default and reports a scripted verdict file",
    async () => {
      const rig = await scriptedRig();
      try {
        const clean = reviewAssignment(rig.repository, rig.profile);
        const report = workerActionOutputSchema("review.independent").parse(
          completed(await released(rig, clean)),
        ) as Record<string, unknown>;
        assertEquals(report.findings, []);
        assertEquals(report.blockingFindings, 0);
        assertEquals(report.sessionId, clean.agentSessionId);
        assertEquals(report.headSha, rig.repository.revision);
        assertEquals(report.baseSha, rig.profile.baseSha);
        assertEquals(report.policyDigest, rig.profile.policyDigest);

        const flagged = reviewAssignment(rig.repository, rig.profile);
        await Deno.writeTextFile(
          join(rig.dir, `${flagged.jobId}.review.json`),
          JSON.stringify({
            findings: [
              {
                severity: "note",
                category: "docs",
                title: "Missing doc",
                path: "src/feature.ts",
                line: null,
                detail: "Document the feature.",
              },
              {
                severity: "blocker",
                category: "correctness",
                title: "Wrong constant",
                path: "src/feature.ts",
                line: 1,
                detail: "Returns 42 for every input.",
              },
            ],
          }),
        );
        const second = workerActionOutputSchema("review.independent").parse(
          completed(await released(rig, flagged)),
        ) as Record<string, unknown>;
        const findings = second.findings as Array<Record<string, unknown>>;
        assertEquals(findings.map((f) => f.severity), ["blocker", "note"]);
        assertEquals(second.blockingFindings, 1);
        // The same production fingerprint rule as the real reviewer.
        assertEquals(
          findings[0].fingerprint,
          await findingFingerprint({
            path: "src/feature.ts",
            category: "correctness",
            title: "Wrong constant",
          }),
        );
      } finally {
        await disposeRepository(rig.repository);
      }
    },
  );

  wiringTest(
    "a scripted review refuses a bad verdict, a stale session and a missing policy",
    async () => {
      const rig = await scriptedRig();
      try {
        const signal = new AbortController().signal;
        const invalid = async (
          assignment: ReturnType<typeof reviewAssignment>,
          code: string,
        ) => {
          assertEquals(
            faultOf(await rig.scripted.execute(assignment, signal)).code,
            code,
          );
        };
        for (
          const verdict of [
            "{not json",
            '{"findings":"none"}',
            '{"approved":true}',
          ]
        ) {
          const assignment = reviewAssignment(rig.repository, rig.profile);
          await Deno.writeTextFile(
            join(rig.dir, `${assignment.jobId}.review.json`),
            verdict,
          );
          await Deno.writeTextFile(
            join(rig.dir, `${assignment.jobId}.release`),
            "",
          );
          await invalid(assignment, "SCRIPTED_HARNESS_REVIEW_INVALID");
        }
        // Too many blockers for one report is refused, never trimmed away.
        const tooMany = reviewAssignment(rig.repository, rig.profile);
        await Deno.writeTextFile(
          join(rig.dir, `${tooMany.jobId}.review.json`),
          JSON.stringify({
            findings: Array.from(
              { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
              (_, index) => ({
                severity: "blocker",
                category: "correctness",
                title: `Blocker ${index}`,
                path: "src/feature.ts",
                line: 1,
                detail: "Too many.",
              }),
            ),
          }),
        );
        await Deno.writeTextFile(join(rig.dir, `${tooMany.jobId}.release`), "");
        await invalid(tooMany, "SCRIPTED_HARNESS_REVIEW_INVALID");

        await invalid(
          reviewAssignment(rig.repository, rig.profile, {
            agentSessionId: undefined,
          }),
          "SCRIPTED_HARNESS_INPUT_INVALID",
        );
        await invalid(
          reviewAssignment(rig.repository, rig.profile, {
            currentCheckpoints: [{ nativeSessionId: crypto.randomUUID() }],
          } as never),
          "SCRIPTED_HARNESS_INPUT_INVALID",
        );
        await invalid(
          reviewAssignment(rig.repository, await legacyProfile()),
          "SCRIPTED_HARNESS_INPUT_INVALID",
        );
        await invalid(
          reviewAssignment(rig.repository, rig.profile, {}, { evidence: [] }),
          "SCRIPTED_HARNESS_INPUT_INVALID",
        );
      } finally {
        await disposeRepository(rig.repository);
      }
    },
  );
}
