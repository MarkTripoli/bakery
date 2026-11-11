import { z } from "zod";

/**
 * Vocabulary, policy and report shapes for ticket sources, readiness and
 * single admission. The server's work module, the live GitHub
 * reader and the tests import this module, so the stored policy, the readiness
 * report and the reason codes have one definition. Everything here is data:
 * no policy value is an executable expression or a URL.
 */

type ConstTuple = readonly [string, ...string[]];

function memberOf<const Values extends ConstTuple>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value);
}

/** What an admission asks for: stop at a plan, or plan and then execute. */
export const TICKET_REQUEST_INTENTS = Object.freeze(
  ["plan", "start"] as const,
);
export type TicketRequestIntent = typeof TICKET_REQUEST_INTENTS[number];
export function isTicketRequestIntent(
  value: unknown,
): value is TicketRequestIntent {
  return memberOf(TICKET_REQUEST_INTENTS, value);
}

/**
 * Where an admission came from. `adoption` is an explicit request on an issue
 * that already carries the request label; `webhook` and `poll` are automatic.
 */
export const TICKET_REQUEST_ORIGINS = Object.freeze(
  ["manual", "adoption", "webhook", "poll"] as const,
);
export type TicketRequestOrigin = typeof TICKET_REQUEST_ORIGINS[number];
export function isTicketRequestOrigin(
  value: unknown,
): value is TicketRequestOrigin {
  return memberOf(TICKET_REQUEST_ORIGINS, value);
}

/**
 * Lifecycle of one admission generation. The first four after `pending` hold
 * the one-nonterminal-request slot per external ticket; the rest are terminal.
 */
export const TICKET_REQUEST_DISPOSITIONS = Object.freeze(
  [
    "pending",
    "waiting",
    "admitted",
    "active",
    "suspended",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ] as const,
);
export type TicketRequestDisposition =
  typeof TICKET_REQUEST_DISPOSITIONS[number];
export function isTicketRequestDisposition(
  value: unknown,
): value is TicketRequestDisposition {
  return memberOf(TICKET_REQUEST_DISPOSITIONS, value);
}

/**
 * The dispositions that occupy the partial unique slot of
 * `ticket_requests_one_nonterminal_idx`. Keep in step with migration 0145.
 */
export const NONTERMINAL_TICKET_DISPOSITIONS = Object.freeze(
  ["waiting", "admitted", "active", "suspended"] as const,
);
export type NonterminalTicketDisposition =
  typeof NONTERMINAL_TICKET_DISPOSITIONS[number];
export function isNonterminalTicketDisposition(
  value: unknown,
): value is NonterminalTicketDisposition {
  return memberOf(NONTERMINAL_TICKET_DISPOSITIONS, value);
}

/** Dispositions that end a generation and free the slot. */
export const TERMINAL_TICKET_DISPOSITIONS = Object.freeze(
  ["rejected", "completed", "failed", "canceled"] as const,
);
export type TerminalTicketDisposition =
  typeof TERMINAL_TICKET_DISPOSITIONS[number];
export function isTerminalTicketDisposition(
  value: unknown,
): value is TerminalTicketDisposition {
  return memberOf(TERMINAL_TICKET_DISPOSITIONS, value);
}

/** The readiness checks, in the order an evaluator reports them. */
export const TICKET_CHECK_IDS = Object.freeze(
  [
    "source_live",
    "ticket_supported",
    "not_held",
    "intent_authorized",
    "epic_excluded",
    "acceptance_present",
    "dependencies_satisfied",
    "no_active_admission",
    "repository_ready",
    "preset_ready",
    "authority_live",
    "requirements_unchanged",
  ] as const,
);
export type TicketCheckId = typeof TICKET_CHECK_IDS[number];
export function isTicketCheckId(value: unknown): value is TicketCheckId {
  return memberOf(TICKET_CHECK_IDS, value);
}

/** Outcome of one check: `wait` can clear by itself, `reject` needs a decision. */
export const TICKET_CHECK_STATUSES = Object.freeze(
  ["pass", "wait", "reject"] as const,
);
export type TicketCheckStatus = typeof TICKET_CHECK_STATUSES[number];

/** Aggregate outcome of a report. */
export const TICKET_REPORT_VERDICTS = Object.freeze(
  ["ready", "waiting", "rejected"] as const,
);
export type TicketReportVerdict = typeof TICKET_REPORT_VERDICTS[number];

/**
 * `ready` only when every check passes, `rejected` when any check rejects,
 * else `waiting`. Both the evaluator and the report schema derive the verdict
 * here, so a stored verdict that disagrees with its checks is invalid.
 */
export function ticketVerdictFromChecks(
  checks: readonly { status: TicketCheckStatus }[],
): TicketReportVerdict {
  if (checks.some((check) => check.status === "reject")) return "rejected";
  if (checks.some((check) => check.status === "wait")) return "waiting";
  return "ready";
}

/**
 * Reasons that suspend a request and clear by themselves: when the condition
 * is restored, a recheck resumes the request after re-verifying authority and
 * label provenance live. Includes source-state and repository or preset setup
 * reasons, which an operator fixes outside the ticket.
 */
export const TICKET_AUTO_RESUMABLE_REASONS = Object.freeze(
  [
    "held",
    "label_missing",
    "label_withdrawn",
    "predecessor_open",
    "closed_unmerged",
    "proof_unavailable",
    "inaccessible",
    "links_truncated",
    "provider_unavailable",
    "no_delegation",
    "actor_not_allowlisted",
    "actor_role_insufficient",
    "actor_unverifiable",
    "principal_inactive",
    "source_disabled",
    "connection_not_enabled",
    "installation_not_enabled",
    "resource_not_selected",
    "repository_archived",
    "no_active_profile",
    "preset_setup_required",
  ] as const,
);
export type TicketAutoResumableReason =
  typeof TICKET_AUTO_RESUMABLE_REASONS[number];

/**
 * Reasons that suspend a request and stay suspended until an explicit
 * `ticketRequests.create` re-evaluates it (and re-pins it when the pinned
 * requirements digest changed). A recheck never resumes these.
 */
export const TICKET_EXPLICIT_RESUME_REASONS = Object.freeze(
  [
    "acceptance_changed",
    "ticket_closed",
    "ticket_gone",
    "ticket_moved",
    "pull_request_not_ticket",
    "repository_mismatch",
    "requirements_too_large",
    "has_sub_issues",
  ] as const,
);
export type TicketExplicitResumeReason =
  typeof TICKET_EXPLICIT_RESUME_REASONS[number];

/**
 * Reasons that never suspend a request: `ok` is carried by every passing
 * check, and the others only appear before a request exists (the ticket is
 * not yet admitted, so there is nothing to suspend). A request that already
 * exists records `acceptance_changed` instead of `acceptance_missing` when
 * its acceptance criteria disappear.
 */
export const TICKET_NON_SUSPENDING_REASONS = Object.freeze(
  ["ok", "acceptance_missing", "active_request", "adoption_required"] as const,
);
export type TicketNonSuspendingReason =
  typeof TICKET_NON_SUSPENDING_REASONS[number];

/**
 * Every reason a check or a disposition can carry: the disjoint union of the
 * three sets above. A reason belongs to exactly one set.
 */
export const TICKET_REASON_CODES = Object.freeze(
  [
    ...TICKET_AUTO_RESUMABLE_REASONS,
    ...TICKET_EXPLICIT_RESUME_REASONS,
    ...TICKET_NON_SUSPENDING_REASONS,
  ] as const,
);
export type TicketReasonCode = typeof TICKET_REASON_CODES[number];
export function isTicketReasonCode(value: unknown): value is TicketReasonCode {
  return memberOf(TICKET_REASON_CODES, value);
}
export function isTicketAutoResumableReason(
  value: unknown,
): value is TicketAutoResumableReason {
  return memberOf(TICKET_AUTO_RESUMABLE_REASONS, value);
}
export function isTicketExplicitResumeReason(
  value: unknown,
): value is TicketExplicitResumeReason {
  return memberOf(TICKET_EXPLICIT_RESUME_REASONS, value);
}

/**
 * The reasons each check may emit besides `ok`. `provider_unavailable` is
 * listed under every check that depends on a provider read: a failed read
 * never passes a check, it yields `wait` with that reason.
 */
export const TICKET_CHECK_REASONS: Readonly<
  Record<TicketCheckId, readonly TicketReasonCode[]>
> = Object.freeze({
  source_live: Object.freeze(
    [
      "source_disabled",
      "connection_not_enabled",
      "installation_not_enabled",
      "resource_not_selected",
    ] as const,
  ),
  ticket_supported: Object.freeze(
    [
      "ticket_closed",
      "pull_request_not_ticket",
      "ticket_gone",
      "ticket_moved",
      "repository_mismatch",
      "requirements_too_large",
      "provider_unavailable",
    ] as const,
  ),
  not_held: Object.freeze(["held", "provider_unavailable"] as const),
  intent_authorized: Object.freeze(
    [
      "label_missing",
      "label_withdrawn",
      "adoption_required",
      "provider_unavailable",
    ] as const,
  ),
  epic_excluded: Object.freeze(
    ["has_sub_issues", "provider_unavailable"] as const,
  ),
  acceptance_present: Object.freeze(
    ["acceptance_missing", "provider_unavailable"] as const,
  ),
  dependencies_satisfied: Object.freeze(
    [
      "predecessor_open",
      "closed_unmerged",
      "proof_unavailable",
      "inaccessible",
      "links_truncated",
      "provider_unavailable",
    ] as const,
  ),
  no_active_admission: Object.freeze(["active_request"] as const),
  repository_ready: Object.freeze(
    ["repository_archived", "no_active_profile"] as const,
  ),
  preset_ready: Object.freeze(["preset_setup_required"] as const),
  authority_live: Object.freeze(
    [
      "no_delegation",
      "actor_not_allowlisted",
      "actor_role_insufficient",
      "actor_unverifiable",
      "principal_inactive",
      "provider_unavailable",
    ] as const,
  ),
  requirements_unchanged: Object.freeze(
    ["acceptance_changed", "provider_unavailable"] as const,
  ),
});

/** GitHub caps a label name at 50 characters. */
export const TICKET_LABEL_NAME_MAX_LENGTH = 50;
/** Most GitHub user ids one source policy may delegate to. */
export const TICKET_DELEGATION_MAX_ACTORS = 25;
/** Most labels one ticket snapshot keeps. */
export const TICKET_SNAPSHOT_MAX_LABELS = 50;
/** Longest stored title, in UTF-16 code units (`tasks.title` allows 500). */
export const TICKET_SNAPSHOT_TITLE_MAX_LENGTH = 500;
/**
 * Longest stored body, in UTF-16 code units. It equals the `tasks.description`
 * cap: the stored body is cut so the task description plus its footer fits.
 */
export const TICKET_SNAPSHOT_BODY_MAX_LENGTH = 20_000;
/** Longest provider body the reader hands over, in Unicode code points. */
export const TICKET_PROVIDER_BODY_MAX_CODE_POINTS = 65_536;
/** Most native blockers one snapshot keeps; more are reported as truncated. */
export const TICKET_SNAPSHOT_MAX_BLOCKERS = 50;
/** Most evidence entries one check carries. */
export const TICKET_CHECK_MAX_EVIDENCE = 5;
/** Most checks one report carries (one per check id). */
export const TICKET_REPORT_MAX_CHECKS = TICKET_CHECK_IDS.length;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const REPOSITORY_FULL_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PROVIDER_NUMERIC_ID = /^[1-9][0-9]{0,18}$/;

/** True when a label name could be read as markup, a URL or an expression. */
function labelNameIsUnsafe(value: string): boolean {
  if (value !== value.trim()) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return value.includes("://") || value.includes("{{") ||
    value.includes("${") || value.includes("`");
}

const policyLabelName = z.string().min(1).max(TICKET_LABEL_NAME_MAX_LENGTH)
  .refine((value) => !labelNameIsUnsafe(value), {
    message:
      "A label name must be trimmed and free of control characters, URLs and expression markers.",
  }).describe(
    "Exact GitHub label display name, 1 to 50 characters, matched case-sensitively; it carries no URL, control character or expression marker.",
  );

/**
 * A label as GitHub reports it on an issue. Unlike a policy label it is
 * evidence, not configuration: whatever name the provider holds must be
 * storable, so only its length is bounded.
 */
const providerLabelName = z.string().min(1).max(TICKET_LABEL_NAME_MAX_LENGTH)
  .describe(
    "Label display name exactly as GitHub reports it, 1 to 50 characters; kept verbatim as evidence and never interpreted.",
  );

const sha256Hex = z.string().regex(SHA256_HEX).describe(
  "Lowercase 64-character hexadecimal SHA-256 digest.",
);

const repositoryFullName = z.string().regex(REPOSITORY_FULL_NAME).describe(
  "GitHub repository full name in owner/name form, at most 140 characters.",
);

const providerNumericId = z.string().regex(PROVIDER_NUMERIC_ID).describe(
  "GitHub numeric identifier written as a decimal string without leading zeros, so it survives JSON number limits.",
);

const issueNumber = z.number().int().min(1).describe(
  "GitHub issue number inside its repository, at least 1.",
);

const policyLabelsShape = {
  execute: policyLabelName.describe(
    "Label that requests execution. It also covers planning: an issue carrying it may be admitted with either intent.",
  ),
  planOnly: policyLabelName.nullable().describe(
    "Label that requests a plan and nothing more, or null to disable planning-only labels. A planning-only label never starts a run.",
  ),
  hold: policyLabelName.describe(
    "Label that holds a ticket. It wins over every other label: an issue carrying it is never admitted and its request suspends.",
  ),
};

const policyApprovalShape = {
  plan: z.enum(["automatic", "human_approval"]).describe(
    "How a start intent clears the plan checkpoint. automatic creates the fixed-coding run at admission; human_approval leaves the request waiting until an approved plan revision exists.",
  ),
};

const policyReadinessShape = {
  requireAcceptanceCriteria: z.boolean().describe(
    "Whether the ticket must carry an Acceptance criteria heading with at least one list item before it is ready.",
  ),
};

const policyDelegationSchema = z.object({
  principalId: z.uuid().describe(
    "Bakery principal that automatic admissions act as. Its task:write and run:write authority is checked live on every admission.",
  ),
  githubActorIds: z.array(providerNumericId).min(1).max(
    TICKET_DELEGATION_MAX_ACTORS,
  ).refine((ids) => new Set(ids).size === ids.length, {
    message: "A delegation lists each GitHub user id once.",
  }).describe(
    "GitHub user ids, 1 to 25 unique decimal strings, whose label applications may trigger automatic admission. Each must also hold repository role write or higher.",
  ),
}).strict().describe(
  "Delegation that lets verified label applications by allowlisted GitHub users admit work as a Bakery principal.",
);

const policyLabelsSchema = z.object(policyLabelsShape).strict().refine(
  (labels) => {
    const names = [labels.execute, labels.hold];
    if (labels.planOnly !== null) names.push(labels.planOnly);
    return new Set(names).size === names.length;
  },
  { message: "The execute, planning-only and hold labels must differ." },
).describe(
  "Label display names that drive admission intent and hold; all must differ.",
);

const policyApprovalSchema = z.object(policyApprovalShape).strict().describe(
  "Approval checkpoints that gate a started run.",
);

const policyReadinessSchema = z.object(policyReadinessShape).strict().describe(
  "Readiness options evaluated for every ticket of this source.",
);

const policyPresetSchema = z.literal("fixed-coding").describe(
  "Fixed workflow preset every admission of this source runs; always fixed-coding, the only preset admission runs, even if the workflow preset catalog gains others.",
);

const policyVersionSchema = z.literal(1).describe(
  "Version of the ticket source policy document; always 1.",
);

const automaticSinceSchema = z.iso.datetime({ offset: true }).describe(
  "Instant from which a label application may admit work automatically, as an ISO 8601 timestamp with offset.",
);

/**
 * Policy as stored and returned: `automatic.enabled` implies a non-null
 * `since`. The server stamps `since` itself, so a client cannot back-date
 * eligibility.
 */
export const TicketSourcePolicySchema = z.object({
  version: policyVersionSchema,
  labels: policyLabelsSchema,
  delegation: policyDelegationSchema.nullable().describe(
    "Delegation for automatic admission, or null for none. Without it an issue is previewed and never admitted automatically.",
  ),
  automatic: z.object({
    enabled: z.boolean().describe(
      "Whether webhook and poll origins may admit work. When false, only explicit requests admit.",
    ),
    since: automaticSinceSchema.nullable().describe(
      "Server-stamped instant (set when automatic admission is first enabled) before which labeled issues wait for explicit adoption; null only while automatic admission is disabled.",
    ),
  }).strict().refine(
    (automatic) => !automatic.enabled || automatic.since !== null,
    {
      message: "Automatic admission requires a since timestamp.",
      path: ["since"],
    },
  ).describe(
    "Automatic admission switch and the instant that bounds which label applications qualify.",
  ),
  readiness: policyReadinessSchema,
  approval: policyApprovalSchema,
  preset: policyPresetSchema,
}).strict().describe(
  "Strict, versioned ticket source policy as stored: label names, optional delegation, automatic admission window, readiness options, plan approval and preset. Data only; it holds no expression or URL.",
);
export type TicketSourcePolicy = z.output<typeof TicketSourcePolicySchema>;

/**
 * Policy as a client sends it on create or update. `automatic.since` may be
 * omitted or null, and any value sent is ignored: the server stamps it to now
 * on create when `enabled` is true, on every false-to-true flip and when a
 * disabled source is enabled again.
 */
export const TicketSourcePolicyInputSchema = z.object({
  version: policyVersionSchema,
  labels: policyLabelsSchema,
  delegation: policyDelegationSchema.nullable().describe(
    "Delegation for automatic admission, or null for none.",
  ),
  automatic: z.object({
    enabled: z.boolean().describe(
      "Whether webhook and poll origins may admit work. Turning it on stamps since to the server clock.",
    ),
    since: automaticSinceSchema.nullable().optional().describe(
      "Ignored on input. The server stamps this value; omit it or send null.",
    ),
  }).strict().describe(
    "Automatic admission switch. The eligibility instant is server-owned.",
  ),
  readiness: policyReadinessSchema,
  approval: policyApprovalSchema,
  preset: policyPresetSchema,
}).strict().describe(
  "Ticket source policy as a client submits it; identical to the stored policy except that automatic.since is optional, nullable and ignored.",
);
export type TicketSourcePolicyInput = z.input<
  typeof TicketSourcePolicyInputSchema
>;

/**
 * A fresh default policy: execute "ready for agent", planning-only
 * "ready for planning", hold "bakery:hold", no delegation, automatic admission
 * off, acceptance criteria required, human plan approval.
 */
export function defaultTicketSourcePolicy(): TicketSourcePolicy {
  return TicketSourcePolicySchema.parse({
    version: 1,
    labels: {
      execute: "ready for agent",
      planOnly: "ready for planning",
      hold: "bakery:hold",
    },
    delegation: null,
    automatic: { enabled: false, since: null },
    readiness: { requireAcceptanceCriteria: true },
    approval: { plan: "human_approval" },
    preset: "fixed-coding",
  });
}

/** Reference to one issue: the provider id, number and repository. */
export const TicketIssueRefSchema = z.object({
  id: providerNumericId.describe(
    "GitHub issue id (the immutable database id, not the number) as a decimal string.",
  ),
  number: issueNumber,
  repositoryFullName: repositoryFullName.describe(
    "Repository that holds the issue, in owner/name form.",
  ),
}).strict().describe(
  "Reference to one GitHub issue by its immutable id, number and repository.",
);
export type TicketIssueRef = z.output<typeof TicketIssueRefSchema>;

const issueState = z.enum(["open", "closed"]).describe(
  "GitHub issue state: open or closed.",
);
const issueStateReason = z.string().min(1).max(40).nullable().describe(
  "GitHub state_reason (for example completed or not_planned) of a closed issue, or null when none is reported.",
);

/**
 * One issue as the reader hands it over, before bounding. The reader drops the
 * body text of an oversized issue and sets `bodyTooLarge`.
 */
export const TicketSnapshotInputSchema = z.object({
  externalId: providerNumericId.describe(
    "GitHub issue id (immutable database id) as a decimal string; the dedupe identity of the ticket.",
  ),
  number: issueNumber,
  title: z.string().max(TICKET_SNAPSHOT_TITLE_MAX_LENGTH).describe(
    "Issue title, at most 500 UTF-16 code units; the reader cuts a longer title.",
  ),
  body: z.string().describe(
    "Issue body as read, at most 65,536 Unicode code points. Empty when the issue has no body or when bodyTooLarge is true.",
  ),
  bodyTooLarge: z.boolean().describe(
    "True when the provider body exceeds 65,536 code points; the reader then keeps no body text.",
  ),
  labels: z.array(providerLabelName).max(TICKET_SNAPSHOT_MAX_LABELS).describe(
    "Label display names on the issue, at most 50.",
  ),
  state: issueState,
  stateReason: issueStateReason,
  locked: z.boolean().describe(
    "Whether the issue is locked against new comments.",
  ),
  repositoryFullName: repositoryFullName.describe(
    "Repository the issue belongs to, in owner/name form.",
  ),
}).strict().superRefine((input, context) => {
  if ([...input.body].length > TICKET_PROVIDER_BODY_MAX_CODE_POINTS) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "The body exceeds 65,536 code points.",
    });
  }
}).describe(
  "One GitHub issue as read from the provider, unbounded except for the reader's own limits.",
);
export type TicketSnapshotInput = z.output<typeof TicketSnapshotInputSchema>;

/** Native relationships of one issue. */
export const TicketLinksSchema = z.object({
  parent: TicketIssueRefSchema.nullable().describe(
    "Parent issue when this issue is a sub-issue, or null.",
  ),
  subIssuesTotal: z.number().int().min(0).describe(
    "Number of sub-issues the provider reports; a positive count makes the issue an epic, which is excluded.",
  ),
  blockedBy: z.array(TicketIssueRefSchema).max(TICKET_SNAPSHOT_MAX_BLOCKERS)
    .describe(
      "Native blocking issues, at most 50. A longer provider list is not stored; links_truncated reports it.",
    ),
  blockingTotal: z.number().int().min(0).describe(
    "Number of issues this issue blocks, as the provider reports it.",
  ),
}).strict().describe(
  "Native parent, sub-issue and dependency relationships of one issue.",
);
export type TicketLinks = z.output<typeof TicketLinksSchema>;

/** The bounded, normalized issue snapshot stored on `external_tickets`. */
export const TicketSnapshotSchema = z.object({
  title: z.string().max(TICKET_SNAPSHOT_TITLE_MAX_LENGTH).describe(
    "Issue title with newlines normalized, at most 500 UTF-16 code units.",
  ),
  body: z.string().max(TICKET_SNAPSHOT_BODY_MAX_LENGTH).describe(
    "Issue body with newlines normalized, at most 20,000 UTF-16 code units, cut at a code point boundary so the task description plus its footer fits the task cap.",
  ),
  bodyTruncated: z.boolean().describe(
    "True when the stored body is shorter than the provider body. The requirements digest still covers the full normalized text.",
  ),
  labels: z.array(providerLabelName).max(TICKET_SNAPSHOT_MAX_LABELS).describe(
    "Label display names at the observation, at most 50.",
  ),
  state: issueState,
  stateReason: issueStateReason,
  locked: z.boolean().describe(
    "Whether the issue was locked at the observation.",
  ),
  repositoryFullName: repositoryFullName.describe(
    "Repository the issue belonged to at the observation, in owner/name form.",
  ),
  links: TicketLinksSchema.nullable().describe(
    "Native relationships at the observation, or null when the links read did not succeed. Absence is never inferred.",
  ),
}).strict().describe(
  "Bounded snapshot of one GitHub issue kept for readiness, preview and task creation. Never holds credentials, comments or attachments.",
);
export type TicketSnapshot = z.output<typeof TicketSnapshotSchema>;

/** Identity of the preset an admission or a report was bound to. */
export const TicketPresetPinSchema = z.object({
  id: z.literal("fixed-coding").describe(
    "Workflow preset id; always fixed-coding, the only preset admission runs.",
  ),
  revision: z.number().int().min(1).describe(
    "Revision of the preset definition at the observation, at least 1.",
  ),
  digest: sha256Hex.describe(
    "SHA-256 digest of the canonical preset specification, so a changed preset is detectable.",
  ),
}).strict().describe(
  "Fixed workflow preset identity (id, revision, digest) bound to a report or an admitted request.",
);
export type TicketPresetPin = z.output<typeof TicketPresetPinSchema>;

const evidenceRef = z.string().min(1).max(200).describe(
  "Short stable reference to what a check read, such as label:ready for agent or blocker:owner/repo#12. Never a URL or a body excerpt.",
);

export const TicketReadinessEvidenceSchema = z.object({
  ref: evidenceRef,
  digest: sha256Hex.optional().describe(
    "SHA-256 digest of the evidence content when one applies; omitted when the reference alone identifies it.",
  ),
}).strict().describe(
  "One piece of evidence a check relied on: a stable reference and an optional content digest.",
);

export const TicketReadinessCheckSchema = z.object({
  id: z.enum(TICKET_CHECK_IDS).describe("Which readiness check produced this."),
  status: z.enum(TICKET_CHECK_STATUSES).describe(
    "pass when satisfied, wait when it can clear on its own, reject when it needs a decision.",
  ),
  reason: z.enum(TICKET_REASON_CODES).describe(
    "Stable reason code: ok for a pass, otherwise the cause of the wait or reject.",
  ),
  evidence: z.array(TicketReadinessEvidenceSchema).max(
    TICKET_CHECK_MAX_EVIDENCE,
  ).describe("Up to 5 evidence entries the check relied on; empty if none."),
}).strict().superRefine((check, context) => {
  const passes = check.status === "pass";
  if (passes !== (check.reason === "ok")) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A check carries reason ok exactly when it passes.",
    });
  }
}).describe(
  "Outcome of one readiness check with its stable reason code and evidence.",
);
export type TicketReadinessCheck = z.output<typeof TicketReadinessCheckSchema>;

/**
 * The pure evaluator's report. The per-ticket sequence number is assigned when
 * the report is stored, so it is not part of this shape.
 */
export const TicketReadinessReportSchema = z.object({
  version: z.literal(1).describe(
    "Version of the report document shape; always 1. The per-ticket report sequence is assigned on storage.",
  ),
  verdict: z.enum(TICKET_REPORT_VERDICTS).describe(
    "ready when every check passes, rejected when any check rejects, otherwise waiting.",
  ),
  checks: z.array(TicketReadinessCheckSchema).min(1).max(
    TICKET_REPORT_MAX_CHECKS,
  ).describe(
    "One entry per evaluated check, at most one per check id, in evaluation order.",
  ),
  requirementsDigest: sha256Hex.nullable().describe(
    "SHA-256 of the canonical title and body, or null when no body could be hashed (provider unavailable or body too large).",
  ),
  dependencyDigest: sha256Hex.nullable().describe(
    "SHA-256 of the dependency links and predecessor proofs, or null when the links were not read.",
  ),
  basisDigest: sha256Hex.describe(
    "SHA-256 over every input of the verdict: requirements, dependencies, source policy revision, preset and the check outcomes. A new report is stored only when it changes.",
  ),
  sourcePolicyRevision: z.number().int().min(1).describe(
    "Revision of the ticket source policy the report was evaluated against, at least 1.",
  ),
  preset: TicketPresetPinSchema,
}).strict().superRefine((report, context) => {
  const seen = new Set<string>();
  report.checks.forEach((check, index) => {
    if (seen.has(check.id)) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "id"],
        message: "A report holds each check id at most once.",
      });
    }
    seen.add(check.id);
  });
  if (report.verdict !== ticketVerdictFromChecks(report.checks)) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "The verdict must follow from the checks.",
    });
  }
}).describe(
  "Deterministic, versioned readiness report for one ticket: verdict, per-check outcomes with reasons, and the digests that bind it to the requirements, dependencies, policy revision and preset.",
);
export type TicketReadinessReport = z.output<
  typeof TicketReadinessReportSchema
>;

/**
 * One readiness report as stored in `ticket_readiness_reports`: the immutable
 * report document plus the per-ticket sequence it was stored under, its origin
 * and the evaluation time. `sequence` is the stored `version` column; the
 * document's own `version` field only names its shape.
 */
export const TicketStoredReportSchema = z.object({
  id: z.uuid().describe(
    "Identifier of the stored report row; a ticket request pins one by this id.",
  ),
  externalTicketId: z.uuid().describe(
    "Identifier of the external ticket the report belongs to.",
  ),
  sequence: z.number().int().min(1).describe(
    "Per-ticket report sequence, 1 for the first stored report and increasing by one for each stored change of basis.",
  ),
  report: TicketReadinessReportSchema.describe(
    "The immutable readiness report document: verdict, checks and digests.",
  ),
  origin: z.enum(TICKET_REQUEST_ORIGINS).describe(
    "Origin of the call that produced this evaluation: manual, adoption, webhook or poll.",
  ),
  evaluatedAt: z.iso.datetime({ offset: true }).describe(
    "When the report was stored, as an ISO 8601 timestamp with offset. Later evaluations with an unchanged basis store nothing, so this is the first time the basis was seen.",
  ),
}).strict().describe(
  "A stored, immutable readiness report with its per-ticket sequence, origin and evaluation time.",
);
export type TicketStoredReport = z.output<typeof TicketStoredReportSchema>;

/**
 * Evidence kept on a ticket request about how its admission was authorized.
 * It is fixed when the request is inserted, so a later evaluation of the same
 * request uses the origin and label basis it was admitted under.
 */
export const TicketAuthorityEvidenceSchema = z.object({
  version: z.literal(1).describe(
    "Version of the authority evidence document shape; always 1.",
  ),
  origin: z.enum(TICKET_REQUEST_ORIGINS).describe(
    "Origin the request was admitted under, repeated from the request row so the evidence stands alone.",
  ),
  labelBasis: z.enum(["label", "manual"]).describe(
    "What the intent rested on: label when the request label on the issue was the authority, manual when an explicit caller request needed none.",
  ),
  actingPrincipalId: z.uuid().describe(
    "Bakery principal the admission acted as: the caller for manual and adoption origins, the delegation principal for webhook and poll origins.",
  ),
  callerPrincipalId: z.uuid().nullable().describe(
    "Bakery principal that made an explicit request, or null for a webhook or poll origin.",
  ),
  provenance: z.object({
    actorId: providerNumericId.describe(
      "GitHub user id that applied the request label.",
    ),
    actorLogin: z.string().min(1).max(100).describe(
      "GitHub login that applied the request label, as the issue event reported it.",
    ),
    appliedAt: z.string().min(1).max(64).describe(
      "When the request label was applied, as the issue event reported it.",
    ),
  }).strict().nullable().describe(
    "Who applied the request label and when, for a webhook or poll origin; null otherwise.",
  ),
  actorRole: z.object({
    userId: providerNumericId.describe(
      "GitHub user id the role answer is about.",
    ),
    permission: z.enum(["admin", "write", "read", "none"]).describe(
      "Repository permission of that user at admission.",
    ),
  }).strict().nullable().describe(
    "Repository role of the labelling actor at admission, for a webhook or poll origin; null otherwise.",
  ),
}).strict().describe(
  "How a ticket request was authorized at admission: origin, label basis, the principal it acted as and, for automatic origins, the verified labelling actor and its role.",
);
export type TicketAuthorityEvidence = z.output<
  typeof TicketAuthorityEvidenceSchema
>;
