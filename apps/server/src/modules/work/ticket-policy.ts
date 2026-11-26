import { unprocessable } from "@bakery/contracts/http";
import {
  type TicketPreviewFilters,
  TicketPreviewFiltersSchema,
  type TicketRequestIntent,
  type TicketSourcePolicy,
  type TicketSourcePolicyInput,
  TicketSourcePolicyInputSchema,
  TicketSourcePolicySchema,
} from "@bakery/contracts/ticket-admission";

/**
 * Pure policy rules for ticket sources: parsing the stored policy, reading the
 * request intent from issue labels, and deciding whether a label application
 * may admit work without a person. Nothing here reads a clock, the database or
 * the provider.
 */

/**
 * What an admission relies on to authorize its intent. `label` means the
 * request label on the issue is the authority and must be present (and, for
 * webhook and poll origins, applied by an allowlisted actor after
 * `automatic.since`); `manual` means an explicit caller request that needs no
 * label.
 */
export type TicketLabelBasis = "label" | "manual";

/** Intent a set of issue labels asks for, and whether the hold label is set. */
export type TicketLabelIntent = {
  intent: TicketRequestIntent | null;
  hold: boolean;
};

/**
 * Parses a stored or computed policy with the strict stored schema. A value
 * the schema refuses (unknown key, executable expression or URL in a label,
 * more than 25 delegated actors, automatic admission without `since`) is an
 * `UNPROCESSABLE` error.
 */
export function parseTicketSourcePolicy(value: unknown): TicketSourcePolicy {
  const parsed = TicketSourcePolicySchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      ["policy"],
      "ticket_source_policy_invalid",
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * The policy to store from one a client sent. `automatic.since` is the
 * server's: `now` when automatic admission is switched on (on create, on
 * every false-to-true flip, and when a disabled source is enabled again, which
 * the caller passes as no `previous`), unchanged while it stays on, null
 * while off. Whatever the client sent for it is ignored. A preview of a draft
 * (#69) stamps it the same way, so the draft is judged by the window saving
 * would give it.
 */
export type SourceWorkflowRequest = NonNullable<
  TicketSourcePolicyInput["workflow"]
>;

export type SourceWorkflow = NonNullable<TicketSourcePolicy["workflow"]>;

export type SourceWorkflowResolver = (
  requested: SourceWorkflowRequest,
) => Promise<SourceWorkflow>;

export async function storedTicketSourcePolicy(
  value: unknown,
  previous: TicketSourcePolicy | null,
  now: Date,
  resolveWorkflow: SourceWorkflowResolver,
): Promise<TicketSourcePolicy> {
  const parsed = TicketSourcePolicyInputSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      ["policy"],
      "ticket_source_policy_invalid",
      parsed.error,
    );
  }
  const { workflow: requested, ...rest } = parsed.data;
  const enabled = rest.automatic.enabled;
  if (enabled && requested === undefined) {
    throw unprocessable(
      ["policy", "workflow"],
      "ticket_source_workflow_required",
    );
  }
  const workflow = requested === undefined
    ? undefined
    : await resolveWorkflow(requested);
  const since = !enabled
    ? null
    : previous?.automatic.enabled === true
    ? previous.automatic.since
    : now.toISOString();
  return parseTicketSourcePolicy({
    ...rest,
    automatic: { enabled, since },
    ...(workflow === undefined ? {} : { workflow }),
  });
}

export function workflowRequired() {
  return unprocessable(["preset"], "ticket_workflow_required");
}

export function chosenWorkflowId<T extends string>(
  pinned: T | undefined,
  chosen: T | null | undefined,
  sourceDefault: T | undefined,
): T | null {
  return pinned ?? chosen ?? sourceDefault ?? null;
}

/** The `filters` of a preview; absent or empty narrows nothing, anything else unknown is 422. */
export function parsePreviewFilters(value: unknown): TicketPreviewFilters {
  if (value === undefined || value === null) return {};
  const parsed = TicketPreviewFiltersSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(["filters"], "filters_invalid", parsed.error);
  }
  return parsed.data;
}

export type TicketLabelSet = Readonly<{
  names: readonly string[];
  ids: readonly string[] | null;
}>;

export type TicketLabels = readonly string[] | TicketLabelSet;

type LabelRole = "execute" | "planOnly" | "hold";

export function labelSetOf(
  snapshot: Readonly<
    { labels: readonly string[]; labelIds?: readonly string[] }
  >,
): TicketLabelSet {
  return { names: snapshot.labels, ids: snapshot.labelIds ?? null };
}

function asLabelSet(labels: TicketLabels): TicketLabelSet {
  return "names" in labels ? labels : { names: labels, ids: null };
}

export function carriedLabelName(
  labels: TicketLabels,
  policy: Pick<TicketSourcePolicy, "labels">,
  role: LabelRole,
): string | null {
  const name = policy.labels[role];
  if (name === null) return null;
  const set = asLabelSet(labels);
  const id = policy.labels.ids?.[role] ?? null;
  if (id !== null && set.ids !== null) {
    const at = set.ids.indexOf(id);
    return at < 0 ? null : set.names[at] ?? null;
  }
  return set.names.includes(name) ? name : null;
}

export function requestedIntentFromLabels(
  labels: TicketLabels,
  policy: Pick<TicketSourcePolicy, "labels">,
): TicketRequestIntent | null {
  if (carriedLabelName(labels, policy, "execute") !== null) return "start";
  if (carriedLabelName(labels, policy, "planOnly") !== null) return "plan";
  return null;
}

export function intentFromLabels(
  labels: TicketLabels,
  policy: Pick<TicketSourcePolicy, "labels">,
): TicketLabelIntent {
  const hold = carriedLabelName(labels, policy, "hold") !== null;
  return {
    intent: hold ? null : requestedIntentFromLabels(labels, policy),
    hold,
  };
}

export function labelsCoverIntent(
  labels: TicketLabels,
  policy: Pick<TicketSourcePolicy, "labels">,
  intent: TicketRequestIntent,
): boolean {
  const requested = requestedIntentFromLabels(labels, policy);
  if (requested === null) return false;
  return intent === "plan" || requested === "start";
}

const OFFSET_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Instant of an ISO 8601 timestamp that carries an explicit offset (`Z` or
 * `+hh:mm`), in nanoseconds since the epoch, or null for anything else: no
 * offset, an impossible date or time (`2026-02-30`, hour 24, second 60), an
 * offset past 23:59, or text that is not a timestamp. It never reads the
 * process time zone, so the answer does not depend on where the code runs.
 */
export function parseOffsetInstant(value: string): bigint | null {
  const match = OFFSET_TIMESTAMP.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(
    Number,
  );
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day || wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (match[8] === "-" ? -1 : 1) *
      (offsetHour * 60 + offsetMinute);
  }
  const fraction = BigInt((match[7] ?? "").padEnd(9, "0"));
  return BigInt(wall.getTime()) * 1_000_000n + fraction -
    BigInt(offsetMinutes) * 60_000_000_000n;
}

/**
 * Whether a label application at `appliedAt` may admit work without a person:
 * automatic admission must be enabled, `since` must be set, and the label must
 * have been applied at or after `since`. A timestamp without an explicit
 * offset, or one that does not parse, fails closed; the comparison is by
 * instant and never uses the process time zone.
 */
export function automaticAdmissionAllowed(
  policy: Pick<TicketSourcePolicy, "automatic">,
  appliedAt: string,
): boolean {
  const { enabled, since } = policy.automatic;
  if (!enabled || since === null) return false;
  const applied = parseOffsetInstant(appliedAt);
  const boundary = parseOffsetInstant(since);
  if (applied === null || boundary === null) return false;
  return applied >= boundary;
}
