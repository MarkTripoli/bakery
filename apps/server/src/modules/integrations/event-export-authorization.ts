import type { AuthoritySnapshot } from "../catalog/integration-gate.ts";

/**
 * Whether one event may be exported to one destination (issue #21, AC2).
 *
 * AC2 is "a revoked subscription or a private source resource => no event
 * payload sent merely because the connection exists". The phrase that matters
 * is *merely because the connection exists*: a connection row is the weakest
 * possible evidence that an export is still authorized, and every other fact
 * that made the subscription legal can have changed since it was created.
 *
 * So this asks the whole question every time, from a freshly loaded snapshot,
 * and refuses on the first fact that no longer holds. It is deliberately a pure
 * function of its inputs: the caller loads the snapshot, and nothing here
 * caches, so a decision cannot outlive the authority it was made from.
 *
 * The checks are ordered cheapest-and-most-decisive first, and the refusal
 * reason is returned rather than thrown, because a delivery that is refused
 * must be recorded as refused with a reason rather than silently dropped.
 */

/** Why an export was refused. Every value is safe to store and to show. */
export type ExportRefusal =
  /** The subscription was revoked, or is not in an exporting state. */
  | "subscription_revoked"
  /** The subscription's event kinds do not include this event. */
  | "event_not_subscribed"
  /** The connection is disabled, revoked, pending or needs a reconnect. */
  | "connection_not_active"
  /** The install no longer holds the `events:subscribe` scope. */
  | "scope_not_granted"
  /** The source resource is no longer selected, or is no longer available. */
  | "source_not_exportable"
  /** The destination is disabled, tombstoned or unhealthy for delivery. */
  | "destination_not_exportable";

export type ExportDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExportRefusal };

const allow: ExportDecision = { ok: true };
const refuse = (reason: ExportRefusal): ExportDecision => ({
  ok: false,
  reason,
});

/** The subscription facts that can change after it was created. */
export type ExportSubscription = Readonly<{
  status: string;
  revokedAt: string | null;
  eventKinds: readonly string[];
}>;

/** The destination facts that can change after it was created. */
export type ExportDestination = Readonly<{
  status: string;
  tombstonedAt: string | null;
}>;

/**
 * Decides whether `eventKind` from `snapshot.resource` may be sent to
 * `destination` under `subscription`.
 *
 * `snapshot` is the same authority shape the catalog gate uses, so an export
 * cannot be authorized by a weaker reading of the same rows than an action
 * invocation is.
 */
export function authorizeEventExport(input: {
  readonly snapshot: AuthoritySnapshot;
  readonly subscription: ExportSubscription;
  readonly destination: ExportDestination;
  readonly eventKind: string;
}): ExportDecision {
  const { snapshot, subscription, destination, eventKind } = input;

  // A revoked subscription is the case AC2 names first. `revokedAt` is checked
  // as well as `status`, because a row can be marked revoked by either and a
  // disagreement between them must refuse rather than allow.
  if (subscription.status !== "active" || subscription.revokedAt !== null) {
    return refuse("subscription_revoked");
  }

  // An empty kind set exports nothing. It must never be read as "everything",
  // which is the reading that would turn a misconfigured subscription into a
  // firehose.
  if (!subscription.eventKinds.includes(eventKind)) {
    return refuse("event_not_subscribed");
  }

  // The connection must be live. `reconnect_required` is refused with the same
  // reason as `disabled`: in both cases the provider authorization behind the
  // connection is not currently usable, and an export would be sent on the
  // strength of a credential that no longer works.
  if (snapshot.connection.state !== "active") {
    return refuse("connection_not_active");
  }

  // The scope is the grant that makes event export a thing this install may do
  // at all. It is checked on every export rather than once at subscription
  // time, because an install can be re-approved with fewer scopes.
  if (!snapshot.install.approvedScopes.includes("events:subscribe")) {
    return refuse("scope_not_granted");
  }

  // A private source resource is the second case AC2 names. `selected` is the
  // organization's choice to export from it; `available` is whether the
  // provider still offers it. Either being false means the payload would carry
  // data the organization is no longer exporting.
  if (!snapshot.resource.selected || !snapshot.resource.available) {
    return refuse("source_not_exportable");
  }

  // A tombstoned destination is gone even if its status column still reads
  // active, so both are checked.
  if (destination.status !== "active" || destination.tombstonedAt !== null) {
    return refuse("destination_not_exportable");
  }

  return allow;
}
