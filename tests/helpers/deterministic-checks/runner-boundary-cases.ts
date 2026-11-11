import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import {
  CHECK_RUNNER_LIMITS,
  createCheckExecutor,
} from "../../../apps/worker/src/check-runner.ts";
import { createDeterministicExecutor } from "../../../apps/worker/src/executor.ts";
import { gitText } from "../harness.ts";
import {
  assertCleanedUp,
  committedScratch,
  completedResult,
  disposeRun,
  evidenceOf,
  exists,
  extraWorktrees,
  faultCode,
  leftoverAttempts,
  recordingPublisher,
  runCheckExecutor,
  runnerTest,
  sh,
  stateWithCredentials,
  survives,
  waitFor,
} from "./runner-fixture.ts";

/**
 * Boundary cases for the worker `quality.check` runner: where commands run,
 * which attempt ids are accepted, what happens when a process group cannot be
 * confirmed stopped, what a command can do to the tree it leaves behind, and
 * how long an attempt may take. Every case runs real processes against a real
 * git repository.
 */

/** A group-kill helper that does not exist: the kill cannot be confirmed. */
const MISSING_KILL_HELPER = "/nonexistent/bakery-kill";

/** Mode bits of `path`, without the file type. */
async function modeOf(path: string): Promise<number> {
  return (await Deno.stat(path)).mode! & 0o777;
}

/** A directory outside the state tree that a symlink in a worktree points at. */
async function outsideDirectory(): Promise<string> {
  const outside = await Deno.makeTempDir({ prefix: "bakery-check-outside-" });
  await Deno.writeTextFile(join(outside, "keep.txt"), "keep\n");
  await Deno.chmod(outside, 0o500);
  return outside;
}

async function removeOutside(outside: string): Promise<void> {
  await Deno.chmod(outside, 0o700).catch(() => undefined);
  await Deno.remove(outside, { recursive: true }).catch(() => undefined);
}

/** Kills a leftover process group by its leader pid with the real helper. */
async function killGroup(pidFile: string): Promise<void> {
  try {
    const pid = (await Deno.readTextFile(pidFile)).trim();
    await new Deno.Command("/usr/bin/kill", {
      args: ["-s", "KILL", "--", `-${pid}`],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Never started, or already gone.
  }
}

export function registerRunnerBoundaryCases(): void {
  runnerTest(
    "commands run in the candidate worktree at the candidate revision, never in the operator checkout",
    async () => {
      // The operator checkout stays on commit A; the candidate is commit B and
      // its tree differs. A command that ran in the operator checkout would see A.
      const scratch = await committedScratch({ "marker.txt": "operator\n" });
      const operatorHead = scratch.revision;
      await Deno.writeTextFile(join(scratch.dir, "marker.txt"), "candidate\n");
      await Deno.writeTextFile(join(scratch.dir, "candidate-only.txt"), "b\n");
      await gitText(scratch.dir, ["add", "-A"]);
      await gitText(scratch.dir, ["commit", "-m", "candidate B"]);
      const candidate = await gitText(scratch.dir, ["rev-parse", "HEAD"]);
      assertNotEquals(candidate, operatorHead);
      await gitText(scratch.dir, ["branch", "candidate-b", candidate]);
      await gitText(scratch.dir, [
        "checkout",
        "--quiet",
        "--detach",
        operatorHead,
      ]);
      assertEquals(
        await Deno.readTextFile(join(scratch.dir, "marker.txt")),
        "operator\n",
        "the operator checkout is on commit A",
      );
      const state = await stateWithCredentials();
      const stateReal = await Deno.realPath(state.stateDir);
      try {
        const run = await runCheckExecutor({
          scratch: { ...scratch, revision: candidate },
          state,
          commands: [
            {
              id: "facts",
              argv: sh(
                `printf 'head=%s\\nmarker=%s\\nextra=%s\\n' "$(git rev-parse HEAD)" "$(cat marker.txt)" "$(cat candidate-only.txt)"; pwd -P`,
              ),
            },
            {
              id: "asserts",
              argv: sh(
                `test "$(git rev-parse HEAD)" = '${candidate}' && test "$(cat marker.txt)" = candidate && test -f candidate-only.txt`,
              ),
            },
            { id: "writes", argv: sh("echo written > written-by-check.txt") },
          ],
        });
        const result = completedResult(run.outcome);
        assertEquals(
          result.observations.map(({ checkId, result, reason }) =>
            `${checkId}:${result}/${reason}`
          ),
          [
            "facts:passed/verified",
            "asserts:passed/verified",
            "writes:passed/verified",
          ],
        );
        assertEquals(result.headSha, candidate);
        const lines = evidenceOf(run.publications, "facts").stdout.trimEnd()
          .split("\n");
        assertEquals(lines.slice(0, 3), [
          `head=${candidate}`,
          "marker=candidate",
          "extra=b",
        ]);
        // The working directory is the attempt's own worktree.
        assertEquals(
          lines[3],
          join(stateReal, "checks", run.assignment.attemptId, "worktree"),
        );
        assertNotEquals(lines[3], await Deno.realPath(scratch.dir));
        // The operator checkout was neither moved nor written to.
        assertEquals(
          await gitText(scratch.dir, ["rev-parse", "HEAD"]),
          operatorHead,
        );
        assertEquals(
          await Deno.readTextFile(join(scratch.dir, "marker.txt")),
          "operator\n",
        );
        assertFalse(await exists(join(scratch.dir, "written-by-check.txt")));
        assertEquals(await gitText(scratch.dir, ["status", "--porcelain"]), "");
        await assertCleanedUp(run);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "the runner takes its revision pattern from the contract and keeps no copy",
    async () => {
      // The worker and the server must refuse the same revisions, so the
      // pattern lives in one place (packages/contracts/src/check-evidence.ts).
      const source = await Deno.readTextFile(
        new URL("../../../apps/worker/src/check-runner.ts", import.meta.url),
      );
      assertStringIncludes(source, "CHECK_REVISION_PATTERN.test(");
      assertFalse(
        /\/\^\[0-9a-f\]\{40\}\$\//.test(source),
        "check-runner.ts defines its own 40-hex pattern",
      );
      assertFalse(source.includes("const REVISION_PATTERN"));
    },
  );

  runnerTest(
    "an attempt id that could leave the attempt root is refused before anything starts",
    async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      const ran = join(scratch.markers, "ran");
      try {
        const refused = [
          "../escape",
          "..",
          ".",
          "a/b",
          "/etc",
          "",
          "a b",
          "evil\nname",
          "é",
          "x".repeat(129),
        ];
        for (const attemptId of refused) {
          const run = await runCheckExecutor({
            scratch,
            state,
            commands: [{ id: "unit", argv: sh(`echo ran > '${ran}'`) }],
            assignment: (assignment) => ({ ...assignment, attemptId }),
          });
          const label = JSON.stringify(attemptId);
          assertEquals(faultCode(run.outcome), "CHECK_INPUT_INVALID", label);
          assertEquals(run.publications.length, 0, label);
          assertFalse(await exists(ran), `${label} ran a command`);
          // Nothing was created beside or above the attempt root either.
          assertEquals(
            (await Array.fromAsync(Deno.readDir(state.stateDir)))
              .map(({ name }) => name).sort(),
            ["registration.json", "spool.json"],
            label,
          );
          assertEquals(await extraWorktrees(scratch.dir), [], label);
        }
        // A safe id with the same characters in a legal order is accepted.
        const accepted = await runCheckExecutor({
          scratch,
          state,
          commands: [{ id: "unit", argv: sh("exit 0") }],
          assignment: (assignment) => ({ ...assignment, attemptId: "a.b-c_1" }),
        });
        assertEquals(
          completedResult(accepted.outcome).observations[0].result,
          "passed",
        );
        await assertCleanedUp(accepted);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a deadline or output cut whose group kill cannot be confirmed is CHECK_HARNESS_TEARDOWN_UNCONFIRMED",
    async () => {
      for (const breach of ["deadline", "output_limit"] as const) {
        const scratch = await committedScratch();
        const pidFile = join(scratch.markers, "pid");
        const state = await stateWithCredentials();
        try {
          // The pid is written before any output, so the cut cannot race it. The
          // leader execs into sleep, so killing the leader leaves no orphan.
          const script = breach === "deadline"
            ? `echo $$ > '${pidFile}'; exec sleep 60`
            : `echo $$ > '${pidFile}'; head -c 4096 /dev/zero | tr '\\0' x; exec sleep 60`;
          const run = await runCheckExecutor({
            scratch,
            state,
            groupKillExecutable: MISSING_KILL_HELPER,
            commandTimeLimitMs: breach === "deadline" ? 500 : 20_000,
            limits: breach === "output_limit" ? { outputBytes: 1_024 } : {},
            commands: [{ id: "unit", argv: sh(script) }],
          });
          assertEquals(
            faultCode(run.outcome),
            "CHECK_HARNESS_TEARDOWN_UNCONFIRMED",
            breach,
          );
          const fault = (run.outcome as unknown as {
            fault: { retryable: boolean };
          }).fault;
          assertEquals(fault.retryable, false, breach);
          // No row is reported for a process the worker could not stop.
          assertEquals(run.publications.length, 0, breach);
          const pid = (await Deno.readTextFile(pidFile)).trim();
          assertEquals(await survives(pid), false, `${breach}: leader lives`);
          await assertCleanedUp(run);
        } finally {
          await killGroup(pidFile);
          await disposeRun({ stateDir: state.stateDir, scratch });
        }
      }
    },
  );

  runnerTest(
    "a cancellation whose group kill cannot be confirmed reports an unknown termination",
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
          groupKillExecutable: MISSING_KILL_HELPER,
          commands: [{
            id: "unit",
            argv: sh(`echo $$ > '${pidFile}'; exec sleep 60`),
          }],
        });
        await waitFor(() => exists(pidFile), "child pid");
        controller.abort();
        const run = await pending;
        assertEquals(run.outcome.status, "canceled");
        const cancellation = (run.outcome as unknown as {
          cancellation: { processExited: boolean; terminationStatus: string };
        }).cancellation;
        assertEquals(cancellation.terminationStatus, "unknown");
        assertFalse(cancellation.processExited);
        assertEquals(run.publications.length, 0);
        await assertCleanedUp(run);
      } finally {
        await killGroup(pidFile);
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "a command that locks or write-protects directories cannot leave an undeletable attempt root",
    async () => {
      const scratch = await committedScratch();
      const outside = await outsideDirectory();
      const state = await stateWithCredentials();
      try {
        const run = await runCheckExecutor({
          scratch,
          state,
          commands: [{
            id: "unit",
            argv: sh(
              `mkdir -p locked/inner readonly/sub && echo x > locked/inner/f && echo y > readonly/sub/f && ln -s '${outside}' outside-link && chmod -R a-w readonly && chmod 000 locked`,
            ),
          }],
        });
        const [observation] = completedResult(run.outcome).observations;
        assertEquals(
          [observation.result, observation.reason],
          ["passed", "verified"],
        );
        // Both the attempt root and git's record of the worktree are gone.
        assertEquals(
          await leftoverAttempts(state.stateDir),
          [],
          "attempt root left",
        );
        assertEquals(
          await extraWorktrees(scratch.dir),
          [],
          "worktree record left",
        );
        // Cleanup never followed the symlink out of the tree.
        assertEquals(await modeOf(outside), 0o500);
        assert(await exists(join(outside, "keep.txt")));
      } finally {
        await removeOutside(outside);
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "startup removes a locked, write-protected or symlinked orphan without following a link",
    async () => {
      const scratch = await committedScratch();
      const outside = await outsideDirectory();
      const state = await stateWithCredentials();
      try {
        const orphan = join(state.stateDir, "checks", crypto.randomUUID());
        await Deno.mkdir(orphan, { recursive: true });
        const worktree = join(orphan, "worktree");
        await gitText(scratch.dir, [
          "worktree",
          "add",
          "--detach",
          worktree,
          scratch.revision,
        ]);
        await Deno.mkdir(join(worktree, "locked", "inner"), {
          recursive: true,
        });
        await Deno.mkdir(join(worktree, "readonly", "sub"), {
          recursive: true,
        });
        await Deno.writeTextFile(join(worktree, "locked", "inner", "f"), "x");
        await Deno.writeTextFile(join(worktree, "readonly", "sub", "f"), "y");
        await Deno.symlink(outside, join(worktree, "outside-link"));
        // A top-level entry that is itself a link out of the state tree.
        await Deno.symlink(outside, join(state.stateDir, "checks", "evil"));
        for (
          const path of [
            join(worktree, "readonly", "sub"),
            join(worktree, "readonly"),
          ]
        ) await Deno.chmod(path, 0o500);
        await Deno.chmod(join(worktree, "locked"), 0o000);
        assertEquals((await extraWorktrees(scratch.dir)).length, 1);

        const executor = createCheckExecutor(createDeterministicExecutor(), {
          repository: scratch.dir,
          stateDir: state.stateDir,
          publishFor: recordingPublisher().publishFor,
          commandTimeLimitMs: 5_000,
        });
        await executor.initialize!();

        assertEquals(
          await leftoverAttempts(state.stateDir),
          [],
          "orphan left",
        );
        assertEquals(await extraWorktrees(scratch.dir), []);
        assertEquals(await modeOf(outside), 0o500);
        assert(await exists(join(outside, "keep.txt")));
      } finally {
        await removeOutside(outside);
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  );

  runnerTest(
    "the attempt budget is code-owned and bounds the whole attempt",
    () => {
      assertEquals(CHECK_RUNNER_LIMITS.attemptMs, 4 * 60 * 60 * 1000);
      assertEquals(CHECK_RUNNER_LIMITS.checkoutMs, 5 * 60 * 1000);
      assert(CHECK_RUNNER_LIMITS.checkoutMs < CHECK_RUNNER_LIMITS.attemptMs);
      return Promise.resolve();
    },
  );

  runnerTest(
    "a spent attempt budget cuts the running command and skips the rest as unavailable/skipped",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const run = await runCheckExecutor({
        scratch,
        limits: { attemptMs: 2_500 },
        commands: [
          { id: "slow", argv: sh("exec sleep 60") },
          { id: "after", argv: sh(`echo ran >> '${ran}'`) },
          { id: "later", argv: sh(`echo ran >> '${ran}'`), mode: "warn" },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assert(
          workerActionOutputSchema("quality.check").safeParse(result).success,
        );
        assertEquals(
          result.observations.map(({ checkId, result, reason, exitCode }) =>
            `${checkId}:${result}/${reason}/${exitCode}`
          ),
          [
            "slow:failed/deadline/null",
            "after:unavailable/skipped/null",
            "later:unavailable/skipped/null",
          ],
        );
        const [slow, after, later] = result.observations;
        // The command ran for what was left of the budget, not its own limit.
        assert(slow.durationMs >= 300 && slow.durationMs < 5_000);
        assertEquals([after.durationMs, later.durationMs], [0, 0]);
        assertFalse(await exists(ran), "a skipped command ran");
        // A skipped check still has evidence that names why it did not run.
        assertEquals(evidenceOf(run.publications, "after").reason, "skipped");
        assertEquals(result.allRequired, false);
        assertEquals(result.failedCheckIds, [
          slow.checkRunId,
          after.checkRunId,
        ]);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a budget spent before the first command skips every check without starting a process",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const run = await runCheckExecutor({
        scratch,
        limits: { attemptMs: 1 },
        commands: [
          { id: "one", argv: sh(`echo ran >> '${ran}'`) },
          { id: "two", argv: sh(`echo ran >> '${ran}'`) },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assertEquals(
          result.observations.map(({ result, reason }) =>
            `${result}/${reason}`
          ),
          ["unavailable/skipped", "unavailable/skipped"],
        );
        assertFalse(await exists(ran), "a skipped command ran");
        assertEquals(result.allRequired, false);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );

  runnerTest(
    "a checkout past its own bound is unavailable/revision_unavailable and runs nothing",
    async () => {
      const scratch = await committedScratch();
      const ran = join(scratch.markers, "ran");
      const run = await runCheckExecutor({
        scratch,
        // The checkout has its own deadline: the git deadline stays generous.
        limits: { checkoutMs: 1 },
        commands: [
          { id: "one", argv: sh(`echo ran >> '${ran}'`) },
          { id: "two", argv: sh(`echo ran >> '${ran}'`), mode: "guide" },
        ],
      });
      try {
        const result = completedResult(run.outcome);
        assertEquals(
          result.observations.map(({ result, reason }) =>
            `${result}/${reason}`
          ),
          [
            "unavailable/revision_unavailable",
            "unavailable/revision_unavailable",
          ],
        );
        assertFalse(await exists(ran), "a command ran without a checkout");
        assertEquals(result.allRequired, false);
        await assertCleanedUp(run);
      } finally {
        await disposeRun(run);
      }
    },
  );
}
