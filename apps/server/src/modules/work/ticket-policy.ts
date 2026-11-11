import { unprocessable } from "@bakery/contracts/http";
import {
  type TicketRequestIntent,
  type TicketSourcePolicy,
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
 * Intent the request labels ask for, ignoring the hold label: the execute
 * label covers planning and execution (`start`), the planning-only label asks
 * for a plan (`plan`). Names are matched exactly and case-sensitively.
 */
export function requestedIntentFromLabels(
  labels: readonly string[],
  policy: Pick<TicketSourcePolicy, "labels">,
): TicketRequestIntent | null {
  if (labels.includes(policy.labels.execute)) return "start";
  if (
    policy.labels.planOnly !== null && labels.includes(policy.labels.planOnly)
  ) {
    return "plan";
  }
  return null;
}

/**
 * Intent and hold state read from issue labels. The hold label wins: while it
 * is set no intent is granted, whatever other labels say.
 */
export function intentFromLabels(
  labels: readonly string[],
  policy: Pick<TicketSourcePolicy, "labels">,
): TicketLabelIntent {
  const hold = labels.includes(policy.labels.hold);
  return {
    intent: hold ? null : requestedIntentFromLabels(labels, policy),
    hold,
  };
}

/**
 * Whether the labels carry a request label that covers `intent`. A `start`
 * intent needs the execute label; a `plan` intent is covered by the execute or
 * the planning-only label. The hold label is a separate check.
 */
export function labelsCoverIntent(
  labels: readonly string[],
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
