import {
  authorizeEventExport,
  type ExportDecision,
  type ExportDestination,
  type ExportRefusal,
  type ExportSubscription,
} from "./event-export-authorization.ts";
import type { AuthoritySnapshot } from "../catalog/integration-gate.ts";

/**
 * Sends one event to one destination, or refuses to (issue #21, AC2 and AC3).
 *
 * The authorization predicate on its own proves nothing: AC2 is a statement
 * about what happens on the wire and in the ledger. So this is the path that
 * calls it, and it is ordered so that a refusal can only end one way - the
 * authorization is decided *first*, before a delivery row is written and before
 * anything is sent. A refused export therefore leaves no delivery row and makes
 * no outbound request, which is the observable property QA can check.
 *
 * Everything external is injected. That is not only for testing: the ledger and
 * the transport are the two things a caller could get wrong independently, and
 * keeping them behind ports means this module cannot quietly reach a database or
 * an HTTP client on its own.
 */

/** The delivery ledger seam. A refusal must never reach it. */
export type DeliveryLedger = {
  /**
   * Records the attempt. Returns the row's id.
   *
   * `deliveryIdentity` is the stable name a receiver deduplicates on, so a
   * retry presents the same identity instead of looking like a new delivery.
   */
  record(input: {
    readonly organizationId: string;
    readonly subscriptionId: string;
    readonly destinationId: string;
    readonly sourceEventId: string;
    readonly eventKind: string;
    readonly attempt: number;
    readonly deliveryIdentity: string;
    readonly payloadDigest: string;
  }): Promise<{ readonly deliveryId: string }>;

  /** Settles the attempt with what the receiver did. */
  settle(input: {
    readonly deliveryId: string;
    readonly status:
      | "delivered"
      | "failed"
      | "uncertain";
    readonly acknowledgementState: "acknowledged" | "uncertain" | "refused";
    readonly responseStatus: number | null;
    readonly outcomeCode: string | null;
    readonly notBefore: Date | null;
  }): Promise<void>;
};

/** The outbound seam. A refusal must never reach it. */
export type DeliveryTransport = {
  send(input: {
    readonly origin: string;
    readonly path: string;
    readonly raw: Uint8Array<ArrayBuffer>;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<DeliveryOutcome>;
};

/**
 * What a receiver did.
 *
 * `uncertain` is a first-class outcome, not a failure: a timeout or a dropped
 * connection after the request left says nothing about whether the receiver
 * acted on it, and AC3 requires that this stay distinguishable from a refusal so
 * the retry rules can treat it differently.
 */
export type DeliveryOutcome =
  | { readonly kind: "acknowledged"; readonly status: number }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "uncertain"; readonly reason: string };

export type DispatchResult =
  | {
    readonly ok: true;
    readonly deliveryId: string;
    readonly deliveryIdentity: string;
    readonly outcome: DeliveryOutcome;
  }
  | { readonly ok: false; readonly reason: ExportRefusal };

/**
 * A stable delivery identity: the same subscription and event always produce the
 * same string, so every attempt at one delivery is recognisably the same delivery
 * to a receiver deduplicating on it.
 *
 * The attempt number is deliberately NOT part of it. Including it was a real bug
 * caught in review, and the reasoning is worth keeping: an identity that changes
 * per attempt makes a retry look like a new delivery, which is the exact thing
 * the identity exists to prevent. A receiver deduplicating on this would store
 * the same event twice under two names. The attempt belongs in the ledger row -
 * it says which try this is - not in the name the receiver sees.
 *
 * The parts are joined with `-` after a `bakery-` prefix and the subscription is
 * shortened, keeping it inside the 128-character limit the signature's delivery
 * header accepts. That limit is why the raw values are not simply concatenated.
 */
export function deliveryIdentity(input: {
  readonly subscriptionId: string;
  readonly sourceEventId: string;
}): string {
  const subscription = input.subscriptionId.replace(/-/g, "").slice(0, 16);
  const event = input.sourceEventId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return `bakery-${subscription}-${event}`;
}

/** Bounded exponential backoff for a retryable attempt, capped at an hour. */
export function retryDelayMs(attempt: number): number {
  const capped = Math.min(Math.max(attempt, 1), 32);
  return Math.min(1_000 * 2 ** (capped - 1), 3_600_000);
}

/**
 * Decides, records and sends one event.
 *
 * The order is the contract: authorize, then record, then send. Anything that
 * refuses returns before the ledger is touched, so "no delivery row" and "no
 * outbound request" are consequences of the control flow rather than of a
 * condition somebody remembered to check in the right place.
 */
export async function dispatchEventExport(input: {
  readonly snapshot: AuthoritySnapshot;
  readonly subscription: ExportSubscription & { readonly id: string };
  readonly destination: ExportDestination & {
    readonly id: string;
    readonly origin: string;
    readonly path: string;
  };
  readonly eventKind: string;
  readonly sourceEventId: string;
  readonly attempt: number;
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly payloadDigest: string;
  readonly sign: (
    deliveryIdentity: string,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly ledger: DeliveryLedger;
  readonly transport: DeliveryTransport;
  readonly now: () => Date;
}): Promise<DispatchResult> {
  const decision: ExportDecision = authorizeEventExport({
    snapshot: input.snapshot,
    subscription: input.subscription,
    destination: input.destination,
    eventKind: input.eventKind,
  });

  // A refusal ends here. Nothing is written and nothing is sent.
  if (!decision.ok) return { ok: false, reason: decision.reason };

  // One identity per subscription and event, computed before the row is written
  // so the row and the receiver see the same value on every attempt.
  const identity = deliveryIdentity({
    subscriptionId: input.subscription.id,
    sourceEventId: input.sourceEventId,
  });

  const { deliveryId } = await input.ledger.record({
    organizationId: input.snapshot.organizationId,
    subscriptionId: input.subscription.id,
    destinationId: input.destination.id,
    sourceEventId: input.sourceEventId,
    eventKind: input.eventKind,
    attempt: input.attempt,
    deliveryIdentity: identity,
    payloadDigest: input.payloadDigest,
  });

  let outcome: DeliveryOutcome;
  try {
    outcome = await input.transport.send({
      origin: input.destination.origin,
      path: input.destination.path,
      raw: input.raw,
      headers: await input.sign(identity),
    });
  } catch (error) {
    // A transport that threw after the request left is uncertain, not failed:
    // the receiver may or may not have acted, and AC3 keeps that distinct so a
    // retry does not read as a first attempt.
    outcome = {
      kind: "uncertain",
      reason: error instanceof Error ? error.name : "transport_error",
    };
  }

  const settledAt = input.now();
  if (outcome.kind === "acknowledged") {
    await input.ledger.settle({
      deliveryId,
      status: "delivered",
      acknowledgementState: "acknowledged",
      responseStatus: outcome.status,
      outcomeCode: null,
      notBefore: null,
    });
  } else if (outcome.kind === "refused") {
    await input.ledger.settle({
      deliveryId,
      status: "failed",
      acknowledgementState: "refused",
      responseStatus: outcome.status,
      outcomeCode: `http_${outcome.status}`,
      notBefore: null,
    });
  } else {
    // Uncertain keeps the same delivery identity and is retried after backoff,
    // so recovery cannot fork the delivery into a second one.
    await input.ledger.settle({
      deliveryId,
      status: "uncertain",
      acknowledgementState: "uncertain",
      responseStatus: null,
      outcomeCode: outcome.reason,
      notBefore: new Date(settledAt.getTime() + retryDelayMs(input.attempt)),
    });
  }

  return { ok: true, deliveryId, deliveryIdentity: identity, outcome };
}

/**
 * What a repeated delivery identity means (issue #21, AC3).
 *
 * The signature's timestamp stops a captured request being replayed later, and
 * covering the delivery ID stops a signature being lifted onto a *different*
 * delivery. Neither stops the *same* delivery being sent twice inside the
 * tolerance window: it is still fresh and still correctly signed, so it verifies.
 * Only the ledger can tell the two apart, which is why this lives here and not
 * in the signature.
 */
export type ReplayVerdict =
  /** Nothing recorded under this identity yet. */
  | { readonly kind: "new" }
  /** The same identity and the same bytes: already delivered, do not send again. */
  | { readonly kind: "duplicate"; readonly deliveryId: string }
  /** The same identity with different bytes: a conflict, never a retry. */
  | { readonly kind: "conflict"; readonly deliveryId: string };

/**
 * Decides what to do with a delivery identity that may already be recorded.
 *
 * A duplicate is acknowledged rather than re-sent: the receiver already has it,
 * and sending again would be exactly the replay this is meant to prevent. A
 * conflict is neither sent nor acknowledged - the identity is being reused for
 * different content, which is either a bug or an attack, and quietly delivering
 * either one would hide it.
 */
export function classifyReplay(
  existing:
    | { readonly deliveryId: string; readonly payloadDigest: string }
    | null,
  payloadDigest: string,
): ReplayVerdict {
  if (existing === null) return { kind: "new" };
  return existing.payloadDigest === payloadDigest
    ? { kind: "duplicate", deliveryId: existing.deliveryId }
    : { kind: "conflict", deliveryId: existing.deliveryId };
}
