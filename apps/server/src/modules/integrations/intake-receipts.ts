import { z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  isPgConnectionFailure,
} from "@bakery/persistence";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import {
  decryptInstallationSecret,
  loadSecretKey,
  SecretCipherSchema,
} from "../secrets/crypto.ts";
import { InstallationStatus, liveConnections } from "./installation-fan-out.ts";
import {
  classifyEvent,
  type IntakeRoutePurpose,
  type ParsedDelivery,
  parseDeliveryIdHeader,
  parseEventNameHeader,
  projectEvent,
} from "./intake-events.ts";
import { verifyGitHubSignature } from "./intake-signature.ts";
import { GITHUB_PROVIDER } from "./postgres.ts";
import {
  findTrackedPullRequest,
  resolveRepositoryId,
} from "./pull-requests.ts";

/**
 * Persisting a verified GitHub delivery.
 *
 * A receipt is the host-level record that one delivery arrived: its identity,
 * the digest of its exact bytes, a bounded projection and what became of it.
 * It never holds the body. Routes are the per-connection work items a receipt
 * produces; this module only creates them, in the receipt's own transaction,
 * and never reads a payload field as proof of anything but where to look.
 */

/** Receipts expire this long after arrival, past GitHub's three-day redelivery window. */
export const RECEIPT_RETENTION_DAYS = 7;

/** Domain event whose outbox delivery wakes the route processor. */
export const INTAKE_RECEIVED_EVENT = "intake.received";

/** Audit operation recorded for a delivery that created at least one route. */
export const RECEIVE_OPERATION = "integrationEvents.receive";

/** Lifecycle of a receipt row; `received` exists only inside the receipt transaction. */
export const ReceiptStatus = Object.freeze(
  { Received: "received", Routed: "routed", Ignored: "ignored" } as const,
);
export type ReceiptStatus = (typeof ReceiptStatus)[keyof typeof ReceiptStatus];

/** Why a receipt created no route; stored in `rejection_reason`, never returned to GitHub. */
export const ReceiptReason = Object.freeze(
  {
    UnsupportedEvent: "unsupported_event",
    Ping: "ping",
    NoInstallation: "no_installation",
    UnknownInstallation: "unknown_installation",
    InstallationPending: "installation_pending",
    InstallationSuspended: "installation_suspended",
    InstallationRevoked: "installation_revoked",
    NoLiveConnection: "no_live_connection",
    UnselectedRepository: "unselected_repository",
    ConnectionNotEnabled: "connection_not_enabled",
    UntrackedPullRequest: "untracked_pull_request",
  } as const,
);
export type ReceiptReason = (typeof ReceiptReason)[keyof typeof ReceiptReason];

/** Lifecycle of a route row; the processor owns every transition after `pending`. */
export const RouteStatus = Object.freeze(
  {
    Pending: "pending",
    Processing: "processing",
    Deferred: "deferred",
    Completed: "completed",
    Ignored: "ignored",
    Failed: "failed",
  } as const,
);
export type RouteStatus = (typeof RouteStatus)[keyof typeof RouteStatus];

const REPOSITORY_RESOURCE_KIND = "repository";
const CONNECTION_ENABLED = "enabled";
const CONNECTION_REVOKED = "revoked";

/** Lifecycle events reach live connections even while the installation is not enabled. */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
]);

export type WebhookReceipt = z.output<typeof contractSchemas.WebhookReceipt>;

/** Who the verified delivery is and what its bytes were; the event itself travels beside it. */
export const DeliveryIdentitySchema = z.object({
  registrationId: z.string().uuid().describe(
    "Bakery id of the registered GitHub App whose active webhook secret verified the signature; with deliveryId it is the receipt's identity.",
  ),
  deliveryId: z.string().refine(
    (value) => parseDeliveryIdHeader(value) !== null,
    "Delivery id must be 1 to 255 letters, digits or hyphens.",
  ).describe(
    "The X-GitHub-Delivery header value. It identifies the delivery within the registration and authorizes nothing.",
  ),
  eventName: z.string().refine(
    (value) => parseEventNameHeader(value) !== null,
    "Event name must be 1 to 100 lowercase letters or underscores.",
  ).describe(
    "The X-GitHub-Event header value, kept as the receipt's event kind; it is compared on a repeated delivery so one id cannot change event.",
  ),
  digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase hex SHA-256 of the exact raw body bytes the signature covered, compared on a repeated delivery.",
  ),
}).strict().describe(
  "Identity and byte digest of one signature-verified GitHub delivery, set only by the receiving route after the signature checked out.",
);
export type DeliveryIdentity = z.output<typeof DeliveryIdentitySchema>;

/** A verified delivery handed to the registered `intake.github` action. */
export type PreparedDelivery = DeliveryIdentity & { event: ParsedDelivery };

/** The active webhook secret of the registered App; the caller zeroes `secret`. */
export type WebhookSecret = {
  registrationId: string;
  secret: Uint8Array<ArrayBuffer>;
};

type StoredWebhookSecretRow = {
  registrationId: string;
  secretId: string;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
};

/**
 * Reads and decrypts the active webhook secret revision of the registered
 * GitHub App, mirroring how the App credentials are read. Null when there is
 * no registration, the registration has no webhook secret, the secrets key is
 * unavailable or the ciphertext does not open: every one of those answers the
 * caller the same way as a bad signature. A database failure is thrown. The
 * caller zeroes the returned bytes (`secret.fill(0)`) in a `finally`.
 */
export async function readWebhookSecret(
  database: PgDatabase,
  secretsKey: SecretsKeyConfig | undefined,
): Promise<WebhookSecret | null> {
  const result = await database.query<StoredWebhookSecretRow>(
    `select registration.id as "registrationId", secret.id as "secretId",
       version.revision, version.key_id as "keyId",
       version.ciphertext, version.nonce
     from bakery.integration_app_registrations as registration
     join bakery.secrets as secret
       on secret.id = registration.webhook_secret_id
       and secret.organization_id is null and secret.application_id is null
     join bakery.secret_versions as version
       on version.id = secret.active_version_id and version.secret_id = secret.id
     where registration.provider = $1`,
    [GITHUB_PROVIDER],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  let opened: Uint8Array;
  try {
    opened = await decryptInstallationSecret(
      await loadSecretKey(secretsKey),
      { secretId: row.secretId, revision: row.revision, keyId: row.keyId },
      SecretCipherSchema.parse({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
      }),
    );
  } catch {
    return null;
  }
  const secret = new Uint8Array(opened.byteLength);
  secret.set(opened);
  opened.fill(0);
  return { registrationId: row.registrationId, secret };
}

/**
 * Verifies the signature over the exact body bytes and zeroes the secret
 * whatever the outcome, so the webhook secret is held in memory only for the
 * comparison.
 */
export async function verifyWithWebhookSecret(
  stored: WebhookSecret,
  signature: Uint8Array<ArrayBuffer> | null,
  raw: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    return await verifyGitHubSignature(stored.secret, signature, raw);
  } finally {
    stored.secret.fill(0);
  }
}

type InstallationRow = { id: string; status: string };

type RoutePlan = {
  organizationId: string;
  connectionId: string;
  installationId: string;
  resourceId: string | null;
  purpose: IntakeRoutePurpose;
};

/** Where a receipt goes: the routes to create, or the reason it creates none. */
type Plan = { routes: RoutePlan[]; reason: ReceiptReason | null };

const ignore = (reason: ReceiptReason): Plan => ({ routes: [], reason });

type SelectedRepository = {
  resourceId: string;
  organizationId: string;
  connectionId: string;
  externalId: string;
  displayName: string;
  connectionStatus: string;
};

async function lookupInstallation(
  transaction: PgTransactionClient,
  registrationId: string,
  githubInstallationId: number,
): Promise<InstallationRow | null> {
  const found = await transaction.query<InstallationRow>(
    `select id, status from bakery.integration_installations
      where registration_id = $1 and external_authorization_id = $2`,
    [registrationId, String(githubInstallationId)],
  );
  return found.rows[0] ?? null;
}

/**
 * Selected, available repository resources of the installation for one GitHub
 * repository id. The partial unique index on selected resources allows at most
 * one organization to hold the selection, so at most one row is returned.
 */
async function selectedRepositories(
  transaction: PgTransactionClient,
  installationId: string,
  repositoryId: number,
): Promise<SelectedRepository[]> {
  const found = await transaction.query<SelectedRepository>(
    `select resource.id as "resourceId",
       resource.organization_id as "organizationId",
       resource.connection_id as "connectionId",
       resource.external_id as "externalId",
       resource.display_name as "displayName",
       connection.status as "connectionStatus"
     from bakery.integration_resources as resource
     join bakery.integration_connections as connection
       on connection.organization_id = resource.organization_id
       and connection.id = resource.connection_id
     where resource.installation_id = $1 and resource.kind = $2
       and resource.external_id = $3 and resource.selected
       and resource.available and resource.archived_at is null
       and connection.installation_id = $1 and connection.archived_at is null
     order by resource.id`,
    [installationId, REPOSITORY_RESOURCE_KIND, String(repositoryId)],
  );
  return found.rows;
}

function notEnabledReason(status: string): ReceiptReason {
  switch (status) {
    case InstallationStatus.Suspended:
      return ReceiptReason.InstallationSuspended;
    case InstallationStatus.Revoked:
      return ReceiptReason.InstallationRevoked;
    default:
      return ReceiptReason.InstallationPending;
  }
}

/**
 * Decides, from the verified event and Bakery's own rows, which connections
 * the receipt wakes. Nothing in the payload names an organization: the
 * installation and repository ids only locate rows Bakery already holds.
 */
async function planRoutes(
  transaction: PgTransactionClient,
  event: ParsedDelivery,
  installation: InstallationRow | null,
): Promise<Plan> {
  if (!event.supported) return ignore(ReceiptReason.UnsupportedEvent);
  const purpose = classifyEvent(event);
  if (purpose === "ping") return ignore(ReceiptReason.Ping);
  const projection = projectEvent(event);
  if (projection.installationId === null) {
    return ignore(ReceiptReason.NoInstallation);
  }
  if (installation === null) return ignore(ReceiptReason.UnknownInstallation);
  if (LIFECYCLE_EVENTS.has(event.eventName)) {
    const connections = (await liveConnections(
      transaction,
      installation.id,
      false,
    )).filter((connection) => connection.status !== CONNECTION_REVOKED);
    if (connections.length === 0) return ignore(ReceiptReason.NoLiveConnection);
    return {
      reason: null,
      routes: connections.map((connection) => ({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        installationId: installation.id,
        resourceId: null,
        purpose,
      })),
    };
  }
  // Repository and resource events act on a connection's selection, so a
  // suspended or revoked installation receives no route and nothing replays
  // them when it recovers.
  if (installation.status !== InstallationStatus.Enabled) {
    return ignore(notEnabledReason(installation.status));
  }
  if (projection.repositoryId === null) {
    return ignore(ReceiptReason.UnselectedRepository);
  }
  const selected = await selectedRepositories(
    transaction,
    installation.id,
    projection.repositoryId,
  );
  if (selected.length === 0) return ignore(ReceiptReason.UnselectedRepository);
  const routes: RoutePlan[] = [];
  let reason: ReceiptReason = ReceiptReason.UnselectedRepository;
  for (const resource of selected) {
    if (resource.connectionStatus !== CONNECTION_ENABLED) {
      reason = ReceiptReason.ConnectionNotEnabled;
      continue;
    }
    if (
      event.eventName === "pull_request" || event.eventName === "check_run" ||
      event.eventName === "check_suite"
    ) {
      const repositoryId = await resolveRepositoryId(transaction, {
        organizationId: resource.organizationId,
        connectionId: resource.connectionId,
        externalId: resource.externalId,
        displayName: resource.displayName,
      });
      const tracked = repositoryId === null
        ? null
        : await findTrackedPullRequest(
          transaction,
          {
            organizationId: resource.organizationId,
            repositoryId,
            ...(event.eventName === "pull_request"
              ? { number: projection.number ?? undefined }
              : { headSha: projection.headSha ?? undefined }),
          },
        );
      if (tracked === null) {
        reason = ReceiptReason.UntrackedPullRequest;
        continue;
      }
    }
    routes.push({
      organizationId: resource.organizationId,
      connectionId: resource.connectionId,
      installationId: installation.id,
      resourceId: resource.resourceId,
      purpose,
    });
  }
  return routes.length === 0 ? ignore(reason) : { routes, reason: null };
}

const RECEIVED_AT =
  `to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Writes one route and the domain event and outbox row that wake its processor. */
async function insertRoute(
  transaction: PgTransactionClient,
  inboundEventId: string,
  plan: RoutePlan,
  traceId: string,
): Promise<string> {
  const routeId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.inbound_event_routes (
       id, inbound_event_id, organization_id, connection_id, installation_id,
       resource_id, purpose, status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      routeId,
      inboundEventId,
      plan.organizationId,
      plan.connectionId,
      plan.installationId,
      plan.resourceId,
      plan.purpose,
      RouteStatus.Pending,
    ],
  );
  await appendDomainEvent(transaction, {
    organizationId: plan.organizationId,
    eventType: INTAKE_RECEIVED_EVENT,
    aggregateId: routeId,
    aggregateVersion: 1,
    payload: { inboundEventId },
    traceId,
    outboxDeliveryKey: `intake:${routeId}`,
  });
  return routeId;
}

async function receive(
  transaction: PgTransactionClient,
  prepared: PreparedDelivery,
  context: Pick<ActionContext, "requestId" | "traceId">,
): Promise<WebhookReceipt> {
  const { event } = prepared;
  const projection = event.supported ? projectEvent(event) : null;
  const eventId = crypto.randomUUID();
  const inserted = await transaction.query<{ receivedAt: string }>(
    `insert into bakery.inbound_events (
       id, provider, registration_id, external_delivery_id, payload_digest,
       event_kind, event_action, normalized_projection, status, expires_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
       now() + make_interval(days => $10::int))
     on conflict (registration_id, external_delivery_id) do nothing
     returning ${RECEIVED_AT} as "receivedAt"`,
    [
      eventId,
      GITHUB_PROVIDER,
      prepared.registrationId,
      prepared.deliveryId,
      prepared.digest,
      prepared.eventName,
      projection?.action ?? null,
      projection === null ? null : JSON.stringify(projection),
      ReceiptStatus.Received,
      RECEIPT_RETENTION_DAYS,
    ],
  );
  const first = inserted.rows[0];
  if (first === undefined) {
    // The delivery id was already received (or is being received by a
    // concurrent request whose commit this insert waited for): the same bytes
    // and event are acknowledged, anything else is refused and changes nothing.
    const winner = (await transaction.query<{
      id: string;
      digest: string;
      eventKind: string;
      receivedAt: string;
    }>(
      `select id, payload_digest as digest, event_kind as "eventKind",
         ${RECEIVED_AT} as "receivedAt"
       from bakery.inbound_events
       where registration_id = $1 and external_delivery_id = $2`,
      [prepared.registrationId, prepared.deliveryId],
    )).rows[0];
    if (winner === undefined) {
      // Expired and swept between the insert and this read; a retry is accepted as new.
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    if (
      winner.digest !== prepared.digest ||
      winner.eventKind !== prepared.eventName
    ) throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    return {
      eventId: winner.id,
      status: "duplicate",
      taskId: null,
      receivedAt: winner.receivedAt,
    };
  }
  const installation = projection?.installationId == null
    ? null
    : await lookupInstallation(
      transaction,
      prepared.registrationId,
      projection.installationId,
    );
  const plan = await planRoutes(transaction, event, installation);
  for (const route of plan.routes) {
    await insertRoute(transaction, eventId, route, context.traceId);
  }
  const routed = plan.routes.length > 0;
  await transaction.query(
    `update bakery.inbound_events
        set installation_id = $2, status = $3, rejection_reason = $4
      where id = $1`,
    [
      eventId,
      installation?.id ?? null,
      routed ? ReceiptStatus.Routed : ReceiptStatus.Ignored,
      plan.reason,
    ],
  );
  if (routed) {
    await appendAudit(transaction, {
      organizationId: null,
      principalId: null,
      operation: RECEIVE_OPERATION,
      resourceType: "inbound_event",
      resourceId: eventId,
      requestId: context.requestId,
      traceId: context.traceId,
      details: { eventKind: prepared.eventName, routes: plan.routes.length },
    });
  }
  return {
    eventId,
    status: routed ? "accepted" : "ignored",
    taskId: null,
    receivedAt: first.receivedAt,
  };
}

function isDatabaseError(error: unknown): boolean {
  if (isPgConnectionFailure(error)) return true;
  const code = typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Turns a database failure into the retryable 503 GitHub shows as a failed
 * delivery; every other error passes through. One structured line records the
 * stage and error class only, never the message, which may carry row data.
 */
export function deliveryFailure(
  error: unknown,
  stage: "secret" | "commit",
  context: Pick<ActionContext, "requestId" | "traceId">,
): unknown {
  if (error instanceof StandardError || !isDatabaseError(error)) return error;
  console.warn(JSON.stringify({
    component: "integrations",
    event: "github_webhook_unavailable",
    stage,
    errorClass: error instanceof Error ? error.name : typeof error,
    requestId: context.requestId,
    traceId: context.traceId,
  }));
  return new StandardError({ code: "DEPENDENCY_UNAVAILABLE", cause: error });
}

/**
 * Persists one verified delivery in a single transaction: the receipt, the
 * routes it earns and, for each route, the domain event and outbox row that
 * wake the processor, plus one audit row when any route was created. A repeat
 * of a delivered id with the same bytes and event returns the original receipt
 * and writes nothing; different bytes or a different event name under that id
 * throw IDEMPOTENCY_PAYLOAD_MISMATCH and change nothing. A commit failure is a
 * retryable DEPENDENCY_UNAVAILABLE, so a 202 always means the receipt is durable.
 */
export async function recordDelivery(
  database: PgDatabase,
  prepared: PreparedDelivery,
  context: Pick<ActionContext, "requestId" | "traceId" | "signal">,
): Promise<WebhookReceipt> {
  try {
    return await withPgTransaction(
      database,
      (transaction) => receive(transaction, prepared, context),
      context.signal,
    );
  } catch (error) {
    throw deliveryFailure(error, "commit", context);
  }
}
