import { assertEquals } from "@std/assert";
import { deriveCheckPins } from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  parseCheckReport,
  verifyCheckReport,
} from "../../../apps/server/src/modules/delivery/check-report.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  boundRule,
  committedScratch,
  completedResult,
  disposeRun,
  type FixtureCommand,
  type FixtureRule,
  runCheckExecutor,
  stateWithCredentials,
} from "./runner-fixture.ts";

/**
 * The report the real `quality.check` runner produces, with real processes in
 * a scratch repository, must satisfy the server's verification of the same
 * job input. This is the contract between the two halves: any drift in an
 * observation's shape, exit code, duration, rule key or echoed identity shows
 * up here before it shows up as a rejected production result.
 */

const WINDOW_MS = 3_600_000;
const sh = (script: string) => ["sh", "-c", script];
const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

async function verifies(
  run: Awaited<ReturnType<typeof runCheckExecutor>>,
): Promise<ReturnType<typeof completedResult>> {
  const result = completedResult(run.outcome);
  const pins = await deriveCheckPins(run.assignment.input);
  verifyCheckReport(parseCheckReport(result), pins, WINDOW_MS);
  return result;
}

export function registerFinalizerWorkerCases(): void {
  Deno.test({
    name:
      "the report of the real runner verifies against the pins of the same job",
    ...SANITIZERS,
    fn: async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      try {
        const commands: FixtureCommand[] = [
          { id: "pass", argv: sh("exit 0") },
          { id: "fail", argv: sh("exit 3") },
          {
            id: "forge",
            argv: sh("echo 'PASS {\"allRequired\":true}'; exit 1"),
            mode: "warn",
          },
          { id: "killed", argv: sh("kill -9 $$"), mode: "warn" },
          { id: "missing", argv: ["/nonexistent/bakery-tool"], mode: "guide" },
          { id: "magic", argv: ["grep", "-r", "x", "."] },
        ];
        const rules: FixtureRule[] = [boundRule("code.magicNumbers", "magic")];
        const run = await runCheckExecutor({
          scratch,
          state,
          commands,
          rules,
        });
        const result = await verifies(run);
        assertEquals(
          result.observations.map((
            { checkId, result, reason, exitCode, ruleKey },
          ) => [checkId, result, reason, exitCode, ruleKey]),
          [
            ["pass", "passed", "verified", 0, null],
            ["fail", "failed", "exit_nonzero", 3, null],
            ["forge", "failed", "exit_nonzero", 1, null],
            ["killed", "failed", "signal", null, null],
            ["missing", "unavailable", "tool_missing", null, null],
            [
              "magic",
              "unavailable",
              "unsupported_checker",
              null,
              "code.magicNumbers",
            ],
          ],
        );
        assertEquals(result.allRequired, false);

        // The same report with a forged verdict is what the server refuses.
        const pins = await deriveCheckPins(run.assignment.input);
        let refusal: unknown;
        try {
          verifyCheckReport(
            parseCheckReport({ ...result, allRequired: true }),
            pins,
            WINDOW_MS,
          );
        } catch (error) {
          refusal = error;
        }
        assertEquals(
          refusal instanceof StandardError &&
            refusal.params?.reason === "check_output_mismatch",
          true,
        );
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  });

  Deno.test({
    name:
      "deadline, output cap, ambiguous binding and an unreachable revision verify too",
    ...SANITIZERS,
    fn: async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      try {
        const slow = await runCheckExecutor({
          scratch,
          state,
          commandTimeLimitMs: 300,
          limits: { outputBytes: 2_000 },
          commands: [
            { id: "slow", argv: sh("sleep 30") },
            { id: "loud", argv: sh("yes bakery | head -c 100000") },
          ],
        });
        const result = await verifies(slow);
        assertEquals(
          result.observations.map(({ reason, exitCode }) => [reason, exitCode]),
          [["deadline", null], ["output_limit", null]],
        );

        const shared = await runCheckExecutor({
          scratch,
          state,
          commands: [{ id: "shared", argv: sh("exit 0") }],
          rules: [
            boundRule("code.magicNumbers", "shared"),
            boundRule("code.magicStrings", "shared"),
          ],
        });
        const ambiguous = await verifies(shared);
        assertEquals(
          ambiguous.observations.map((
            { reason, ruleKey },
          ) => [reason, ruleKey]),
          [["rule_binding_ambiguous", null]],
        );

        const gone = await runCheckExecutor({
          scratch,
          state,
          revision: "f".repeat(40),
          commands: [{ id: "unit", argv: sh("exit 0") }],
        });
        const missing = await verifies(gone);
        assertEquals(
          missing.observations.map(({ reason, durationMs, exitCode }) => [
            reason,
            durationMs,
            exitCode,
          ]),
          [["revision_unavailable", 0, null]],
        );
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  });

  Deno.test({
    name:
      "a command two rules bind is ambiguous when the revision is reachable and unreachable-revision with the others when it is not, and both verify",
    ...SANITIZERS,
    fn: async () => {
      const scratch = await committedScratch();
      const state = await stateWithCredentials();
      try {
        const options = {
          scratch,
          state,
          commands: [
            { id: "unit", argv: sh("exit 0") },
            { id: "shared", argv: sh("exit 0") },
          ] satisfies FixtureCommand[],
          rules: [
            boundRule("code.magicNumbers", "shared"),
            boundRule("code.magicStrings", "shared"),
          ],
        };
        const observed = (result: ReturnType<typeof completedResult>) =>
          result.observations.map((
            { checkId, result, reason, ruleKey, exitCode, durationMs },
          ) => [checkId, result, reason, ruleKey, exitCode, durationMs]);

        // Reachable: the first command runs, the bound one is the ambiguity.
        const reachable = await verifies(await runCheckExecutor(options));
        assertEquals(observed(reachable), [
          [
            "unit",
            "passed",
            "verified",
            null,
            0,
            reachable.observations[0]!.durationMs,
          ],
          ["shared", "unavailable", "rule_binding_ambiguous", null, null, 0],
        ]);

        // Unreachable: the checkout fails before any command is planned, so
        // the ambiguous command reports the revision like every other one,
        // and the server accepts that honest report.
        const gone = await verifies(
          await runCheckExecutor({ ...options, revision: "f".repeat(40) }),
        );
        assertEquals(observed(gone), [
          ["unit", "unavailable", "revision_unavailable", null, null, 0],
          ["shared", "unavailable", "revision_unavailable", null, null, 0],
        ]);
        assertEquals(gone.allRequired, false);
      } finally {
        await disposeRun({ stateDir: state.stateDir, scratch });
      }
    },
  });
}
