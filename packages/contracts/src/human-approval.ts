import { z } from "zod";

/**
 * People and endings (chapter 25 §9 and slice 9 of the one-engine design):
 * the `human.approval` step, the `workflow.stop` step, named run outcomes, and
 * the decisions ledger a work item carries.
 *
 * The decisions in the design this module encodes:
 * - A `human.approval` step waits for one person's decision and never approves
 *   by silence (§19.3: "Nothing is ever approved by silence").
 * - The wait is at most seven days and the time spent waiting does not consume
 *   the run's active clock (section 9 and the time budget rules).
 * - A run ends with a named outcome rather than a bare status, so a workflow can
 *   branch on what happened.
 * - Every decision and steer is recorded, before delivery, in the work item's
 *   decisions ledger; the interpreter reads only decisions, never a message.
 */

/**
 * The three decisions a `human.approval` step accepts. These reuse the
 * vocabulary the shipped approval projection already uses, so one word means
 * the same thing to an approver and to a workflow author.
 */
export const HUMAN_APPROVAL_DECISIONS = Object.freeze(
  ["approve", "request_changes", "reject"] as const,
);
export type HumanApprovalDecision = typeof HUMAN_APPROVAL_DECISIONS[number];

/** Event a human.approval wait consumes when a person decides. */
export const HUMAN_APPROVAL_EVENT = "human.approval.decided";

/** Which of the three decisions let the step continue. */
export function humanApprovalContinues(decision: HumanApprovalDecision) {
  return decision === "approve";
}

/**
 * The longest a `human.approval` step waits. Seven days, chosen once here so the
 * timer, the expiry error and the documentation cannot disagree.
 */
export const HUMAN_APPROVAL_WAIT_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest accepted note on a decision; bounds the stored text column. */
export const DECISION_NOTE_MAX_LENGTH = 4000;

const NOTE_SCHEMA = z.string().max(DECISION_NOTE_MAX_LENGTH).describe(
  `Optional note attached to a decision, at most ${DECISION_NOTE_MAX_LENGTH} characters. It is recorded verbatim in the ledger and shown to the person who asked.`,
);

/**
 * Input of a `human.approval` step (the neutral action, not the shipped
 * plan-approval flow). `audience` names who may decide; when it is absent the
 * workflow's owner is the approver, which is the design's default.
 */
export const HumanApprovalInputSchema = z.object({
  prompt: z.string().min(1).max(2000).describe(
    "Question put to the approver, shown in the inbox and on the approval page. Plain text: the decision itself is typed, never inferred from this text.",
  ),
  audience: z.array(
    z.string().min(1).max(200).describe(
      "One member, group or role reference that may decide this step.",
    ),
  ).min(1).max(50).optional().describe(
    "Who may decide. Absent means the workflow's owner, which is the default approver; an empty list is refused because a step nobody can answer would wait until it expires.",
  ),
  approveLabel: z.string().min(1).max(100).optional().describe(
    "Optional label for the approving choice, so a workflow can say Release instead of Approve.",
  ),
  rejectLabel: z.string().min(1).max(100).optional().describe(
    "Optional label for the rejecting choice, paired with approveLabel.",
  ),
  allowRequestChanges: z.boolean().optional().describe(
    "Whether the step also offers request changes. Defaults to true, matching the three shipped approval decisions.",
  ),
}).strict().describe(
  "Input of a human.approval step: what the approver is asked, who may answer, and how the choices are labelled.",
);
export type HumanApprovalInput = z.output<typeof HumanApprovalInputSchema>;

/** Output of a `human.approval` step. */
export const HumanApprovalOutputSchema = z.object({
  decision: z.enum(HUMAN_APPROVAL_DECISIONS).describe(
    "The decision the approver made. The step completes only on approve; the other two end the run with that named outcome.",
  ),
  note: NOTE_SCHEMA.optional().describe(
    "Note the approver attached, recorded verbatim in the decisions ledger.",
  ),
  decidedBy: z.string().uuid().describe(
    "Principal who decided. Always a person: an agent may decide only where a workflow grants it, and this step is the human form.",
  ),
  decidedAt: z.string().datetime().describe(
    "UTC instant of the decision, so the run can report how long the wait lasted.",
  ),
  approvalId: z.string().uuid().describe(
    "The approval record the decision was made on, which the ledger and the inbox both reference.",
  ),
}).strict().describe(
  "Output of a human.approval step: the decision, who made it and when.",
);
export type HumanApprovalOutput = z.output<typeof HumanApprovalOutputSchema>;

/**
 * Input of `workflow.stop`: the neutral action that ends a run on purpose with
 * a named outcome, as opposed to failing. The outcome is optional: a stop that
 * names none still ends the run, and `normalizeWorkflowStop` gives it
 * `DEFAULT_STOP_OUTCOME`, because asking for an explicit name where the reason
 * already explains the ending buys nothing.
 */
export const WorkflowStopInputSchema = z.object({
  outcome: z.string().min(1).max(100).optional().describe(
    "Name of the outcome this stop produces, for example cancelled_by_customer or nothing_to_do. It becomes the run's named outcome and is what a later step or a caller branches on. Omit it to end the run with the neutral outcome stopped.",
  ),
  reason: z.string().max(2000).optional().describe(
    "Optional human explanation recorded with the outcome, for whoever reads the run later.",
  ),
}).strict().describe(
  "Input of a workflow.stop step: an optional named outcome that ends the run, and an optional reason. A stop that names no outcome still ends the run.",
);
export type WorkflowStopInput = z.output<typeof WorkflowStopInputSchema>;

/** Outcome a run ends with when a step stops it without naming one. */
export const DEFAULT_STOP_OUTCOME = "stopped";

/**
 * Input of `workflow.stop` with its default applied. A stop that names no
 * outcome still ends the run; it is not an error, because asking for an explicit
 * name where the reason already explains the ending buys nothing.
 *
 * `reason` is optional in the output, meaning absent rather than null when the
 * caller gave none, so it is omitted here instead of set to null.
 */
export function normalizeWorkflowStop(input: WorkflowStopInput) {
  return {
    outcome: input.outcome || DEFAULT_STOP_OUTCOME,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

const UNPAIRED_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Text that survives jsonb round-tripping. NUL and lone surrogates parse as JSON
 * strings but PostgreSQL jsonb rejects them, so a note carrying one would fail
 * at the write rather than at the door.
 */
export function isStorableDecisionText(value: string): boolean {
  return !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);
}

/**
 * One entry in a work item's decisions ledger. The ledger is append-only: an
 * entry is written before the decision is delivered and is never edited, so the
 * record of who decided what survives the decision being reversed by a later one.
 */
export const DECISION_LEDGER_KINDS = Object.freeze(
  [
    "approval",
    "rejection",
    "request_changes",
    "steer",
    "takeover",
    "limit_change",
    "accept_with_reason",
    "stop",
    "request",
    "request_reminded",
    "request_withdrawn",
    "request_handled",
  ] as const,
);
export type DecisionLedgerKind = typeof DECISION_LEDGER_KINDS[number];

/**
 * Which ledger kinds require a recorded reason. Two do: an explicit "accept,
 * with reason" override (§9, reviewer messaging) and a stop, because a run that
 * ends on purpose must say why. The rest may carry an optional note.
 */
export function decisionKindRequiresReason(kind: DecisionLedgerKind): boolean {
  return kind === "accept_with_reason" || kind === "stop";
}

export const DecisionLedgerEntrySchema = z.object({
  kind: z.enum(DECISION_LEDGER_KINDS).describe(
    "What was decided. The kind is what a reader filters on, and two kinds require a reason: accept_with_reason and stop.",
  ),
  subjectKind: z.string().min(1).max(60).describe(
    "Kind of thing the decision is about, for example run, step, approval or question. Free text with a bound, because the set of subjects grows with the extension points.",
  ),
  subjectId: z.string().uuid().describe(
    "The exact run, step, approval or question the decision is about. A decision never applies to more than the one thing it names.",
  ),
  decidedBy: z.string().uuid().nullable().describe(
    "Principal who decided: a person, or an agent where the workflow grants that decision. Null when the system ended the entry, such as an approval that expired with nobody answering; the reason then says why.",
  ),
  decidedAt: z.string().datetime().describe(
    "UTC instant of the decision.",
  ),
  reason: z.string().max(DECISION_NOTE_MAX_LENGTH).optional().describe(
    "Why the decision was made. Required for accept_with_reason and stop, optional otherwise.",
  ),
  text: z.string().max(DECISION_NOTE_MAX_LENGTH).optional().describe(
    "The steer or comment text that accompanied the decision, when the decision carried one.",
  ),
  detail: z.record(
    z.string().describe(
      "Payload key for one kind-specific detail value.",
    ),
    z.unknown().describe(
      "One kind-specific detail value, stored as data.",
    ),
  ).optional().describe(
    "Kind-specific payload, such as the previous and new limit for a limit_change. Stored as data, never interpreted by the kernel.",
  ),
}).strict().describe(
  "One appended entry in a work item's decisions ledger: what was decided, about what, by whom and why.",
);
export type DecisionLedgerEntry = z.output<typeof DecisionLedgerEntrySchema>;

/** Thrown when a ledger entry cannot be recorded as given. */
export class DecisionLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionLedgerError";
  }
}

/**
 * Validates a ledger entry before it is appended. Refuses the two ways an entry
 * can misrepresent a decision:
 *
 * - a kind that requires a reason arriving without one, which would leave a
 *   reader unable to tell why an override or a stop happened;
 * - text that cannot be stored, which would fail at the write instead of here.
 */
export function validateDecisionLedgerEntry(
  entry: DecisionLedgerEntry,
): DecisionLedgerEntry {
  if (decisionKindRequiresReason(entry.kind)) {
    if (entry.reason === undefined || entry.reason.trim() === "") {
      throw new DecisionLedgerError(
        `A ${entry.kind} decision must record a reason.`,
      );
    }
  }
  for (const value of [entry.reason, entry.text]) {
    if (value !== undefined && !isStorableDecisionText(value)) {
      throw new DecisionLedgerError(
        "Decision text must not contain NUL or unpaired surrogate characters.",
      );
    }
  }
  return entry;
}
