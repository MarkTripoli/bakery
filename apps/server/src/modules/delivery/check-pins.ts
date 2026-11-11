import type { z } from "zod";
import {
  CHECK_OBSERVATION_MAX_ITEMS,
  CHECK_REVISION_PATTERN,
  effectivePolicyDigest,
} from "@bakery/contracts/check-evidence";
import { StandardError } from "@bakery/contracts/http";
import { RepositoryExecutionContextSchema } from "@bakery/contracts/repository-inspection";
import {
  type EffectiveRepositoryRuleEntry,
  type RepositoryRuleKey,
  type RepositoryRuleMode,
  verifyPinnedRepositoryRules,
} from "@bakery/contracts/repository-rules";
import { canonicalExecutionInputDigest } from "@bakery/persistence/repository-admission";
import { commandSubjectDigest, subjectKey } from "./identity.ts";

/**
 * The pins a `quality.check` job was admitted under, recomputed from the job's
 * own input. Admission froze the profile, the fixed policy, the trusted
 * checker and the effective rules into that input; this derives from it
 * everything a recorded check must agree with, so neither the finalizer nor a
 * later consumer ever takes an identity from a worker report.
 */

/** `VALIDATION_FAILED` reason when the job carries no usable fixed policy. */
export const CHECK_POLICY_MISSING_REASON = "check_policy_missing";

type ExecutionContext = z.output<typeof RepositoryExecutionContextSchema>;

/** What the pins say about one selected fixed command. */
export type CommandPin = {
  readonly checkId: string;
  /** Exact argv of the fixed policy; evidence of what the check enforced. */
  readonly argv: readonly string[];
  /** How the fixed policy enforces the command. */
  readonly mode: RepositoryRuleMode;
  /** The one enabled pinned rule that binds the command, or null. */
  readonly ruleKey: RepositoryRuleKey | null;
  /** True when more than one enabled pinned rule binds the command. */
  readonly ambiguous: boolean;
  /** Digest of the command plus its bound rule entry (see identity.ts). */
  readonly subjectDigest: string;
};

export type CheckPins = {
  /** Commit under test: the job's 40-hex revision. */
  readonly headSha: string;
  /** Inspected base commit of the pinned profile. */
  readonly baseSha: string;
  /** Digest of the pinned repository profile. */
  readonly profileDigest: string;
  /** Digest of the trusted checker configuration. */
  readonly checkerDigest: string;
  /** Digest of the effective policy: fixed policy, checker and rule entries. */
  readonly policyDigest: string;
  /** Selected command ids in input order; unique and at most 32. */
  readonly checks: readonly string[];
  /** One pin per selected command, in input order. */
  readonly commands: readonly CommandPin[];
  /** Every decision of the fixed policy, selected or not. */
  readonly decisions: ReadonlyArray<{
    readonly commandId: string;
    readonly mode: RepositoryRuleMode;
  }>;
};

function policyMissing(reason: string): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason },
  });
}

/**
 * The enabled pinned rules whose `checkBinding` names `commandId`. Only the two
 * magic-value rules carry a binding. The worker applies the same filter before
 * it passes a rule to the command, so both sides agree on which rule, if any,
 * a command enforces.
 */
export function boundRuleEntries(
  entries: readonly EffectiveRepositoryRuleEntry[],
  commandId: string,
): EffectiveRepositoryRuleEntry[] {
  return entries.filter((entry) =>
    entry.enabled && "checkBinding" in entry.options &&
    entry.options.checkBinding === commandId
  );
}

/**
 * What a job's pinned repository profile says, independent of what the job
 * does with it: the candidate head, the inspected base, the three digests and
 * the fixed policy. `quality.check` and `review.independent` jobs both carry
 * the profile admission pinned, so both derive their pins from this one
 * function and cannot disagree about it.
 */
export type ProfilePins = {
  /** The job input as a record, for the caller's own fields. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Commit under test or review: the job's 40-hex revision. */
  readonly headSha: string;
  /** Inspected base commit of the pinned profile. */
  readonly baseSha: string;
  /** Digest of the pinned repository profile. */
  readonly profileDigest: string;
  /** Digest of the trusted checker configuration. */
  readonly checkerDigest: string;
  /** Digest of the effective policy: fixed policy, checker and rule entries. */
  readonly policyDigest: string;
  /** Every fixed policy command, selected or not, in policy order. */
  readonly policyCommands: ReadonlyArray<{
    readonly id: string;
    readonly argv: readonly string[];
  }>;
  /** Every decision of the fixed policy, selected or not. */
  readonly decisions: CheckPins["decisions"];
  /** The pinned effective rule entries; empty when the run pinned none. */
  readonly entries: readonly EffectiveRepositoryRuleEntry[];
};

/**
 * Derives the profile-derived pins from a job's stored input. Throws
 * `VALIDATION_FAILED` with `reason` when the input holds no profile with a
 * fixed policy, when its pins disagree with their own digests, or when its
 * revision is not a full lowercase commit id. `reason` names the caller's own
 * missing-policy code, so a refused review and a refused check stay apart.
 */
export async function deriveProfilePins(
  jobInput: unknown,
  reason: string,
): Promise<ProfilePins> {
  if (
    jobInput === null || typeof jobInput !== "object" ||
    Array.isArray(jobInput)
  ) policyMissing(reason);
  const input = jobInput as Record<string, unknown>;
  const parsed = RepositoryExecutionContextSchema.safeParse(
    input.repositoryProfile,
  );
  if (!parsed.success) policyMissing(reason);
  const profile: ExecutionContext = parsed.data;
  const config = profile.config;
  const policy = config.schemaVersion === 2 ? config.fixedPolicy : undefined;
  if (
    config.schemaVersion !== 2 || policy === undefined ||
    profile.baseSha === null || profile.fixedPolicyDigest === undefined ||
    profile.trustedCheckerConfigDigest === undefined
  ) policyMissing(reason);
  if (
    await canonicalExecutionInputDigest(config) !== profile.digest ||
    await canonicalExecutionInputDigest(policy) !== profile.fixedPolicyDigest ||
    await canonicalExecutionInputDigest(config.checkPolicy) !==
      policy.trustedChecker.configDigest ||
    policy.trustedChecker.configDigest !== profile.trustedCheckerConfigDigest ||
    (profile.repositoryRules !== undefined &&
      !await verifyPinnedRepositoryRules(profile.repositoryRules))
  ) policyMissing(reason);

  const revision = input.revision;
  if (typeof revision !== "string" || !CHECK_REVISION_PATTERN.test(revision)) {
    policyMissing(reason);
  }
  const entries = profile.repositoryRules?.entries ?? [];
  return {
    input,
    headSha: revision,
    baseSha: profile.baseSha,
    profileDigest: profile.digest,
    checkerDigest: profile.trustedCheckerConfigDigest,
    policyDigest: await effectivePolicyDigest({
      fixedPolicyDigest: profile.fixedPolicyDigest,
      trustedCheckerConfigDigest: profile.trustedCheckerConfigDigest,
      entries,
    }),
    policyCommands: policy.commands,
    decisions: policy.decisions.map((decision) => ({
      commandId: decision.commandId,
      mode: decision.mode,
    })),
    entries,
  };
}

/**
 * The pin of one fixed policy command: its argv, how the policy enforces it,
 * the one enabled rule that binds it and the digest of both. The same function
 * pins a command for a check and for a review, so a subject digest recorded by
 * one is the digest the other compares against.
 */
export async function pinCommand(
  command: { readonly id: string; readonly argv: readonly string[] },
  mode: RepositoryRuleMode,
  entries: readonly EffectiveRepositoryRuleEntry[],
): Promise<CommandPin> {
  const bound = boundRuleEntries(entries, command.id);
  const unique = bound.length === 1 ? bound[0]! : null;
  return {
    checkId: command.id,
    argv: command.argv,
    mode,
    ruleKey: unique?.ruleKey ?? null,
    ambiguous: bound.length > 1,
    subjectDigest: await commandSubjectDigest(
      { id: command.id, argv: command.argv },
      unique,
    ),
  };
}

/**
 * Derives the pins of one `quality.check` job from its stored input. Throws
 * `VALIDATION_FAILED` with reason `check_policy_missing` when the input holds
 * no profile with a fixed policy, when its pins disagree with their own
 * digests, or when its revision or selection is not what admission allows.
 */
export async function deriveCheckPins(jobInput: unknown): Promise<CheckPins> {
  const profile = await deriveProfilePins(
    jobInput,
    CHECK_POLICY_MISSING_REASON,
  );
  const checks = profile.input.checks;
  if (
    !Array.isArray(checks) || checks.length === 0 ||
    checks.length > CHECK_OBSERVATION_MAX_ITEMS ||
    checks.some((check) => typeof check !== "string") ||
    new Set(checks).size !== checks.length
  ) policyMissing(CHECK_POLICY_MISSING_REASON);
  const selected = checks as string[];
  const commandById = new Map(
    profile.policyCommands.map((command) => [command.id, command]),
  );
  const modeById = new Map(
    profile.decisions.map((decision) => [decision.commandId, decision.mode]),
  );
  const commands: CommandPin[] = [];
  for (const checkId of selected) {
    const command = commandById.get(checkId);
    const mode = modeById.get(checkId);
    if (command === undefined || mode === undefined) {
      policyMissing(CHECK_POLICY_MISSING_REASON);
    }
    commands.push(await pinCommand(command, mode, profile.entries));
  }
  return {
    headSha: profile.headSha,
    baseSha: profile.baseSha,
    profileDigest: profile.profileDigest,
    checkerDigest: profile.checkerDigest,
    policyDigest: profile.policyDigest,
    checks: selected,
    commands,
    decisions: profile.decisions,
  };
}

/**
 * The subject digest of each pinned command, keyed the way
 * `CandidateIdentity.subjects` expects. A consumer building the current
 * identity of a candidate uses this with the pins of the run it evaluates,
 * whether those are check pins (the selected commands) or review pins (every
 * fixed policy command).
 */
export function commandSubjects(
  pins: { readonly commands: readonly CommandPin[] },
): Record<string, string> {
  return Object.fromEntries(
    pins.commands.map((
      command,
    ) => [subjectKey("command", command.checkId), command.subjectDigest]),
  );
}
