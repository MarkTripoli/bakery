import { deriveCheckVerdict } from "../../../packages/contracts/src/check-evidence.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import {
  OrganizationRepositoryRulesSchema,
  pinRepositoryRules,
  resolveRepositoryRules,
} from "../../../packages/contracts/src/repository-rules.ts";
import type { CheckPins } from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { BASE_SHA, type ObservationFixture } from "./observations.ts";

/**
 * Pure builders for `quality.check` finalizer cases: a fixed-policy execution
 * context computed by hand, and the observations and report an honest worker
 * would send for it. No database and no worker fixture, so the unit lane can
 * use them too.
 */

export type ExecutionContext = ReturnType<
  typeof RepositoryExecutionContextSchema.parse
>;
type RuleEntries = Array<Record<string, unknown>>;

export type CheckCommand = {
  id: string;
  argv: string[];
  mode: "guide" | "warn" | "require";
};

/** `unit` blocks, `lint` only warns and `format` only guides. */
export const DEFAULT_COMMANDS: readonly CheckCommand[] = Object.freeze([
  { id: "unit", argv: ["pnpm", "test:unit"], mode: "require" },
  { id: "lint", argv: ["pnpm", "lint"], mode: "warn" },
  { id: "format", argv: ["pnpm", "fmt"], mode: "guide" },
]);

export type PolicyOptions = {
  commands?: readonly CheckCommand[];
  /** Organization rule entries the run pinned (effective entries are resolved). */
  rules?: RuleEntries;
  rulesRevision?: number;
  baseSha?: string;
};

export type EvidenceRef = {
  artifactId: string;
  versionId: string;
  sha256: string;
};

/** What a command did, as the worker would observe it. */
export type Outcome =
  | "pass"
  | "fail"
  | "signal"
  | "deadline"
  | "output_limit"
  | "tool_missing"
  | "revision_unavailable"
  | "unsupported_checker"
  | "skipped"
  | "ambiguous";

export type CheckRunRow = {
  id: string;
  organization_id: string;
  run_id: string;
  run_step_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  fence: string | null;
  check_id: string;
  kind: string;
  rule_key: string | null;
  result: string;
  reason: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_digest: string | null;
  evidence_version_id: string | null;
  head_sha: string;
  base_sha: string | null;
  profile_digest: string | null;
  policy_digest: string;
  subject_digest: string;
  checker_digest: string | null;
  title_digest: string | null;
  body_digest: string | null;
  merge_message_digest: string | null;
  commit_selection_digest: string | null;
};

export type CheckReportFixture = ReturnType<typeof reportFrom>;

const CHECK_POLICY = {
  schemaVersion: 1 as const,
  platform: "linux" as const,
  tools: [{ tool: "git" as const, required: true }],
  checks: [{
    id: "source.integrity",
    template: "source.integrity.v1" as const,
    tool: null,
    paths: [],
    required: true,
  }],
};

async function digestOf(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

/**
 * A fixed-policy execution context computed by hand with the platform digest,
 * not by the code under test, so the finalizer's recomputation is checked
 * against an independent derivation.
 */
export async function fixedPolicyContext(
  identity: {
    organizationId: string;
    applicationId: string;
    repositoryId: string;
    id: string;
    revision: number;
  },
  options: PolicyOptions = {},
): Promise<ExecutionContext> {
  const commands = options.commands ?? DEFAULT_COMMANDS;
  const fixedPolicy = {
    schemaVersion: 1 as const,
    commands: commands.map(({ id, argv }) => ({ id, argv })),
    allowedEffects: ["evidence_only" as const],
    lockedConfiguration: {
      branches: true as const,
      worktree: true as const,
      checker: true as const,
    },
    decisions: commands.map(({ id, mode }) => ({ commandId: id, mode })),
    trustedChecker: {
      kind: "repository-inspection" as const,
      configDigest: await digestOf(CHECK_POLICY),
    },
  };
  const config = {
    schemaVersion: 2 as const,
    workflow: { kind: "fixed" as const },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    checkPolicy: CHECK_POLICY,
    fixedPolicy,
  };
  const rules = options.rules === undefined ? undefined : pinRepositoryRules(
    await resolveRepositoryRules(
      OrganizationRepositoryRulesSchema.parse({
        revision: options.rulesRevision ?? 1,
        entries: options.rules,
      }),
      { entries: [] },
    ),
    { id: identity.id, revision: identity.revision },
  );
  return RepositoryExecutionContextSchema.parse({
    ...identity,
    digest: await digestOf(config),
    config,
    observationId: crypto.randomUUID(),
    observationDigest: "a".repeat(64),
    baseSha: options.baseSha ?? BASE_SHA,
    fixedPolicyDigest: await digestOf(fixedPolicy),
    trustedCheckerConfigDigest: fixedPolicy.trustedChecker.configDigest,
    ...(rules === undefined ? {} : { repositoryRules: rules }),
  });
}

/** One observation for a command in the given outcome, bound to its pin. */
export function observationFor(
  pin: { checkId: string; ruleKey: string | null },
  outcome: Outcome,
  evidence: EvidenceRef,
): ObservationFixture {
  const base = {
    checkRunId: crypto.randomUUID(),
    checkId: pin.checkId,
    kind: "command",
    ruleKey: pin.ruleKey,
    outputDigest: evidence.sha256,
    evidence,
  };
  switch (outcome) {
    case "pass":
      return {
        ...base,
        result: "passed",
        reason: "verified",
        exitCode: 0,
        durationMs: 40,
      };
    case "fail":
      return {
        ...base,
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 1,
        durationMs: 25,
      };
    case "signal":
      return {
        ...base,
        result: "failed",
        reason: "signal",
        exitCode: null,
        durationMs: 30,
      };
    case "deadline":
      return {
        ...base,
        result: "failed",
        reason: "deadline",
        exitCode: null,
        durationMs: 600,
      };
    case "output_limit":
      return {
        ...base,
        result: "failed",
        reason: "output_limit",
        exitCode: null,
        durationMs: 20,
      };
    case "tool_missing":
      return {
        ...base,
        result: "unavailable",
        reason: "tool_missing",
        exitCode: null,
        durationMs: 0,
      };
    case "revision_unavailable":
      return {
        ...base,
        result: "unavailable",
        reason: "revision_unavailable",
        exitCode: null,
        durationMs: 0,
      };
    case "unsupported_checker":
      return {
        ...base,
        result: "unavailable",
        reason: "unsupported_checker",
        exitCode: null,
        durationMs: 0,
      };
    case "skipped":
      return {
        ...base,
        result: "unavailable",
        reason: "skipped",
        exitCode: null,
        durationMs: 0,
      };
    case "ambiguous":
      return {
        ...base,
        result: "unavailable",
        reason: "rule_binding_ambiguous",
        exitCode: null,
        durationMs: 0,
      };
  }
}

/** A complete report around observations, with the verdict an honest worker echoes. */
export function reportFrom(
  pins: CheckPins,
  observations: readonly ObservationFixture[],
) {
  const verdict = deriveCheckVerdict(observations, pins.decisions);
  return {
    allRequired: verdict.allRequired,
    checkRunIds: observations.map(({ checkRunId }) => checkRunId),
    failedCheckIds: [...verdict.failedCheckIds],
    observations: [...observations],
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    policyDigest: pins.policyDigest,
  };
}

/** The fields of an expected rejection. */
export type Rejection = { code: string; reason: string };
