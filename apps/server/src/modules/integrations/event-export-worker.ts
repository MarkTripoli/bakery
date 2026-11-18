import type { Inngest } from "inngest";
import type { PgDatabase } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  AuthoritySnapshotPort,
} from "../catalog/integration-gate.ts";
import {
  type DeliveryTransport,
  dispatchEventExport,
  retryDelayMs,
} from "./event-export-dispatch.ts";
import {
  DELIVERY_HEADER,
  SIGNATURE_HEADER,
  signWebhookDelivery,
  TIMESTAMP_HEADER,
} from "./webhook-signature.ts";
import { createPostgresDeliveryLedger } from "./event-export-ledger.ts";

/**
 * The export worker (#21).
 *
 * Before this existed, `dispatchEventExport` was a predicate with no caller:
 * every refusal it can return, and every check slice 4 added, would have been
 * dead code in production. This is the caller - it runs on a recorded source
 * event, finds the subscriptions that name that event kind for that resource,
 * and dispatches once per subscription.
 *
 * One subscription failing never stops the others: each is its own attempt, and
 * a refusal is a decision rather than an exception, so the loop records it and
 * moves on.
 */

const EXPORT_FUNCTION_ID = "bakery-integration-event-export";

/**
 * Every two minutes. The intake route is already durable, so a short delay costs
 * nothing but latency, while a tighter tick would spend more on empty queries
 * than on deliveries.
 */
const EXPORT_SWEEP_CRON = "*/2 * * * *";

/**
 * How many times one delivery may be attempted before it is settled failed.
 *
 * An endpoint that has never acknowledged in this many tries is broken rather
 * than slow, and retrying it forever spends the sweep budget on it.
 */
const EXPORT_MAX_ATTEMPTS = 8;

/** Most subscriptions one source event is fanned out to in one run. */
export const EXPORT_FAN_OUT_LIMIT = 50;

/** The event the worker runs on. */
export type SourceEventRecorded = {
  readonly organizationId: string;
  readonly sourceEventId: string;
  readonly eventKind: string;
  readonly sourceResourceId: string;
  readonly payload: string;
};

type SubscriptionRow = {
  subscription_id: string;
  connection_id: string;
  destination_id: string;
  origin: string;
  path: string;
  destination_status: string;
  /**
   * The principal the export runs as.
   *
   * Taken from the connection rather than the destination: a destination has no
   * recipient principal, and inventing one is how this query first failed on a
   * fresh database. The connection records who granted it, and the export is an
   * act of that connection.
   */
  created_by: string;
  secret_version_id: string;
};

export type ExportRunResult = {
  /** Subscriptions the event was offered to. */
  readonly offered: number;
  /** Attempts that reached an acknowledged, refused or uncertain outcome. */
  readonly dispatched: number;
  /** Attempts that never left because a check said no. */
  readonly refused: number;
  /** Refusal reasons, counted, so a run is diagnosable without logging payloads. */
  readonly reasons: Readonly<Record<string, number>>;
};

export async function exportSourceEvent(
  dependencies: {
    readonly database: PgDatabase;
    readonly authority: AuthoritySnapshotPort;
    readonly registry: ActiveIntegrationRegistry;
    readonly transport: DeliveryTransport;
    /** Resolves a host exactly once per attempt; the result is what is judged. */
    readonly resolve: (host: string) => Promise<readonly string[]>;
    readonly secretFor: (secretVersionId: string) => Promise<string>;
  },
  event: SourceEventRecorded,
  options?: {
    /**
     * Offers the event to subscriptions that already hold an attempt.
     *
     * Off by default, and that default is the idempotency: the sweep re-reads
     * completed routes every couple of minutes, so without this a single event
     * would be exported again on every pass. A retry is a different act with its
     * own backoff, so it asks for this explicitly.
     */
    readonly retryExisting?: boolean;
  },
): Promise<ExportRunResult> {
  // Only subscriptions that name this exact event kind for this exact resource,
  // and that are still active. A revoked subscription is excluded by the query
  // and refused again by the authorization check, which is the point: the query
  // is an optimisation, and the decision is the predicate's.
  const subscriptions = await dependencies.database.query<SubscriptionRow>(
    `select subscription.id as subscription_id,
            subscription.connection_id,
            subscription.destination_id,
            destination.origin,
            destination.path,
            destination.status as destination_status,
            connection.created_by,
            destination.secret_version_id
       from bakery.integration_event_subscriptions as subscription
       join bakery.integration_destinations as destination
         on destination.organization_id = subscription.organization_id
        and destination.id = subscription.destination_id
       join bakery.integration_connections as connection
         on connection.organization_id = subscription.organization_id
        and connection.id = subscription.connection_id
      where subscription.organization_id = $1
        and subscription.source_resource_id = $2
        and subscription.status = 'active'
        and $3 = any(subscription.event_kinds)
        and ($5::boolean or not exists (
          select 1 from bakery.integration_deliveries as attempt
           where attempt.subscription_id = subscription.id
             and attempt.source_event_id = $6
        ))
      order by subscription.id
      limit $4`,
    [
      event.organizationId,
      event.sourceResourceId,
      event.eventKind,
      EXPORT_FAN_OUT_LIMIT,
      options?.retryExisting === true,
      event.sourceEventId,
    ],
  );

  const raw = new TextEncoder().encode(event.payload);
  const payloadDigest = await digest(raw);
  const reasons: Record<string, number> = {};
  let dispatched = 0;
  let refused = 0;

  for (const row of subscriptions.rows) {
    // The attempt number is read per subscription, so a retry appends an attempt
    // rather than colliding with the one before it.
    const attempt = await nextAttempt(
      dependencies.database,
      row.subscription_id,
      event.sourceEventId,
    );

    const secret = await dependencies.secretFor(row.secret_version_id);

    const result = await dispatchEventExport({
      snapshot: await loadAuthority(dependencies, event, row),
      subscription: {
        id: row.subscription_id,
        status: "active",
        revokedAt: null,
        eventKinds: [event.eventKind],
      },
      destination: {
        id: row.destination_id,
        status: row.destination_status as "active",
        tombstonedAt: null,
        origin: row.origin,
        path: row.path,
      },
      eventKind: event.eventKind,
      sourceEventId: event.sourceEventId,
      attempt,
      raw,
      payloadDigest,
      sign: async (identity) => {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = await signWebhookDelivery({
          timestamp,
          deliveryId: identity,
          raw,
          secret: new TextEncoder().encode(secret),
        });
        return {
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: String(timestamp),
          [DELIVERY_HEADER]: identity,
        };
      },
      resolve: dependencies.resolve,
      reloadAuthority: () => loadAuthority(dependencies, event, row),
      ledger: createPostgresDeliveryLedger(dependencies.database),
      transport: dependencies.transport,
      now: () => new Date(),
    });

    if (result.ok) {
      dispatched += 1;
      continue;
    }
    refused += 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
  }

  return {
    offered: subscriptions.rows.length,
    dispatched,
    refused,
    reasons,
  };
}

/**
 * Loads the live authority for one subscription's connection and resource.
 *
 * Answers an authority that authorizes nothing when the port cannot bind the
 * key, so a missing or foreign record refuses the export instead of throwing.
 */
async function loadAuthority(
  dependencies: Parameters<typeof exportSourceEvent>[0],
  event: SourceEventRecorded,
  row: SubscriptionRow,
) {
  const snapshot = await dependencies.authority.load({
    organizationId: event.organizationId,
    actorRef: row.created_by,
    connectionId: row.connection_id,
    resourceId: event.sourceResourceId,
  });
  return snapshot ?? EMPTY_AUTHORITY_PLACEHOLDER(event.organizationId);
}

function EMPTY_AUTHORITY_PLACEHOLDER(organizationId: string) {
  return {
    organizationId,
    actor: { principalId: "", subjectType: "principal", active: false },
    install: undefined,
    connection: { id: "", state: "disabled" },
    resource: undefined,
  } as never;
}

async function nextAttempt(
  database: PgDatabase,
  subscriptionId: string,
  sourceEventId: string,
): Promise<number> {
  const result = await database.query<{ next: number }>(
    `select coalesce(max(attempt), 0) + 1 as next
       from bakery.integration_deliveries
      where subscription_id = $1 and source_event_id = $2`,
    [subscriptionId, sourceEventId],
  );
  return Number(result.rows[0]?.next ?? 1);
}

async function digest(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(hashed))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Most completed routes one sweep pass exports. */
export const EXPORT_SWEEP_BATCH = 50;

/**
 * Exports the completed intake routes that no subscription has been offered yet.
 *
 * This is what makes the worker reachable without an emitter in another module:
 * the source events are already recorded, so the worker reads them rather than
 * waiting for a second module to remember to tell it. A route is offered once -
 * the delivery row is the marker - so a pass that overlaps another cannot send
 * the same event twice.
 */
export async function exportPendingIntakeEvents(
  dependencies: Parameters<typeof exportSourceEvent>[0],
  limit = EXPORT_SWEEP_BATCH,
): Promise<{ readonly offered: number; readonly events: number }> {
  const due = await dependencies.database.query<{
    organization_id: string;
    resource_id: string;
    event_id: string;
    event_kind: string;
    payload: string;
  }>(
    `select distinct on (receipt.id, subscription.id)
            route.organization_id,
            route.resource_id,
            receipt.id as event_id,
            receipt.event_kind,
            coalesce(receipt.normalized_projection::text, '{}') as payload
       from bakery.inbound_event_routes as route
       join bakery.inbound_events as receipt
         on receipt.id = route.inbound_event_id
       join bakery.integration_event_subscriptions as subscription
         on subscription.organization_id = route.organization_id
        and subscription.source_resource_id = route.resource_id
        and subscription.status = 'active'
        and receipt.event_kind = any(subscription.event_kinds)
      where route.status = 'completed'
        and not exists (
          select 1 from bakery.integration_deliveries as attempt
           where attempt.subscription_id = subscription.id
             and attempt.source_event_id = receipt.id::text
        )
      order by receipt.id, subscription.id
      limit $1`,
    [limit],
  );

  let offered = 0;
  for (const row of due.rows) {
    const result = await exportSourceEvent(dependencies, {
      organizationId: row.organization_id,
      sourceEventId: row.event_id,
      eventKind: row.event_kind,
      sourceResourceId: row.resource_id,
      payload: row.payload,
    });
    offered += result.offered;
  }
  return { offered, events: due.rows.length };
}

/**
 * Retries uncertain attempts whose backoff has elapsed.
 *
 * An `uncertain` attempt means the receiver may or may not have acted, so it is
 * the one status that must be retried - and the only safe way to retry it is with
 * the same delivery identity, which is what makes the receiver's dedupe work.
 * `not_before` is when that becomes allowed; nothing else was reading it, so
 * uncertain attempts were written and then forgotten, which turned "the receiver
 * might have it" into "the receiver will never get it".
 *
 * Attempts are capped: past `EXPORT_MAX_ATTEMPTS` the delivery is settled failed
 * rather than retried forever, because an endpoint that has never acknowledged in
 * that many tries is broken, not slow.
 */
export async function retryDueUncertainAttempts(
  dependencies: Parameters<typeof exportSourceEvent>[0],
  limit = EXPORT_SWEEP_BATCH,
): Promise<{ readonly retried: number }> {
  const due = await dependencies.database.query<{
    organization_id: string;
    destination_id: string;
    subscription_id: string;
    source_event_id: string;
    event_kind: string;
    payload: string;
    source_resource_id: string;
    attempt: number;
    delivery_id: string;
  }>(
    `select attempt.organization_id,
            attempt.destination_id,
            attempt.subscription_id,
            attempt.source_event_id,
            attempt.event_kind,
            coalesce(receipt.normalized_projection::text, '{}') as payload,
            subscription.source_resource_id,
            (array_agg(attempt.id order by attempt.attempt desc))[1] as delivery_id,
            max(attempt.attempt) as attempt
       from bakery.integration_deliveries as attempt
       join bakery.integration_event_subscriptions as subscription
         on subscription.id = attempt.subscription_id
       join bakery.inbound_events as receipt
         on receipt.id::text = attempt.source_event_id
      where attempt.status = 'uncertain'
        and (attempt.not_before is null or attempt.not_before <= now())
        and subscription.status = 'active'
      group by attempt.organization_id,
               attempt.destination_id,
               attempt.subscription_id,
               attempt.source_event_id,
               attempt.event_kind,
               receipt.normalized_projection,
               subscription.source_resource_id
      order by attempt.source_event_id
      limit $1`,
    [limit],
  );

  let retried = 0;
  for (const row of due.rows) {
    if (Number(row.attempt) >= EXPORT_MAX_ATTEMPTS) {
      // Out of retries: settle the attempt so it stops being swept. The identity
      // is unchanged, so a receiver that did act can still dedupe.
      const ledger = createPostgresDeliveryLedger(dependencies.database);
      await ledger.settle({
        deliveryId: row.delivery_id,
        status: "failed",
        acknowledgementState: "uncertain",
        responseStatus: null,
        outcomeCode: "attempts_exhausted",
        notBefore: null,
      }).catch(() => undefined);
      continue;
    }
    await exportSourceEvent(
      dependencies,
      {
        organizationId: row.organization_id,
        sourceEventId: row.source_event_id,
        eventKind: row.event_kind,
        sourceResourceId: row.source_resource_id,
        payload: row.payload,
      },
      { retryExisting: true },
    );
    retried += 1;
  }
  return { retried };
}

/**
 * Sweeps for exportable source events on a schedule.
 *
 * A cron, not an event trigger, and that is the whole point: an event trigger
 * needs something in another module to emit `bakery/source-event.recorded`, and
 * nothing in production does. A function nothing triggers is not a feature, it is
 * a registration - the same shape as an uncalled predicate, which this issue has
 * already been sent back for twice.
 *
 * Reading the source events itself costs one indexed query per tick and makes the
 * worker self-sufficient: it exports whatever completed intake routes have no
 * delivery row yet, including anything a previous tick missed.
 *
 * Retries are left to the delivery ledger. An uncertain attempt is rescheduled by
 * the sweep with its own backoff (`not_before`), so the worker retrying as well
 * would send the same delivery twice for two different reasons.
 */
export function createIntegrationEventExport(
  options: {
    readonly client: Inngest;
  } & Parameters<typeof exportSourceEvent>[0],
) {
  return options.client.createFunction(
    {
      id: EXPORT_FUNCTION_ID,
      retries: 0,
      concurrency: [{ limit: 5 }],
      triggers: [{ cron: EXPORT_SWEEP_CRON }],
    },
    async ({ step }) =>
      await step.run(
        "export-pending-events",
        async () => {
          // Both paths run: the sweep for anything unnoticed, and the retry pass
          // for uncertain attempts whose backoff has elapsed.
          const swept = await exportPendingIntakeEvents(options);
          const retried = await retryDueUncertainAttempts(options);
          return { ...swept, retried };
        },
      ),
  );
}

export { retryDelayMs };
