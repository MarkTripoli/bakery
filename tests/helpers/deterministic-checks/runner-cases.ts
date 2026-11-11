import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "node:path";
import {
  CHECK_REASON_RESULTS,
  type CheckReason,
  isCoherentCheckOutcome,
} from "../../../packages/contracts/src/check-evidence.ts";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import { canonicalJson } from "../../../packages/contracts/src/workflow-compiler/canonical.ts";
import { sha256Hex } from "../../../apps/server/src/platform/canonical-json.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";
import {
  CHECK_RULE_KEY_ENV,
  CHECK_RULE_OPTIONS_ENV,
  CHECK_UNSUPPORTED_EXECUTABLES,
  checkArtifactName,
  createCheckExecutor,
  planChecks,
} from "../../../apps/worker/src/check-runner.ts";
import {
  createDeterministicExecutor,
  NativeExecutorError,
  type WorkerExecutor,
} from "../../../apps/worker/src/executor.ts";
import { main } from "../../../apps/worker/src/main.ts";
import type { SupervisorState } from "../../../apps/worker/src/supervisor-state.ts";
import { readWorkerLaunchPermissions } from "../../../apps/worker/src/config.ts";
import { supervisorConfig } from "../worker-execution/recovery-support.ts";
import {
  CapturingOutputSink,
  gitText,
  prepareScratchRepository,
} from "../harness.ts";
import { syntheticAuthSource } from "../harness-auth.ts";
import {
  assertCleanedUp,
  boundRule,
  checkAssignment,
  committedScratch,
  completedResult,
  disposeRun,
  evidenceOf,
  exists,
  extraWorktrees,
  faultCode,
  fixtureProfile,
  leftoverAttempts,
  legacyProfileContext,
  recordingPublisher,
  runCheckExecutor,
  runnerTest,
  sh,
  sha256OfBytes,
  stateWithCredentials,
  survives,
  waitFor,
} from "./runner-fixture.ts";
import { registerRunnerBoundaryCases } from "./runner-boundary-cases.ts";

/**
 * Runner cases for the worker `quality.check` executor. Phase 1 pins the
 * outcome vocabulary the runner must map process results onto; Phase 3 adds
 * the real scratch-repository cases to this module. Every case below runs real
 * processes against a real git repository; only the artifact upload is a
 * recording stand-in for the server.
 */

/** How a process result maps to a reason, per the design (Q4 and plan 3.1). */
export const RUNNER_OUTCOME_REASONS: Readonly<
  Record<string, { reason: CheckReason; result: string }>
> = Object.freeze({
  exit0: { reason: "verified", result: "passed" },
  exitNonZero: { reason: "exit_nonzero", result: "failed" },
  signal: { reason: "signal", result: "failed" },
  deadline: { reason: "deadline", result: "failed" },
  outputLimit: { reason: "output_limit", result: "failed" },
  toolMissing: { reason: "tool_missing", result: "unavailable" },
  unsupportedChecker: { reason: "unsupported_checker", result: "unavailable" },
  revisionMissing: { reason: "revision_unavailable", result: "unavailable" },
  policyMissing: { reason: "policy_missing", result: "unavailable" },
  ambiguousBinding: {
    reason: "rule_binding_ambiguous",
    result: "unavailable",
  },
});

export function registerRunnerCases(): void {
  Deno.test("every runner outcome has a reason the contract maps to the same result", () => {
    for (const [name, outcome] of Object.entries(RUNNER_OUTCOME_REASONS)) {
      assertEquals(
        CHECK_REASON_RESULTS[outcome.reason],
        outcome.result,
        `${name} maps to ${outcome.reason}`,
      );
    }
    assert(
      Object.keys(RUNNER_OUTCOME_REASONS).length >= 10,
      "the runner vocabulary lost an outcome",
    );
  });

  runnerTest(
    "a passing command is passed/verified, bound to the revision and cleaned up",
    async () => {
      const scratch = await committedScratch({
        "marker.txt": "from the candidate\n",
      });
      const sink = new CapturingOutputSink();
      const run = await runCheckExecutor({
        scratch,
        commands: [{ id: "unit", argv: sh("cat marker.txt; echo warn >&2") }],
        output: sink.sink(),
      });
      try {
        const result = completedResult(run.outcome);
        assert(
          workerActionOutputSchema("quality.check").safeParse(result).success,
        );
        assertEquals(result.observations.length, 1);
        const [observation] = result.observations;
        assertEquals(
          [
            observation.kind,
            observation.checkId,
            observation.ruleKey,
            observation.result,
            observation.reason,
            observation.exitCode,
          ],
          ["command", "unit", null, "passed", "verified", 0],
        );
        assert(isCoherentCheckOutcome("passed", "verified"));
        assertEquals(result.allRequired, true);
        assertEquals(result.failedCheckIds, []);
        assertEquals(result.checkRunIds, [observation.checkRunId]);
        assertEquals(result.headSha, scratch.revision);
        assertEquals(result.baseSha, scratch.baseSha);
        assertEquals(result.policyDigest, run.profile.policyDigest);
        const evidence = evidenceOf(run.publications, "unit");
        assertEquals(evidence.stdout, "from the candidate\n");
        assertEquals(evidence.stderr, "warn\n");
        assertEquals(evidence.headSha, scratch.revision);
        // The candidate's own file proves the revision was checked out.
        assertStringIncludes(sink.text(), "from the candidate");
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a failing command is failed/exit_nonzero with its exit code and blocks",
    async () => {
      const scratch = await committedScratch();
      const run = await runCheckExecutor({
        scratch,
        commands: [{ id: "unit", argv: sh("exit 3") }],
      });
      try {
        const result = completedResult(run.outcome);
        const [observation] = result.observations;
        assertEquals(
          [observation.result, observation.reason, observation.exitCode],
          ["failed", "exit_nonzero", 3],
        );
        assertEquals(result.allRequired, false);
        assertEquals(result.failedCheckIds, [observation.checkRunId]);
        assert(
          workerActionOutputSchema("quality.check").safeParse(result).success,
        );
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest("death by signal is failed/signal with no exit code", async () => {
    const scratch = await committedScratch();
    const run = await runCheckExecutor({
      scratch,
      commands: [{ id: "unit", argv: sh("kill -TERM $$") }],
    });
    try {
      const [observation] = completedResult(run.outcome).observations;
      assertEquals(
        [observation.result, observation.reason, observation.exitCode],
        ["failed", "signal", null],
      );
      assertEquals(evidenceOf(run.publications, "unit").signal, "SIGTERM");
      await assertCleanedUp(run);
    } finally {
      await disposeRun(run);
    }
  });

  runnerTest(
    "a command past its deadline is failed/deadline and its process group dies",
    async () => {
      const scratch = await committedScratch();
      const grandchild = join(scratch.markers, "grandchild");
      const run = await runCheckExecutor({
        scratch,
        commandTimeLimitMs: 500,
        commands: [{
          id: "unit",
          // A background grandchild in the same group must die with the leader.
          argv: sh(`sleep 60 & echo $! > '${grandchild}'; wait`),
        }],
      });
      try {
        const [observation] = completedResult(run.outcome).observations;
        assertEquals(
          [observation.result, observation.reason, observation.exitCode],
          ["failed", "deadline", null],
        );
        assert(
          observation.durationMs >= 400 && observation.durationMs < 15_000,
        );
        const pid = (await Deno.readTextFile(grandchild)).trim();
        assertEquals(await survives(pid), false, "grandchild survived");
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a background process cannot outlive a finished check or hold its pipes open",
    async () => {
      const scratch = await committedScratch();
      const background = join(scratch.markers, "background");
      const started = performance.now();
      const run = await runCheckExecutor({
        scratch,
        commands: [{
          id: "unit",
          // The leader exits 0 at once; the sleeper inherits stdout and stderr.
          argv: sh(`sleep 60 & echo $! > '${background}'; exit 0`),
        }],
      });
      try {
        const [observation] = completedResult(run.outcome).observations;
        assertEquals(
          [observation.result, observation.reason, observation.exitCode],
          ["passed", "verified", 0],
        );
        assert(
          performance.now() - started < 10_000,
          "the check waited on the sleeper",
        );
        const pid = (await Deno.readTextFile(background)).trim();
        assertEquals(await survives(pid), false, "background process survived");
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest("output past the cap is failed/output_limit", async () => {
    const scratch = await committedScratch();
    const run = await runCheckExecutor({
      scratch,
      limits: { outputBytes: 10_000 },
      commands: [{
        id: "unit",
        argv: sh(
          'i=0; while [ $i -lt 2000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done',
        ),
      }],
    });
    try {
      const [observation] = completedResult(run.outcome).observations;
      assertEquals(
        [observation.result, observation.reason, observation.exitCode],
        ["failed", "output_limit", null],
      );
      await assertCleanedUp(run);
    } finally {
      await disposeRun(run);
    }
  });

  runnerTest(
    "a missing tool is unavailable/tool_missing and later commands still run",
    async () => {
      const scratch = await committedScratch();
      const run = await runCheckExecutor({
        scratch,
        commands: [
          {
            id: "install",
            argv: ["bakery-no-such-tool-xyz", "--version"],
            mode: "guide",
          },
          { id: "unit", argv: sh("exit 0") },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        const [missing, passed] = result.observations;
        assertEquals(
          [missing.checkId, missing.result, missing.reason, missing.exitCode],
          ["install", "unavailable", "tool_missing", null],
        );
        assertEquals(missing.durationMs, 0);
        assertEquals([passed.checkId, passed.result], ["unit", "passed"]);
        // A guide command that is unavailable never blocks the required one.
        assertEquals(result.allRequired, true);
        assertEquals(result.failedCheckIds, []);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest("a required missing tool blocks", async () => {
    const scratch = await committedScratch();
    const run = await runCheckExecutor({
      scratch,
      commands: [
        { id: "unit", argv: ["bakery-no-such-tool-xyz"] },
        { id: "path", argv: ["./not/in/the/tree.sh"] },
      ],
    });
    try {
      const result = completedResult(run.outcome);
      assertEquals(
        result.observations.map(({ result, reason }) => `${result}/${reason}`),
        ["unavailable/tool_missing", "unavailable/tool_missing"],
      );
      assertEquals(result.allRequired, false);
      assertEquals(result.failedCheckIds.length, 2);
      await assertCleanedUp(run);
    } finally {
      await disposeRun(run);
    }
  });

  runnerTest(
    "a missing, tree or tag revision is unavailable/revision_unavailable and runs nothing",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      await gitText(scratch.dir, ["tag", "-a", "v1", "-m", "annotated"]);
      const tagObject = await gitText(scratch.dir, ["rev-parse", "v1"]);
      const tree = await gitText(scratch.dir, ["rev-parse", "HEAD^{tree}"]);
      assertNotEquals(tagObject, scratch.revision);
      const state = await stateWithCredentials();
      try {
        for (const revision of ["f".repeat(40), tree, tagObject]) {
          const run = await runCheckExecutor({
            scratch,
            state,
            revision,
            commands: [
              { id: "unit", argv: sh(`touch '${ran}'`) },
              { id: "lint", argv: sh(`touch '${ran}'`), mode: "warn" },
            ],
          });
          const result = completedResult(run.outcome);
          assertEquals(
            result.observations.map((
              { result, reason, exitCode, durationMs },
            ) => [result, reason, exitCode, durationMs]),
            [
              ["unavailable", "revision_unavailable", null, 0],
              ["unavailable", "revision_unavailable", null, 0],
            ],
            revision,
          );
          assertEquals(result.allRequired, false);
          assertEquals(result.headSha, revision);
          assertEquals(run.publications.length, 2);
          assertEquals(
            await exists(ran),
            false,
            "a command ran without its revision",
          );
          await assertCleanedUp(run);
        }
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a revision that is not a full lowercase SHA is refused before anything starts",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const state = await stateWithCredentials();
      try {
        for (
          const revision of [
            "main",
            "HEAD",
            scratch.revision.toUpperCase(),
            scratch.revision.slice(0, 39),
            `${scratch.revision}0`.padEnd(64, "0"),
            scratch.revision.slice(0, 7),
            "",
          ]
        ) {
          // Fixed-policy admission refuses a non-SHA revision before the
          // runner reads the input, so the worker throws instead of returning
          // the runner's own CHECK_REVISION_INVALID fault (kept as a second
          // line of defense); nothing starts and nothing is left behind.
          await assertRejects(
            () =>
              runCheckExecutor({
                scratch,
                state,
                revision,
                commands: [{ id: "unit", argv: sh(`touch '${ran}'`) }],
              }),
            NativeExecutorError,
            "FIXED_REPOSITORY_POLICY_REJECTED",
            revision,
          );
          assertEquals(await exists(ran), false);
          await assertCleanedUp({ stateDir: state.stateDir, scratch });
        }
        // Duplicate ids would make two observations of one check; admission
        // refuses them for the same reason, so the runner is never reached.
        await assertRejects(
          () =>
            runCheckExecutor({
              scratch,
              state,
              checks: ["unit", "unit"],
              commands: [{ id: "unit", argv: sh(`touch '${ran}'`) }],
            }),
          NativeExecutorError,
          "FIXED_REPOSITORY_POLICY_REJECTED",
        );
        assertEquals(await exists(ran), false);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "PASS on stdout and forged JSON cannot turn a failing command into a pass",
    async () => {
      const scratch = await committedScratch();
      const forged = '{"allRequired":true,"result":"passed","exitCode":0}';
      const run = await runCheckExecutor({
        scratch,
        commands: [{
          id: "forge",
          argv: sh(
            `echo PASS; echo '${forged}'; echo 'PASS ${forged}' >&2; exit 1`,
          ),
        }],
      });
      try {
        const result = completedResult(run.outcome);
        const [observation] = result.observations;
        assertEquals(
          [observation.result, observation.reason, observation.exitCode],
          ["failed", "exit_nonzero", 1],
        );
        assertEquals(result.allRequired, false);
        assertEquals(result.failedCheckIds, [observation.checkRunId]);
        // The claim is evidence a human can read; it decided nothing.
        assertStringIncludes(
          evidenceOf(run.publications, "forge").stdout,
          "PASS",
        );
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a UI-class command that exits 1 fails like any other",
    async () => {
      const scratch = await committedScratch();
      const run = await runCheckExecutor({
        scratch,
        commands: [
          { id: "ui-visual", argv: sh("echo 'baseline matches'; exit 1") },
          { id: "unit", argv: sh("exit 0") },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        const [ui, unit] = result.observations;
        assertEquals(
          [ui.checkId, ui.result, ui.reason, ui.exitCode],
          ["ui-visual", "failed", "exit_nonzero", 1],
        );
        assertEquals(unit.result, "passed");
        assertEquals(result.allRequired, false);
        assertEquals(result.failedCheckIds, [ui.checkRunId]);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a check id outside the fixed policy is refused and nothing runs",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const state = await stateWithCredentials();
      try {
        await assertRejects(
          () =>
            runCheckExecutor({
              scratch,
              state,
              checks: ["unit", "caller.command"],
              commands: [{ id: "unit", argv: sh(`touch '${ran}'`) }],
            }),
          NativeExecutorError,
          "FIXED_REPOSITORY_POLICY_REJECTED",
        );
        assertEquals(await exists(ran), false);
        assertEquals(await leftoverAttempts(state.stateDir), []);
        // A required command left out of the selection is refused the same way.
        await assertRejects(
          () =>
            runCheckExecutor({
              scratch,
              state,
              checks: ["lint"],
              commands: [
                { id: "unit", argv: sh(`touch '${ran}'`) },
                { id: "lint", argv: sh(`touch '${ran}'`), mode: "warn" },
              ],
            }),
          NativeExecutorError,
          "FIXED_REPOSITORY_POLICY_REJECTED",
        );
        assertEquals(await exists(ran), false);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a job with no repository profile or fixed policy fails closed with CHECK_POLICY_MISSING",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const state = await stateWithCredentials();
      const commands = [{ id: "unit", argv: sh(`touch '${ran}'`) }];
      try {
        const profile = await fixtureProfile(commands, {
          baseSha: scratch.baseSha,
        });
        const config = structuredClone(
          profile.context.config as Record<string, unknown>,
        );
        delete config.fixedPolicy;
        const withoutPolicy: Record<string, unknown> = {
          ...profile.context,
          config,
          digest: await sha256Hex(canonicalJson(config)),
        };
        delete withoutPolicy.fixedPolicyDigest;
        delete withoutPolicy.trustedCheckerConfigDigest;
        const legacy = await legacyProfileContext();
        const variants: Record<
          string,
          (value: JobAssignment) => JobAssignment
        > = {
          "no profile": (value) => {
            delete (value.input as Record<string, unknown>).repositoryProfile;
            return value;
          },
          "legacy v1 profile": (value) => {
            (value.input as Record<string, unknown>).repositoryProfile = legacy;
            return value;
          },
          "v2 profile without a fixed policy": (value) => {
            (value.input as Record<string, unknown>).repositoryProfile =
              withoutPolicy;
            return value;
          },
        };
        for (const [name, edit] of Object.entries(variants)) {
          const run = await runCheckExecutor({
            scratch,
            state,
            commands,
            assignment: edit,
          });
          assertEquals(faultCode(run.outcome), "CHECK_POLICY_MISSING", name);
          assertEquals(run.publications.length, 0, name);
          assertEquals(await exists(ran), false, name);
          await assertCleanedUp(run);
        }
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a cancellation kills the process group and removes the worktree and attempt root",
    async () => {
      const scratch = await committedScratch();
      const pidFile = join(scratch.markers, "pid");
      const controller = new AbortController();
      const state = await stateWithCredentials();
      try {
        const pending = runCheckExecutor({
          scratch,
          state,
          signal: controller.signal,
          commands: [{
            id: "unit",
            argv: sh(`echo $$ > '${pidFile}'; exec sleep 60`),
          }],
        });
        await waitFor(() => exists(pidFile), "child pid");
        assertEquals(
          (await leftoverAttempts(state.stateDir)).length,
          1,
          "the attempt root exists while the command runs",
        );
        controller.abort();
        const run = await pending;
        assertEquals(run.outcome.status, "canceled");
        assertEquals(
          (run.outcome as unknown as {
            cancellation: { processExited: boolean };
          }).cancellation.processExited,
          true,
        );
        const pid = (await Deno.readTextFile(pidFile)).trim();
        assertEquals(await survives(pid), false, "child survived abort");
        assertEquals(run.publications.length, 0);
        await assertCleanedUp(run);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a text-search checker bound to a magic rule is unavailable/unsupported_checker and never runs",
    async () => {
      const markers = await Deno.makeTempDir({
        prefix: "bakery-check-markers-",
      });
      const ran = join(markers, "ran");
      // Same basename as the real tool; running it would leave the marker.
      const scratch = await committedScratch({
        "bin/grep": `#!/bin/sh\ntouch '${ran}'\nexit 0\n`,
      }, markers);
      const run = await runCheckExecutor({
        scratch,
        commands: [
          { id: "magic.numbers", argv: ["./bin/grep", "-rn", "42", "."] },
          { id: "unit", argv: sh("exit 0") },
        ],
        rules: [boundRule("code.magicNumbers", "magic.numbers")],
      });
      try {
        const result = completedResult(run.outcome);
        const [magic, unit] = result.observations;
        assertEquals(
          [
            magic.result,
            magic.reason,
            magic.ruleKey,
            magic.exitCode,
            magic.durationMs,
          ],
          ["unavailable", "unsupported_checker", "code.magicNumbers", null, 0],
        );
        assertEquals(unit.result, "passed");
        assertEquals(result.allRequired, false);
        assertEquals(result.failedCheckIds, [magic.checkRunId]);
        assertEquals(await exists(ran), false, "the text-search tool ran");
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "exactly one enabled pinned rule hands its key and options to the child",
    async () => {
      const scratch = await committedScratch();
      const run = await runCheckExecutor({
        scratch,
        commands: [
          {
            id: "magic.numbers",
            argv: sh(
              `printf '%s|%s' "$${CHECK_RULE_KEY_ENV}" "$${CHECK_RULE_OPTIONS_ENV}"`,
            ),
          },
          {
            id: "unit",
            argv: sh(
              `printf '[%s][%s]' "\${${CHECK_RULE_KEY_ENV}-unset}" "\${${CHECK_RULE_OPTIONS_ENV}-unset}"`,
            ),
          },
        ],
        rules: [
          // A disabled rule on the same command does not count as a binding.
          boundRule("code.magicStrings", "magic.numbers", { enabled: false }),
          boundRule("code.magicNumbers", "magic.numbers"),
        ],
      });
      try {
        const result = completedResult(run.outcome);
        const [bound, unbound] = result.observations;
        assertEquals(bound.ruleKey, "code.magicNumbers");
        assertEquals(unbound.ruleKey, null);
        const entry = run.profile.pinned.entries.find((candidate) =>
          candidate.ruleKey === "code.magicNumbers"
        )!;
        assertEquals(
          evidenceOf(run.publications, "magic.numbers").stdout,
          `code.magicNumbers|${canonicalJson(entry.options)}`,
        );
        assertEquals(
          evidenceOf(run.publications, "unit").stdout,
          "[unset][unset]",
        );
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a command bound by two enabled rules is unavailable/rule_binding_ambiguous and never runs",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const run = await runCheckExecutor({
        scratch,
        commands: [{ id: "magic.all", argv: sh(`touch '${ran}'`) }],
        rules: [
          boundRule("code.magicNumbers", "magic.all"),
          boundRule("code.magicStrings", "magic.all"),
        ],
      });
      try {
        const result = completedResult(run.outcome);
        const [observation] = result.observations;
        assertEquals(
          [
            observation.result,
            observation.reason,
            observation.ruleKey,
            observation.exitCode,
          ],
          ["unavailable", "rule_binding_ambiguous", null, null],
        );
        assertEquals(result.allRequired, false);
        assertEquals(await exists(ran), false);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "every observation carries evidence whose digest equals the published bytes",
    async () => {
      const scratch = await committedScratch();
      const run = await runCheckExecutor({
        scratch,
        commands: [
          { id: "unit", argv: sh("echo ok") },
          { id: "lint", argv: sh("echo bad; exit 2"), mode: "warn" },
          { id: "gone", argv: ["bakery-no-such-tool-xyz"], mode: "guide" },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assertEquals(run.publications.length, 3);
        assertEquals(new Set(result.checkRunIds).size, 3);
        for (const [index, observation] of result.observations.entries()) {
          const published = run.publications[index];
          assertEquals(observation.evidence, published.ref);
          assertEquals(
            observation.outputDigest,
            await sha256OfBytes(published.request.bytes),
          );
          assertEquals(observation.evidence!.sha256, observation.outputDigest);
          const request = published.request;
          assertEquals(request.artifactType, "check");
          assertEquals(request.mediaType, "application/json");
          assertEquals(
            request.name,
            checkArtifactName(
              run.assignment.jobId,
              run.assignment.fence,
              observation.checkId,
            ),
          );
          assertEquals(
            request.idempotencyKey,
            `check:${run.assignment.jobId}:${run.assignment.fence}:${observation.checkId}`,
          );
          assertEquals(request.subjectHeadSha, scratch.revision);
          assertEquals(request.subjectBaseSha, scratch.baseSha);
          assertEquals(request.metadata, {
            checkId: observation.checkId,
            exitCode: observation.exitCode,
            reason: observation.reason,
          });
        }
        // A warn failure and an unavailable guide command never block.
        assertEquals(result.allRequired, true);
        assertEquals(result.failedCheckIds, []);
        assertEquals(
          new Set(run.publications.map(({ request }) => request.name)).size,
          3,
          "artifact names must differ per check",
        );
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "commands run in input order and a failed install does not stop later checks",
    async () => {
      const scratch = await committedScratch();
      const order = join(scratch.markers, "order");
      const log = (id: string) => `echo ${id} >> '${order}'`;
      const run = await runCheckExecutor({
        scratch,
        checks: ["install", "lint", "unit"],
        commands: [
          { id: "unit", argv: sh(log("unit")) },
          {
            id: "install",
            argv: sh(`${log("install")}; exit 7`),
            mode: "guide",
          },
          { id: "lint", argv: sh(`${log("lint")}; exit 1`), mode: "warn" },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assertEquals(
          result.observations.map(({ checkId, result }) =>
            `${checkId}:${result}`
          ),
          ["install:failed", "lint:failed", "unit:passed"],
        );
        assertEquals(await Deno.readTextFile(order), "install\nlint\nunit\n");
        assertEquals(result.allRequired, true);
        assertEquals(result.failedCheckIds, []);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "the attempt root is private, beside no credential file, and the child never sees one",
    async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      const run = await runCheckExecutor({
        scratch,
        state,
        commands: [
          { id: "env", argv: sh("env") },
          { id: "mode", argv: sh('stat -c %a "$HOME/.." "$HOME" "$TMPDIR"') },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assertEquals(result.observations.map(({ result }) => result), [
          "passed",
          "passed",
        ]);
        const environment = evidenceOf(run.publications, "env").stdout;
        const root = join(state.stateDir, "checks", run.assignment.attemptId);
        assertStringIncludes(environment, `HOME=${join(root, "home")}\n`);
        assertStringIncludes(environment, `TMPDIR=${join(root, "tmp")}\n`);
        for (
          const secret of ["registration.json", "spool.json", "BAKERY_WORKER"]
        ) {
          assert(
            !environment.includes(secret),
            `child environment names ${secret}`,
          );
        }
        assert(!environment.includes(`${state.stateDir}\n`));
        // The root, its HOME and its TMPDIR are owner-only.
        assertEquals(
          evidenceOf(run.publications, "mode").stdout,
          "700\n700\n700\n",
        );
        // Not the state directory, not a sibling of the credential files, not under one.
        assertNotEquals(dirname(root), state.stateDir);
        assertNotEquals(dirname(root), dirname(state.registrationPath));
        assert(!root.startsWith(`${state.registrationPath}/`));
        assert(!root.startsWith(`${state.spoolPath}/`));
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "an attempt root that would touch a credential file is refused before anything starts",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const state = await stateWithCredentials();
      try {
        for (
          const credential of [
            join(
              state.stateDir,
              "checks",
              "attempt-fixed",
              "registration.json",
            ),
            join(state.stateDir, "checks", "token.json"),
            join(state.stateDir, "checks", "attempt-fixed"),
          ]
        ) {
          const run = await runCheckExecutor({
            scratch,
            state,
            credentialPaths: () => [credential],
            assignment: (assignment) => ({
              ...assignment,
              attemptId: "attempt-fixed",
            }),
            commands: [{ id: "unit", argv: sh(`touch '${ran}'`) }],
          });
          assertEquals(
            faultCode(run.outcome),
            "CHECK_ATTEMPT_ROOT_UNSAFE",
            credential,
          );
          assertEquals(await exists(ran), false);
          assertEquals(await leftoverAttempts(state.stateDir), []);
        }
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "captured evidence is redacted, bounded and cannot be read as markup",
    async () => {
      const scratch = await committedScratch();
      const token = "x".repeat(43);
      const run = await runCheckExecutor({
        scratch,
        limits: { evidenceStreamBytes: 2_048 },
        redactionSecrets: ["hunter2-configured-secret"],
        commands: [{
          id: "leak",
          argv: sh(
            `echo ${token}; echo hunter2-configured-secret; echo '<script>alert(1)</script>'; i=0; while [ $i -lt 400 ]; do echo "filler line number $i"; i=$((i+1)); done; echo tail-marker`,
          ),
        }],
      });
      try {
        completedResult(run.outcome);
        const upload = run.publications[0].request;
        const text = new TextDecoder().decode(upload.bytes);
        assert(!text.includes(token), "lease token leaked into evidence");
        assert(
          !text.includes("hunter2"),
          "configured secret leaked into evidence",
        );
        assert(!text.includes("<script>"), "markup survived in evidence");
        const evidence = evidenceOf(run.publications, "leak");
        assertEquals(evidence.stdoutTruncated, true);
        assertStringIncludes(evidence.stdout, "tail-marker");
        assert(new TextEncoder().encode(evidence.stdout).length <= 2_048);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "wrapping delegates other actions and never lets the inner quality.check shadow the runner",
    async () => {
      const scratch = await committedScratch();
      const calls: string[] = [];
      const inner: WorkerExecutor = {
        // Models the test-only native smoke override that advertises quality.check.
        supportedActions: ["quality.check", "repository.inspect"],
        capturesNativeOutput: true,
        execute(assignment) {
          calls.push(assignment.action);
          return Promise.resolve({
            status: "completed",
            result: { inner: true },
          });
        },
      };
      const recorder = recordingPublisher();
      const state = await stateWithCredentials();
      try {
        const executor = createCheckExecutor(inner, {
          repository: scratch.dir,
          stateDir: state.stateDir,
          publishFor: recorder.publishFor,
          commandTimeLimitMs: 5_000,
        });
        assertEquals(executor.supportedActions, [
          "quality.check",
          "repository.inspect",
        ]);
        assertEquals(
          createCheckExecutor(createDeterministicExecutor(), {
            repository: scratch.dir,
            stateDir: state.stateDir,
            publishFor: recorder.publishFor,
            commandTimeLimitMs: 5_000,
          }).supportedActions,
          ["harness.implement", "quality.check"],
        );
        const run = await runCheckExecutor({
          scratch,
          state,
          inner,
          commands: [{ id: "unit", argv: sh("exit 0") }],
        });
        assertEquals(completedResult(run.outcome).observations.length, 1);
        assertEquals(calls, [], "the inner quality.check ran");
        const other = await executor.execute(
          {
            ...checkAssignment({
              revision: scratch.revision,
              checks: ["unit"],
            }),
            action: "repository.inspect",
          },
          new AbortController().signal,
        );
        assertEquals(other.status, "completed");
        assertEquals(calls, ["repository.inspect"]);
        await assertRejects(
          async () =>
            await executor.execute(
              {
                ...checkAssignment({
                  revision: scratch.revision,
                  checks: ["unit"],
                }),
                skillRefs: [{ skillId: crypto.randomUUID() }] as never,
              },
              new AbortController().signal,
            ),
          NativeExecutorError,
          "PREPARED_SKILL_ROOTS_UNSUPPORTED:quality.check",
        );
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "startup removes attempt roots and worktree records a crashed worker left behind",
    async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      try {
        const orphan = join(state.stateDir, "checks", crypto.randomUUID());
        await Deno.mkdir(orphan, { recursive: true });
        await gitText(scratch.dir, [
          "worktree",
          "add",
          "--detach",
          join(orphan, "worktree"),
          scratch.revision,
        ]);
        assertEquals((await extraWorktrees(scratch.dir)).length, 1);
        const executor = createCheckExecutor(createDeterministicExecutor(), {
          repository: scratch.dir,
          stateDir: state.stateDir,
          publishFor: recordingPublisher().publishFor,
          commandTimeLimitMs: 5_000,
        });
        await executor.initialize!();
        assertEquals(await leftoverAttempts(state.stateDir), []);
        assertEquals(await extraWorktrees(scratch.dir), []);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  Deno.test("planChecks takes argv from the policy and binds a rule only when exactly one enabled rule names the command", async () => {
    const baseSha = "1".repeat(40);
    const commands = [
      { id: "plain", argv: ["pnpm", "test"] },
      { id: "magic.one", argv: ["deno", "lint"] },
      { id: "magic.off", argv: ["deno", "lint"] },
      { id: "magic.two", argv: ["deno", "lint"] },
    ];
    const planWith = async (
      rules: ReturnType<typeof boundRule>[],
      ids: string[],
    ) => {
      const profile = await fixtureProfile(commands, { baseSha, rules });
      return {
        profile,
        plan: planChecks(
          profile.fixedPolicy as Parameters<typeof planChecks>[0],
          profile.pinned,
          ids,
        ),
      };
    };

    const single = await planWith(
      [
        boundRule("code.magicNumbers", "magic.one"),
        boundRule("code.magicStrings", "magic.off", { enabled: false }),
      ],
      ["plain", "magic.one", "magic.off", "unknown"],
    );
    const byId = Object.fromEntries(
      single.plan.map((entry) => [entry.checkId, entry]),
    );
    assertEquals(byId.plain, {
      checkId: "plain",
      argv: ["pnpm", "test"],
      ruleKey: null,
      ruleOptions: null,
      unavailable: null,
    });
    const numbers = single.profile.pinned.entries.find((entry) =>
      entry.ruleKey === "code.magicNumbers"
    )!;
    assertEquals(
      [byId["magic.one"].ruleKey, byId["magic.one"].unavailable],
      ["code.magicNumbers", null],
    );
    assertEquals(byId["magic.one"].ruleOptions, canonicalJson(numbers.options));
    // A disabled rule is not a binding.
    assertEquals(
      [byId["magic.off"].ruleKey, byId["magic.off"].ruleOptions],
      [null, null],
    );
    // A command the policy does not hold never gets argv from anywhere else.
    assertEquals(
      [byId.unknown.argv, byId.unknown.unavailable],
      [null, "policy_missing"],
    );

    const double = await planWith(
      [
        boundRule("code.magicNumbers", "magic.two"),
        boundRule("code.magicStrings", "magic.two"),
      ],
      ["magic.two"],
    );
    assertEquals(
      [double.plan[0].ruleKey, double.plan[0].unavailable],
      [null, "rule_binding_ambiguous"],
    );

    // A disabled twin leaves exactly one binding.
    const oneOfTwo = await planWith(
      [
        boundRule("code.magicNumbers", "magic.two", { enabled: false }),
        boundRule("code.magicStrings", "magic.two"),
      ],
      ["magic.two"],
    );
    assertEquals(
      [oneOfTwo.plan[0].ruleKey, oneOfTwo.plan[0].unavailable],
      ["code.magicStrings", null],
    );

    // Each text-search executable, bare or by path, is refused once a rule binds it.
    for (const [index, name] of CHECK_UNSUPPORTED_EXECUTABLES.entries()) {
      for (
        const argv0 of [name, `/usr/bin/${name}`, `./node_modules/.bin/${name}`]
      ) {
        const id = `search${index}`;
        const profile = await fixtureProfile(
          [{ id, argv: [argv0, "-rn", "42", "."] }],
          { baseSha, rules: [boundRule("code.magicNumbers", id)] },
        );
        const policy = profile.fixedPolicy as Parameters<typeof planChecks>[0];
        const [bound] = planChecks(policy, profile.pinned, [id]);
        assertEquals(bound.unavailable, "unsupported_checker", argv0);
        assertEquals(bound.ruleKey, "code.magicNumbers");
        // The same tool as a plain, unbound command is an ordinary command.
        const [free] = planChecks(policy, undefined, [id]);
        assertEquals(free.unavailable, null, `${argv0} unbound`);
      }
    }
    // A real checker bound to a magic rule is runnable.
    assertEquals(
      single.plan.find((e) => e.checkId === "magic.one")!.unavailable,
      null,
    );
  });

  runnerTest(
    "under the deployed worker grants a missing tool is tool_missing and a present tool runs",
    async () => {
      // The deployed worker reads only an exact list of paths and may spawn only
      // an exact list of executables (apps/worker/scripts/run-worker.sh), so a
      // file-API tool lookup would throw PermissionDenied for every tool. The
      // child below runs the executor under those very grants.
      const root = decodeURIComponent(
        new URL("../../..", import.meta.url).pathname,
      )
        .replace(/\/$/, "");
      const scratch = await committedScratch({ "marker.txt": "granted\n" });
      const state = await stateWithCredentials();
      try {
        const profile = await fixtureProfile(
          [
            { id: "install", argv: ["bakery-no-such-tool-xyz"], mode: "guide" },
            { id: "unit", argv: sh("cat marker.txt") },
          ],
          { baseSha: scratch.baseSha },
        );
        const assignment = checkAssignment({
          revision: scratch.revision,
          checks: ["install", "unit"],
          profile: profile.context,
        });
        const grants = readWorkerLaunchPermissions({
          BAKERY_SERVER_URL: "http://127.0.0.1:8000",
          BAKERY_WORKER_STATE_DIR: state.stateDir,
          BAKERY_WORKER_CAPABILITIES: "git",
          BAKERY_CODEX_HARNESS: "1",
          BAKERY_CODEX_HARNESS_REPOSITORY: scratch.dir,
          BAKERY_CODEX_AUTH_SOURCE_DIR: syntheticAuthSource("auth.json"),
        }, root);
        assert(grants.read.includes("/usr/bin/setsid"));
        assert(!grants.read.includes("/usr/bin/env"));
        const child = new URL("./runner-restricted.child.ts", import.meta.url);
        const output = await new Deno.Command("/usr/bin/setsid", {
          args: [
            Deno.execPath(),
            "run",
            "--no-prompt",
            "--config",
            join(root, "deno.json"),
            `--allow-read=${grants.read.join(",")}`,
            `--allow-write=${grants.write.join(",")}`,
            `--allow-run=${grants.run.join(",")}`,
            "--allow-env=PATH,DENO_DIR,TMPDIR,HOME",
            "--allow-sys=uid",
            decodeURIComponent(child.pathname),
            JSON.stringify({
              repository: scratch.dir,
              stateDir: state.stateDir,
              credentialPaths: [state.registrationPath, state.spoolPath],
              assignment,
            }),
          ],
          cwd: root,
          // The deployed worker grants `/usr/bin/git` by absolute path, and
          // Deno matches the path a bare `git` resolves to. A host whose PATH
          // lists `/bin` first (merged-usr Arch) resolves `/bin/git` and the
          // grant misses, so the case would fail for the host and not the
          // code. Pin the child's PATH the way a deployed worker has it.
          env: { PATH: "/usr/bin:/bin" },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const stderr = new TextDecoder().decode(output.stderr);
        assert(output.success, `restricted child failed: ${stderr}`);
        const report = JSON.parse(new TextDecoder().decode(output.stdout)) as {
          restricted: boolean;
          outcome: Parameters<typeof completedResult>[0];
          leftover: string[];
        };
        assertEquals(report.restricted, true, "the grants were not narrow");
        const result = completedResult(report.outcome);
        assertEquals(
          result.observations.map(({ checkId, result, reason }) =>
            `${checkId}:${result}/${reason}`
          ),
          ["install:unavailable/tool_missing", "unit:passed/verified"],
        );
        assertEquals(result.allRequired, true);
        assertEquals(report.leftover, []);
        assertEquals(await extraWorktrees(scratch.dir), []);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "main advertises quality.check only when a harness repository is configured",
    async () => {
      const scratch = await prepareScratchRepository("bakery-check-main-");
      try {
        for (const harness of [false, true]) {
          const stateDir = await Deno.makeTempDir({
            prefix: "bakery-check-main-state-",
          });
          const base = { ...supervisorConfig(stateDir), drainTimeoutMs: 500 };
          const config = harness
            ? {
              ...base,
              codingHarness: {
                name: "codex",
                executable: "codex",
                timeLimitMs: 5_000,
                repository: scratch.dir,
              },
              codexAuthSourceDir: syntheticAuthSource("auth.json"),
            }
            : base;
          let advertised: readonly string[] | undefined;
          let drain: Promise<void> | undefined;
          try {
            await main({
              config,
              executor: createDeterministicExecutor(),
              onSupervisor(supervisor) {
                advertised =
                  (supervisor as unknown as { state: SupervisorState })
                    .state.executor?.supportedActions;
                drain = supervisor.drain();
                supervisor.requestStop("TEST_CHECK_ADVERTISEMENT");
              },
            });
            await drain;
          } finally {
            await drain?.catch(() => undefined);
            await Deno.remove(stateDir, { recursive: true }).catch(() =>
              undefined
            );
          }
          assertEquals(
            advertised?.includes("quality.check"),
            harness,
            `harness configured: ${harness}`,
          );
        }
      } finally {
        await Deno.remove(scratch.dir, { recursive: true }).catch(() =>
          undefined
        );
      }
    },
  );

  registerRunnerBoundaryCases();
}
