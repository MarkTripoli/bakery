import {
  type ContextEnvelope,
  type ContextItem,
  type ContextPack,
  type ContextUsage,
  headroomTotal,
  usageTokens,
} from "@bakery/contracts/context-packs";

/**
 * Admission: deciding what a step is actually handed.
 *
 * The single rule this file exists to enforce is that **unknown size is never
 * admitted as free**. A budget check that treats an unmeasured input as 0 does
 * not fail; it admits a step that then overflows exactly when the input is
 * large, which is the case nobody tested. So an unknown item is admitted only
 * when it fits inside an explicitly reserved allowance, and otherwise it is
 * omitted with a reason.
 */

/** A candidate item with what is known about its cost. */
export type Candidate = Readonly<{
  item: ContextItem;
  usage: ContextUsage;
  /** Stable identity used in omission records, so a refusal names what it refused. */
  label: string;
}>;

export type AdmissionOptions = Readonly<{
  envelope: ContextEnvelope;
  /**
   * Budget an unknown-size item may draw on.
   *
   * Zero by default, which means unknown items are refused. A caller that knows
   * an item is small but unmeasurable opts in explicitly, and that opt-in is a
   * number rather than a flag: "admit unknowns" with no ceiling is the same
   * defect as admitting them as zero, one indirection later.
   */
  unknownAllowanceTokens?: number;
  /** Hard cap on item count, independent of the budget. */
  maxItems?: number;
}>;

export type AdmissionResult = Readonly<{
  pack: ContextPack;
  /** Tokens the admitted items account for, excluding the allowance reserved. */
  consumedTokens: number;
  /** Allowance spent on unknown items, so a caller can see how much was guessed. */
  unknownSpentTokens: number;
}>;

const DEFAULT_MAX_ITEMS = 200;

/**
 * Admits candidates in order until the usable budget is spent.
 *
 * Order is the caller's relevance order and is never reordered here: a pack that
 * silently sorts by size hands a step its cheapest evidence rather than its most
 * relevant.
 */
export function admitContext(
  options: AdmissionOptions,
  candidates: readonly Candidate[],
): AdmissionResult {
  const { envelope } = options;
  const unknownAllowance = options.unknownAllowanceTokens ?? 0;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  // Reserved BEFORE anything is admitted. Computing this after the loop would
  // let an earlier item consume budget the step needs to answer with.
  const budget = envelope.windowTokens - headroomTotal(envelope.headroom);

  const items: ContextItem[] = [];
  const usage: ContextUsage[] = [];
  const omitted: {
    reason: "over-budget" | "unknown-size" | "unauthorized";
    detail: string;
  }[] = [];
  let consumed = 0;
  let unknownSpent = 0;

  for (const candidate of candidates) {
    if (items.length >= maxItems) {
      omitted.push({
        reason: "over-budget",
        detail:
          `${candidate.label}: the pack already holds its maximum of ${maxItems} items.`,
      });
      continue;
    }
    const tokens = usageTokens(candidate.usage);
    if (tokens === null) {
      // Unknown size: it may draw only on the explicit allowance, never on the
      // remaining budget, because there is no number to subtract and treating it
      // as 0 is exactly the defect this branch prevents.
      if (unknownSpent + 1 > unknownAllowance) {
        omitted.push({
          reason: "unknown-size",
          detail:
            `${candidate.label}: its size is unknown and the pack's unknown allowance is exhausted, so it was refused rather than counted as zero.`,
        });
        continue;
      }
      unknownSpent += 1;
      items.push(candidate.item);
      usage.push(candidate.usage);
      continue;
    }
    if (consumed + tokens > budget) {
      omitted.push({
        reason: "over-budget",
        detail: `${candidate.label}: needs ${tokens} tokens but only ${
          budget - consumed
        } of the ${budget}-token budget remain.`,
      });
      continue;
    }
    consumed += tokens;
    items.push(candidate.item);
    usage.push(candidate.usage);
  }

  return {
    pack: { envelope, items, usage, omitted },
    consumedTokens: consumed,
    unknownSpentTokens: unknownSpent,
  };
}

/**
 * Whether an item may be carried forward from a cached extract.
 *
 * A cached extract is safe to reuse only while **both** halves of the citation
 * still hold: the artifact version and digest still describe what the reader
 * would fetch, and the reader still holds the scope it was produced under. A
 * cache keyed on artifact id alone survives a new version; one keyed without
 * scope survives a revoked grant.
 */
export function extractStillValid(
  cited: Readonly<{ artifactVersionId: string; digest: string; scope: string }>,
  current: Readonly<{
    artifactVersionId: string;
    digest: string;
    scope: string | null;
  }>,
): boolean {
  return cited.artifactVersionId === current.artifactVersionId &&
    cited.digest === current.digest &&
    // A null scope means the reader no longer holds one, which is a revocation
    // rather than a match.
    current.scope !== null &&
    cited.scope === current.scope;
}
