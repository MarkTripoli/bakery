import { z } from "zod";

/**
 * Context budget envelope and allocation (docs/technical-design/17-context-and-handoffs.md,
 * "Context is a measured budget envelope"; specimen in 19-platform-examples.md).
 *
 * Pure admission policy: it never loads content or tokenizes text. Every count
 * is measured, estimated from bounded metadata, or unknown. Unknown is never
 * counted as zero: an unknown count that is not bounded blocks admission.
 */

const tokens = z.number().int().nonnegative().finite().describe(
  "Non-negative whole token count.",
);

export const ContextCountSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("measured").describe(
      "The count was measured from the assembled content.",
    ),
    tokens: tokens.describe("Measured token count."),
  }).strict().describe("A measured token count."),
  z.object({
    state: z.literal("estimated").describe(
      "The count was estimated from bounded metadata such as byte length.",
    ),
    tokens: tokens.describe("Conservative estimated token count."),
  }).strict().describe("An estimated token count."),
  z.object({
    state: z.literal("unknown").describe(
      "Bakery cannot yet know this count; it is never treated as zero.",
    ),
    tokens: z.null().describe("No token count is known."),
    boundTokens: tokens.nullable().describe(
      "Hard upper bound the content cannot exceed (for example a capped extraction window), or null when the content is unbounded.",
    ),
  }).strict().describe("A count Bakery cannot measure or estimate yet."),
]).describe("Token count of one context component with its provenance.");
export type ContextCount = z.infer<typeof ContextCountSchema>;

export const ContextReservationSchema = z.object({
  output: tokens.describe("Tokens reserved for the next model response."),
  toolResults: tokens.describe(
    "Tokens reserved for bounded tool results returned during this step.",
  ),
  compaction: tokens.describe(
    "Tokens reserved so the harness can compact safely before the limit.",
  ),
  safetyMargin: tokens.describe(
    "Configured margin for tokenizer and harness differences.",
  ),
}).strict().describe(
  "Headroom reserved before any context is admitted; it survives retries.",
);
export type ContextReservation = z.infer<typeof ContextReservationSchema>;

export const ContextEnvelopeInputSchema = z.object({
  modelContextTokens: z.number().int().positive().finite().describe(
    "Context window the resolved model and harness report.",
  ),
  counts: z.record(
    z.string().min(1).max(64).describe("Context component name."),
    ContextCountSchema,
  ).describe(
    "Counts of the components already in the request (conversation, instructions, tool schemas, harness overhead).",
  ),
  reserved: ContextReservationSchema,
}).strict().describe(
  "Inputs of a budget envelope: the model limit, current counts and reserved headroom.",
);
export type ContextEnvelopeInput = z.infer<typeof ContextEnvelopeInputSchema>;

export const ContextDecision = Object.freeze(
  {
    /** Everything fits with all reservations intact. */
    Ready: "ready",
    /** An unknown, unbounded count: a narrower slice or a bound is needed first. */
    BoundMoreBeforeDispatch: "bound-more-before-dispatch",
    /** Known content does not fit; narrow, summarize or pause. */
    NeedsBounding: "needs_bounding",
    /** Required content alone exceeds the budget: checkpoint and hand off. */
    HandoffRequired: "handoff_required",
  } as const,
);
export type ContextDecision =
  (typeof ContextDecision)[keyof typeof ContextDecision];

export type ContextEnvelope = {
  modelContextTokens: number;
  /** Input tokens counted: measured + estimated + bounds of bounded unknowns. */
  countedInputTokens: number;
  reservedTokens: number;
  /** Tokens left for new context; negative when already over budget. */
  availableTokens: number;
  /** Components whose count is unknown and unbounded. */
  unboundedUnknown: string[];
  decision: ContextDecision;
};

function counted(count: ContextCount): number | null {
  if (count.state !== "unknown") return count.tokens;
  return count.boundTokens;
}

function reservedTotal(reserved: ContextReservation): number {
  return reserved.output + reserved.toolResults + reserved.compaction +
    reserved.safetyMargin;
}

/**
 * `available = modelLimit - measuredOrEstimatedInput - reservedOutput -
 * reservedToolResults - reservedCompaction - safetyMargin`. A bounded unknown
 * is counted at its bound; an unbounded unknown blocks with
 * `bound-more-before-dispatch` whatever else fits.
 */
export function resolveContextEnvelope(
  input: ContextEnvelopeInput,
): ContextEnvelope {
  const parsed = ContextEnvelopeInputSchema.parse(input);
  let countedInputTokens = 0;
  const unboundedUnknown: string[] = [];
  for (const [name, count] of Object.entries(parsed.counts).sort()) {
    const value = counted(count);
    if (value === null) unboundedUnknown.push(name);
    else countedInputTokens += value;
  }
  const reservedTokens = reservedTotal(parsed.reserved);
  const availableTokens = parsed.modelContextTokens - countedInputTokens -
    reservedTokens;
  return {
    modelContextTokens: parsed.modelContextTokens,
    countedInputTokens,
    reservedTokens,
    availableTokens,
    unboundedUnknown,
    decision: unboundedUnknown.length > 0
      ? ContextDecision.BoundMoreBeforeDispatch
      : availableTokens < 0
      ? ContextDecision.NeedsBounding
      : ContextDecision.Ready,
  };
}

export const ContextItemSchema = z.object({
  id: z.string().min(1).max(200).describe(
    "Stable identifier of the candidate context item.",
  ),
  count: ContextCountSchema,
  required: z.boolean().describe(
    "Whether the step cannot run without this item.",
  ),
  priority: z.number().int().min(0).max(1000).describe(
    "Selection priority among optional items; higher is selected first.",
  ),
}).strict().describe("One candidate item for a context pack.");
export type ContextItem = z.infer<typeof ContextItemSchema>;

export type ContextAllocation = {
  envelope: ContextEnvelope;
  decision: ContextDecision;
  selected: string[];
  /** Optional items left out, with why. */
  omitted: { id: string; reason: "unbounded_unknown" | "over_budget" }[];
  selectedTokens: number;
};

/**
 * Selects context items into the envelope's available tokens. Required items
 * are always counted; if they do not fit the result is `handoff_required` and
 * nothing is selected. A required item with an unbounded unknown count blocks
 * the step (`bound-more-before-dispatch`). Optional items go in by priority,
 * then id; an optional unbounded unknown is omitted, never counted as zero.
 */
export function allocateContext(input: {
  envelope: ContextEnvelopeInput;
  items: readonly ContextItem[];
}): ContextAllocation {
  const envelope = resolveContextEnvelope(input.envelope);
  const items = input.items.map((item) => ContextItemSchema.parse(item));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new z.ZodError([{
        code: "custom",
        path: ["items"],
        message: `Duplicate context item id ${item.id}.`,
        input: item.id,
      }]);
    }
    ids.add(item.id);
  }
  const empty = (decision: ContextDecision): ContextAllocation => ({
    envelope,
    decision,
    selected: [],
    omitted: [],
    selectedTokens: 0,
  });
  if (envelope.decision !== ContextDecision.Ready) {
    return empty(envelope.decision);
  }
  const required = items.filter((item) => item.required);
  if (required.some((item) => counted(item.count) === null)) {
    return empty(ContextDecision.BoundMoreBeforeDispatch);
  }
  let selectedTokens = required.reduce(
    (total, item) => total + counted(item.count)!,
    0,
  );
  if (selectedTokens > envelope.availableTokens) {
    return empty(ContextDecision.HandoffRequired);
  }
  const selected = required.map((item) => item.id);
  const omitted: ContextAllocation["omitted"] = [];
  const optional = items.filter((item) => !item.required).sort((a, b) =>
    b.priority - a.priority || a.id.localeCompare(b.id)
  );
  for (const item of optional) {
    const value = counted(item.count);
    if (value === null) {
      omitted.push({ id: item.id, reason: "unbounded_unknown" });
    } else if (selectedTokens + value > envelope.availableTokens) {
      omitted.push({ id: item.id, reason: "over_budget" });
    } else {
      selectedTokens += value;
      selected.push(item.id);
    }
  }
  return {
    envelope,
    decision: ContextDecision.Ready,
    selected,
    omitted,
    selectedTokens,
  };
}
