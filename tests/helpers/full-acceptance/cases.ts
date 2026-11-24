/**
 * The phases the #50 full acceptance scenario must prove, in the order it runs
 * them (tests/e2e/prove-full-headless-factory-delivery-and-recovery-from-a-fresh-checkout_test.ts).
 * The child logs one FULL_ACCEPTANCE_CASE line per phase it passed; both the
 * child and its launcher refuse a run whose lines are not exactly this list,
 * so a skipped, reordered or silently dropped phase fails the e2e lane, and
 * with it pnpm verify:backend.
 */
export const FULL_ACCEPTANCE_REQUIRED_CASES = Object.freeze(
  [
    "rest-and-mcp-intake-of-the-same-work",
    "duplicate-intake-one-admission",
    "server-restart-mid-run",
    "worker-artifact-and-comment",
    "budget-recorded",
    "metrics-read",
    "worker-restart-mid-run",
    "engine-restart-mid-run",
    "completion-before-wait",
    "cancellation-races-completion",
    "question-answer-turn",
    "signed-github-event-starts-automation",
    "automation-run-completes",
    "checks-and-review-read-back",
    "unknown-effect-held-not-repeated",
  ] as const,
);
export type FullAcceptanceCase =
  (typeof FULL_ACCEPTANCE_REQUIRED_CASES)[number];

export const FULL_ACCEPTANCE_CASE_PREFIX = "FULL_ACCEPTANCE_CASE ";

/** One passed phase as the child prints it. */
export type FullAcceptanceCaseRecord = {
  readonly name: FullAcceptanceCase;
  readonly outcome: "passed";
  readonly facts: Readonly<Record<string, unknown>>;
};

export function formatFullAcceptanceCase(
  record: FullAcceptanceCaseRecord,
): string {
  return FULL_ACCEPTANCE_CASE_PREFIX + JSON.stringify(record);
}

/** The case records in a block of output, in the order they were printed. */
export function parseFullAcceptanceCases(
  output: string,
): FullAcceptanceCaseRecord[] {
  return output.split("\n")
    .filter((line) => line.startsWith(FULL_ACCEPTANCE_CASE_PREFIX))
    .map((line) =>
      JSON.parse(
        line.slice(FULL_ACCEPTANCE_CASE_PREFIX.length),
      ) as FullAcceptanceCaseRecord
    );
}

/**
 * Throws unless the records are exactly the required cases, each passed once,
 * in order. The message names what is missing, extra or out of place.
 */
export function assertFullAcceptanceCases(
  records: readonly Pick<FullAcceptanceCaseRecord, "name" | "outcome">[],
): void {
  const names = records.map((record) => record.name as string);
  const required: readonly string[] = FULL_ACCEPTANCE_REQUIRED_CASES;
  const missing = required.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !required.includes(name));
  const failed = records.filter((record) => record.outcome !== "passed")
    .map((record) => record.name);
  if (
    missing.length > 0 || extra.length > 0 || failed.length > 0 ||
    names.length !== required.length ||
    names.some((name, index) => name !== required[index])
  ) {
    throw new Error(
      "FULL_ACCEPTANCE_CASES_INCOMPLETE:" +
        JSON.stringify({ missing, extra, failed, seen: names }),
    );
  }
}
