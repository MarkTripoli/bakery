/** The part of one check row that says which rules and checks it was held to. */
export type RunCheckFacts = Readonly<{
  policyDigest: string;
  checkerDigest: string | null;
  runStepId: string | null;
  createdAt: string;
}>;

export type RuleFingerprint = Readonly<{
  digest: string;
  /** The first step this fingerprint applied to, when the check came from a step. */
  stepId: string | null;
}>;

export type RunRulesFacts = Readonly<{
  /** Every distinct rules fingerprint of the run, newest first. */
  rules: readonly RuleFingerprint[];
  /** The newest checks fingerprint, or `null` when no check command applied. */
  checks: string | null;
}>;

/**
 * What a run's check rows say about the rules it was held to. Rows are fixed
 * when the run is admitted, so this does not change as the rules are edited.
 */
export function runRulesFacts(checks: readonly RunCheckFacts[]): RunRulesFacts {
  const newestFirst = [...checks].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  const rules = new Map<string, RuleFingerprint>();
  // The step a fingerprint "first applied to" is the oldest row that carries it.
  for (const check of [...newestFirst].reverse()) {
    if (!rules.has(check.policyDigest)) {
      rules.set(check.policyDigest, {
        digest: check.policyDigest,
        stepId: check.runStepId,
      });
    }
  }
  const order = [...new Set(newestFirst.map((check) => check.policyDigest))];
  return {
    rules: order.map((digest) => rules.get(digest)!),
    checks: newestFirst.find((check) => check.checkerDigest !== null)
      ?.checkerDigest ?? null,
  };
}

export type RulesComparison = "same" | "changed" | "unknown";

/**
 * Whether the rules in force now are the run's. The newest fingerprint is
 * compared. Without a current value, or without a recorded one, nothing is
 * claimed: never "same" by default.
 */
export function compareRules(
  facts: RunRulesFacts,
  currentDigest: string | undefined,
): RulesComparison {
  if (currentDigest === undefined || facts.rules.length === 0) return "unknown";
  return facts.rules[0].digest === currentDigest ? "same" : "changed";
}
