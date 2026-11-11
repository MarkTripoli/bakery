import {
  type CheckCommand,
  type CheckReportFixture,
  DEFAULT_COMMANDS,
  type Outcome,
  type PolicyOptions,
  type Rejection,
} from "./finalizer-policy.ts";
import { magicRuleEntry } from "./identity-fixture.ts";

/**
 * Hostile `quality.check` reports that need only an honest report to build.
 * The unit lane replays them against the pure verification and the security
 * lane against the finalizer and the real route, so one table pins both.
 */

export const MISMATCH: Rejection = {
  code: "VALIDATION_FAILED",
  reason: "check_output_mismatch",
};
export const EVIDENCE: Rejection = {
  code: "VALIDATION_FAILED",
  reason: "check_evidence_invalid",
};
export const POLICY: Rejection = {
  code: "VALIDATION_FAILED",
  reason: "check_policy_missing",
};

export type Observation = CheckReportFixture["observations"][number];

/** A hostile report, with the scenario it is forged for. */
export type Forgery = {
  name: string;
  expected: Rejection;
  options?: PolicyOptions;
  outcomes?: Record<string, Outcome>;
  /**
   * Problem code of the real route when the wire schema refuses the report
   * before the finalizer runs; defaults to `expected.code`.
   */
  routeCode?: string;
  forge(honest: { report: CheckReportFixture }): unknown;
};

export const MAGIC: readonly CheckCommand[] = [
  ...DEFAULT_COMMANDS,
  { id: "magic.numbers", argv: ["deno", "lint"], mode: "require" },
];
export const RULE_SCENARIO: PolicyOptions = {
  commands: MAGIC,
  rules: [magicRuleEntry("code.magicNumbers", "magic.numbers")],
};
export const AMBIGUOUS_SCENARIO: PolicyOptions = {
  commands: [
    { id: "unit", argv: ["pnpm", "test:unit"], mode: "require" },
    { id: "magic.shared", argv: ["deno", "lint"], mode: "require" },
  ],
  rules: [
    magicRuleEntry("code.magicNumbers", "magic.shared"),
    magicRuleEntry("code.magicStrings", "magic.shared"),
  ],
};

export const OTHER = "9".repeat(40);

/** Replaces observation `index`, keeping everything else of the report. */
export function withObservation(
  report: CheckReportFixture,
  index: number,
  patch: Partial<Observation> | Record<string, unknown>,
): CheckReportFixture {
  const observations = report.observations.map((observation, at) =>
    at === index ? { ...observation, ...patch } : observation
  );
  return { ...report, observations } as CheckReportFixture;
}

export function claim(
  report: CheckReportFixture,
  claimed: { allRequired?: boolean; failedCheckIds?: string[] },
): CheckReportFixture {
  return { ...report, ...claimed };
}

export const ECHO_FORGERIES: Forgery[] = [
  {
    name: "allRequired true echoed over a failed required observation",
    expected: MISMATCH,
    outcomes: { unit: "fail" },
    forge: ({ report }) =>
      claim(report, { allRequired: true, failedCheckIds: [] }),
  },
  {
    name: "allRequired true echoed with the failed row still listed",
    expected: MISMATCH,
    outcomes: { unit: "fail" },
    forge: ({ report }) => claim(report, { allRequired: true }),
  },
  {
    name: "failedCheckIds emptied over a failed required observation",
    expected: MISMATCH,
    outcomes: { unit: "fail" },
    forge: ({ report }) => claim(report, { failedCheckIds: [] }),
  },
  {
    name: "a warn command listed as a failed required row",
    expected: MISMATCH,
    outcomes: { lint: "fail" },
    forge: ({ report }) =>
      claim(report, {
        allRequired: false,
        failedCheckIds: [report.observations[1]!.checkRunId],
      }),
  },
  {
    name: "allRequired false claimed over all-passed observations",
    expected: MISMATCH,
    forge: ({ report }) => claim(report, { allRequired: false }),
  },
  {
    name: "a foreign headSha",
    expected: MISMATCH,
    forge: ({ report }) => ({ ...report, headSha: OTHER }),
  },
  {
    name: "a foreign baseSha",
    expected: MISMATCH,
    forge: ({ report }) => ({ ...report, baseSha: OTHER }),
  },
  {
    name: "a foreign policyDigest",
    expected: MISMATCH,
    forge: ({ report }) => ({ ...report, policyDigest: "c".repeat(64) }),
  },
];

export const SELECTION_FORGERIES: Forgery[] = [
  {
    name: "an extra observation for a command the job did not select",
    expected: MISMATCH,
    forge: ({ report }) => {
      const extra = {
        ...report.observations[0]!,
        checkRunId: crypto.randomUUID(),
        checkId: "deploy",
      };
      return {
        ...report,
        observations: [...report.observations, extra],
        checkRunIds: [...report.checkRunIds, extra.checkRunId],
      };
    },
  },
  {
    name: "a missing observation",
    expected: MISMATCH,
    forge: ({ report }) => ({
      ...report,
      observations: report.observations.slice(0, 2),
      checkRunIds: report.checkRunIds.slice(0, 2),
    }),
  },
  {
    name: "a duplicate observation of one command",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 1, { checkId: "unit" }),
  },
  {
    name: "observations in another order than the job selected",
    expected: MISMATCH,
    forge: ({ report }) => {
      const observations = [
        report.observations[1]!,
        report.observations[0]!,
        report.observations[2]!,
      ];
      return {
        ...report,
        observations,
        checkRunIds: observations.map(({ checkRunId }) => checkRunId),
      };
    },
  },
  {
    name: "an observation of a command outside the fixed policy",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 1, { checkId: "deploy" }),
  },
  {
    name: "checkRunIds in another order than the observations",
    expected: MISMATCH,
    forge: ({ report }) => ({
      ...report,
      checkRunIds: [...report.checkRunIds].reverse(),
    }),
  },
  {
    name: "checkRunIds that name a row the report does not carry",
    expected: MISMATCH,
    forge: ({ report }) => ({
      ...report,
      checkRunIds: [...report.checkRunIds.slice(0, 2), crypto.randomUUID()],
    }),
  },
  {
    name: "one row id reused by two observations",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 1, {
        checkRunId: report.observations[0]!.checkRunId,
      }),
  },
  {
    name: "a title check posing as a command observation",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 0, { kind: "title" }),
  },
  {
    name: "a merge message check posing as a command observation",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 2, { kind: "merge_message" }),
  },
  {
    name: "an unknown field carrying the command output",
    expected: MISMATCH,
    routeCode: "UNPROCESSABLE",
    forge: ({ report }) => withObservation(report, 0, { stdout: "PASS" }),
  },
];

export const COHERENCE_FORGERIES: Forgery[] = [
  {
    name: "a pass with a non-zero exit code",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 0, { exitCode: 1 }),
  },
  {
    name: "a pass with no exit code",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 0, { exitCode: null }),
  },
  {
    name: "a failure that claims to be verified",
    expected: MISMATCH,
    outcomes: { unit: "fail" },
    forge: ({ report }) => withObservation(report, 0, { reason: "verified" }),
  },
  {
    name: "a non-zero exit reported with exit code zero",
    expected: MISMATCH,
    outcomes: { unit: "fail" },
    forge: ({ report }) => withObservation(report, 0, { exitCode: 0 }),
  },
  {
    name: "a signal that carries an exit code",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "failed",
        reason: "signal",
        exitCode: 9,
      }),
  },
  {
    name: "an unavailable command that carries an exit code",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "tool_missing",
        exitCode: 3,
        durationMs: 0,
      }),
  },
  {
    name: "an unavailable command that claims it ran",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "tool_missing",
        exitCode: null,
        durationMs: 50,
      }),
  },
  {
    name: "a skipped command that carries an exit code",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "skipped",
        exitCode: 2,
        durationMs: 0,
      }),
  },
  {
    name: "a skipped command that claims it ran",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "skipped",
        exitCode: null,
        durationMs: 50,
      }),
  },
  {
    name: "a skipped reason on a failed result",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "failed",
        reason: "skipped",
        exitCode: null,
      }),
  },
  {
    name: "a skipped reason on a pass",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, { result: "passed", reason: "skipped" }),
  },
  {
    name: "a rule violation reason on a command",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "failed",
        reason: "rule_violation",
        exitCode: null,
      }),
  },
  {
    name: "a pending command in a completed result",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "pending",
        reason: "awaiting_result",
        exitCode: null,
        durationMs: 0,
      }),
  },
  {
    name: "a reason that does not explain the result",
    expected: MISMATCH,
    forge: ({ report }) => withObservation(report, 0, { reason: "deadline" }),
  },
  {
    name: "durations longer than the attempt has existed",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, { durationMs: 7_200_000 }),
  },
  {
    name: "a duration over the contract maximum",
    expected: MISMATCH,
    routeCode: "UNPROCESSABLE",
    forge: ({ report }) =>
      withObservation(report, 0, { durationMs: 86_400_001 }),
  },
  {
    name: "a rule key on a command no rule binds",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, { ruleKey: "code.magicNumbers" }),
  },
  {
    name: "no rule key on a command a rule binds",
    expected: MISMATCH,
    options: RULE_SCENARIO,
    forge: ({ report }) => withObservation(report, 3, { ruleKey: null }),
  },
  {
    name: "the rule key of a rule that does not bind the command",
    expected: MISMATCH,
    options: RULE_SCENARIO,
    forge: ({ report }) =>
      withObservation(report, 3, { ruleKey: "code.magicStrings" }),
  },
  {
    name: "a pass for a command two rules bind",
    expected: MISMATCH,
    options: AMBIGUOUS_SCENARIO,
    forge: ({ report }) => report,
  },
  {
    name: "an ambiguous binding resolved by naming one of the two rules",
    expected: MISMATCH,
    options: AMBIGUOUS_SCENARIO,
    forge: ({ report }) =>
      withObservation(report, 1, {
        ruleKey: "code.magicNumbers",
        result: "unavailable",
        reason: "rule_binding_ambiguous",
        exitCode: null,
        durationMs: 0,
      }),
  },
  {
    name: "an ambiguous binding claimed for a command with no binding",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "rule_binding_ambiguous",
        exitCode: null,
        durationMs: 0,
      }),
  },
  {
    name: "an unsupported checker claimed for a command no rule binds",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "unsupported_checker",
        exitCode: null,
        durationMs: 0,
      }),
  },
  {
    name:
      "an unreachable revision claimed for one command while the others ran",
    expected: MISMATCH,
    forge: ({ report }) =>
      withObservation(report, 0, {
        result: "unavailable",
        reason: "revision_unavailable",
        exitCode: null,
        durationMs: 0,
      }),
  },
  {
    name:
      "an ambiguous binding reported beside commands that claim an unreachable revision",
    expected: MISMATCH,
    options: AMBIGUOUS_SCENARIO,
    outcomes: { unit: "revision_unavailable", "magic.shared": "ambiguous" },
    forge: ({ report }) => report,
  },
  {
    name: "an unreachable revision for the ambiguous command only",
    expected: MISMATCH,
    options: AMBIGUOUS_SCENARIO,
    outcomes: { "magic.shared": "revision_unavailable" },
    forge: ({ report }) => report,
  },
  {
    name: "a skipped command for a command two rules bind",
    expected: MISMATCH,
    options: AMBIGUOUS_SCENARIO,
    outcomes: { "magic.shared": "skipped" },
    forge: ({ report }) => report,
  },
];

/** Evidence faults visible in the report alone; the rest need the artifact table. */
export const EVIDENCE_FORGERIES: Forgery[] = [
  {
    name: "an observation with no evidence reference",
    expected: EVIDENCE,
    forge: ({ report }) => withObservation(report, 0, { evidence: null }),
  },
  {
    name: "an observation with no output digest",
    expected: EVIDENCE,
    forge: ({ report }) => withObservation(report, 0, { outputDigest: null }),
  },
  {
    name: "evidence whose digest differs from the output digest",
    expected: EVIDENCE,
    forge: ({ report }) =>
      withObservation(report, 0, { outputDigest: "e".repeat(64) }),
  },
  {
    name: "one evidence version cited by two observations",
    expected: EVIDENCE,
    forge: ({ report }) =>
      withObservation(report, 1, {
        evidence: report.observations[0]!.evidence,
        outputDigest: report.observations[0]!.outputDigest,
      }),
  },
];
