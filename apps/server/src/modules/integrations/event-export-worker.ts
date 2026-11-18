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
      order by subscription.id
      limit $4`,
    [
      event.organizationId,
      event.sourceResourceId,
      event.eventKind,
      EXPORT_FAN_OUT_LIMIT,
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

/**
 * Runs on every recorded source event.
 *
 * Concurrency is capped so one organization's burst cannot starve the rest, and
 * retries are left to the delivery ledger: an uncertain attempt is rescheduled
 * by the recovery sweep with its own backoff, so the worker itself retrying
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
      triggers: [{ event: "bakery/source-event.recorded" }],
    },
    async ({ event, step }) =>
      await step.run(
        "export-recorded-event",
        () => exportSourceEvent(options, event.data as SourceEventRecorded),
      ),
  );
}

export { retryDelayMs };
