import type {
  EffectiveRepositoryRuleEntry,
  RepositoryRuleMode,
} from "./repository-rules.ts";
import { canonicalJson, sha256Hex } from "./workflow-compiler/canonical.ts";

/**
 * Vocabulary and pure rules for deterministic check evidence.
 * Both the worker that observes a command and the server that verifies the
 * report import this module, so the two sides cannot drift apart.
 */

/** Most observations one `quality.check` result may carry. */
export const CHECK_OBSERVATION_MAX_ITEMS = 32;

/**
 * The only revision a `quality.check` of a fixed policy accepts: a full,
 * lowercase 40-character commit id. A ref would let the worker choose what it
 * tested, so admission on both sides refuses anything else.
 */
export const CHECK_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** Outcome of one check. Only `passed` can satisfy a required check. */
export const CHECK_RESULTS = Object.freeze(
  ["pending", "passed", "failed", "unavailable", "canceled"] as const,
);
export type CheckResult = typeof CHECK_RESULTS[number];

export function isCheckResult(value: unknown): value is CheckResult {
  return typeof value === "string" &&
    (CHECK_RESULTS as readonly string[]).includes(value);
}

/** What a check row observed. */
export const CHECK_KINDS = Object.freeze(
  ["command", "commits", "title", "description", "merge_message"] as const,
);
export type CheckKind = typeof CHECK_KINDS[number];

export function isCheckKind(value: unknown): value is CheckKind {
  return typeof value === "string" &&
    (CHECK_KINDS as readonly string[]).includes(value);
}

/**
 * Machine-readable reason for a result. `skipped` is a reason under
 * `unavailable`: a skipped required check blocks like a missing one.
 */
export const CHECK_REASONS = Object.freeze(
  [
    "verified",
    "exit_nonzero",
    "signal",
    "deadline",
    "output_limit",
    "rule_violation",
    "description_placeholder",
    "tool_missing",
    "unsupported_checker",
    "revision_unavailable",
    "skipped",
    "metadata_missing",
    "metadata_too_large",
    "rule_unbound",
    "rule_binding_ambiguous",
    "policy_missing",
    "awaiting_result",
    "canceled",
  ] as const,
);
export type CheckReason = typeof CHECK_REASONS[number];

export function isCheckReason(value: unknown): value is CheckReason {
  return typeof value === "string" &&
    (CHECK_REASONS as readonly string[]).includes(value);
}

/**
 * The one result each reason may accompany. A process that ran and did not
 * pass is `failed`; a check with no trustworthy observation is `unavailable`.
 */
export const CHECK_REASON_RESULTS: Readonly<Record<CheckReason, CheckResult>> =
  Object.freeze({
    verified: "passed",
    exit_nonzero: "failed",
    signal: "failed",
    deadline: "failed",
    output_limit: "failed",
    rule_violation: "failed",
    description_placeholder: "failed",
    tool_missing: "unavailable",
    unsupported_checker: "unavailable",
    revision_unavailable: "unavailable",
    skipped: "unavailable",
    metadata_missing: "unavailable",
    metadata_too_large: "unavailable",
    rule_unbound: "unavailable",
    rule_binding_ambiguous: "unavailable",
    policy_missing: "unavailable",
    awaiting_result: "pending",
    canceled: "canceled",
  });

/** True when `reason` is a legal explanation for `result`. */
export function isCoherentCheckOutcome(
  result: CheckResult,
  reason: CheckReason,
): boolean {
  return CHECK_REASON_RESULTS[reason] === result;
}

/** What the verdict needs to know about one observation. */
export type CheckVerdictObservation = {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly result: CheckResult;
};

/** One fixed policy decision: how a command's result is enforced. */
export type CheckVerdictDecision = {
  readonly commandId: string;
  readonly mode: RepositoryRuleMode;
};

export type CheckVerdict = {
  /** True only when every `require` command has a `passed` observation. */
  readonly allRequired: boolean;
  /** Row ids of required observations that did not pass, in input order. */
  readonly failedCheckIds: readonly string[];
};

/**
 * Derives the verdict from observed results and the fixed policy decisions.
 * A `require` command counts only as `passed`: `failed`, `unavailable`,
 * `pending` and `canceled` all block, and a required command with no
 * observation blocks too. `warn` and `guide` never block and never appear in
 * `failedCheckIds`. A check with no decision fails closed as required.
 * Command output text is not an input, so it cannot change the verdict.
 */
export function deriveCheckVerdict(
  observations: readonly CheckVerdictObservation[],
  decisions: readonly CheckVerdictDecision[],
): CheckVerdict {
  const modes = new Map<string, RepositoryRuleMode>();
  for (const decision of decisions) {
    modes.set(decision.commandId, decision.mode);
  }
  const observed = new Set<string>();
  const failedCheckIds: string[] = [];
  let allRequired = true;
  for (const observation of observations) {
    observed.add(observation.checkId);
    const mode = modes.get(observation.checkId) ?? "require";
    if (mode !== "require" || observation.result === "passed") continue;
    allRequired = false;
    failedCheckIds.push(observation.checkRunId);
  }
  for (const decision of decisions) {
    if (decision.mode === "require" && !observed.has(decision.commandId)) {
      allRequired = false;
    }
  }
  return { allRequired, failedCheckIds };
}

/** An effective rule entry without the fields that only record its origin. */
export type RuleEntryIdentity = EffectiveRepositoryRuleEntry extends infer E
  ? E extends EffectiveRepositoryRuleEntry
    ? Omit<E, "provenance" | "organizationRevision">
  : never
  : never;

/**
 * The part of an effective rule entry that decides what a check enforces.
 * `provenance` and `organizationRevision` say where the entry came from, not
 * what it requires, so an organization revision bump over equal entries leaves
 * every identity unchanged (docs/technical-design/22-repository-rules.md).
 */
export function ruleEntryIdentity(
  entry: EffectiveRepositoryRuleEntry,
): RuleEntryIdentity {
  const { provenance: _provenance, organizationRevision: _revision, ...rest } =
    entry;
  return rest;
}

/** Digest of one effective rule entry, independent of its provenance. */
export function ruleEntryDigest(
  entry: EffectiveRepositoryRuleEntry,
): Promise<string> {
  return sha256Hex(canonicalJson(ruleEntryIdentity(entry)));
}

/** The pins that together define the policy a check ran under. */
export type EffectivePolicyBinding = {
  /** Canonical digest of the fixed policy, pinned at run admission. */
  readonly fixedPolicyDigest: string;
  /** Digest of the trusted checker configuration, pinned at admission. */
  readonly trustedCheckerConfigDigest: string;
  /** Effective rule entries pinned at admission, in rule-key order. */
  readonly entries: readonly EffectiveRepositoryRuleEntry[];
};

/**
 * Digest of the effective policy: the fixed policy, the trusted checker and
 * the effective rule entries. The organization revision is excluded, so an
 * organization change that leaves the entries equal stays provenance-only.
 */
export async function effectivePolicyDigest(
  binding: EffectivePolicyBinding,
): Promise<string> {
  const entriesDigest = await sha256Hex(
    canonicalJson(binding.entries.map(ruleEntryIdentity)),
  );
  return await sha256Hex(canonicalJson({
    fixedPolicyDigest: binding.fixedPolicyDigest,
    trustedCheckerConfigDigest: binding.trustedCheckerConfigDigest,
    entriesDigest,
  }));
}
