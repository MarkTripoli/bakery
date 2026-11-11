import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { appendDomainEvent } from "@bakery/persistence";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { organizationActor } from "./auth-attempts.ts";
import { openAppSecret, readAppCredentials } from "./callbacks.ts";
import { DISCOVERY_PACE_MS, queueDiscovery } from "./discovery-queue.ts";
import { createGitHubAppJwt, GitHubReadFailure } from "./github-app.ts";
import { GITHUB_PROVIDER } from "./postgres.ts";
import {
  type ReconcileDependencies,
  reconcileInstallation,
} from "./reconcile.ts";
import {
  connectionNotEnabled,
  installationNotEnabled,
} from "./token-broker.ts";

type DiscoveryReceipt = z.output<
  typeof contractSchemas.IntegrationDiscoveryReceipt
>;

/** Lifecycle of one discovery row. */
export const DiscoveryStatus = Object.freeze(
  {
    Queued: "queued",
    Running: "running",
    /** A complete, successful scan; only this changes availability. */
    Completed: "completed",
    /** The scan did not finish (provider failure, 429, truncation, a change). */
    Partial: "partial",
    /** Refused before scanning: the connection or installation lost authority. */
    Failed: "failed",
  } as const,
);

/** Safe, enumerated outcome codes stored on a finished discovery. */
const DiscoveryOutcome = Object.freeze(
  {
    ConnectionUnavailable: "connection_unavailable",
    InstallationUnavailable: "installation_unavailable",
    DependencyUnavailable: "dependency_unavailable",
    TokenRefused: "token_refused",
    ScanIncomplete: "scan_incomplete",
    ScanTruncated: "scan_truncated",
    ConnectionChanged: "connection_changed",
  } as const,
);
type DiscoveryOutcome =
  (typeof DiscoveryOutcome)[keyof typeof DiscoveryOutcome];

export { DISCOVERY_PACE_MS };

/** Repository pages one scan reads at most (100 repositories each). */
export const MAX_DISCOVERY_PAGES = 30;
/** A queued or running discovery untouched this long is sent again. */
export const DISCOVERY_STALE_MS = 10 * 60_000;

const RESOURCES_CHANGED = "integration.resources_changed";
const CONNECTION_UPDATED = "integrationConnections.updated";

/** The router validated the path; parse it again so no unchecked value is used. */
function connectionPath(context: ActionContext): string {
  const parsed = contractSchemas.IdPath.safeParse({ id: context.params.id });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

/**
 * integrationDiscoveries.create: queues one bounded rescan of the caller's
 * connection. The connection and then its installation are locked, so two
 * requests for connections of one installation compute their pacing one
 * after the other. An active scan of the connection answers the request;
 * otherwise a new row starts no earlier than 30 seconds after the latest
 * scan of the installation, and integration.discovery_requested reaches
 * the discovery function through the outbox.
 */
export async function createDiscovery(
  context: ActionContext,
): Promise<DiscoveryReceipt> {
  const { context: value, actor } = organizationActor(context);
  const { transaction } = value;
  const connectionId = connectionPath(value);
  const readConnection = async (lock: boolean) =>
    (await transaction.query<{ status: string; installationId: string }>(
      `select status, installation_id as "installationId"
         from bakery.integration_connections
        where organization_id = $1 and id = $2 and archived_at is null
        ${lock ? "for update" : ""}`,
      [actor.organizationId, connectionId],
    )).rows[0];
  const unlocked = await readConnection(false);
  if (unlocked === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // Installation before connection, the order reconciliation locks them in.
  const installation = (await transaction.query<{ status: string }>(
    `select status from bakery.integration_installations
      where id = $1 for update`,
    [unlocked.installationId],
  )).rows[0];
  const connection = await readConnection(true);
  if (connection === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // A reconnect moved the connection to another installation meanwhile.
  if (connection.installationId !== unlocked.installationId) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "connection_changed" },
    });
  }
  if (connection.status !== "enabled") {
    throw connectionNotEnabled(connection.status);
  }
  if (installation?.status !== "enabled") throw installationNotEnabled();
  const { discoveryId, queued } = await queueDiscovery(transaction, {
    organizationId: actor.organizationId,
    connectionId,
    installationId: connection.installationId,
    principalId: actor.subject.principalId,
    traceId: value.traceId,
  });
  // An active scan of the connection answers the request.
  if (!queued) {
    return contractSchemas.IntegrationDiscoveryReceipt.parse({
      discoveryId,
      status: DiscoveryStatus.Queued,
    });
  }
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationDiscoveriesCreate,
    resourceType: "integration_discovery",
    resourceId: discoveryId,
    details: { provider: GITHUB_PROVIDER, connectionId },
  });
  return contractSchemas.IntegrationDiscoveryReceipt.parse({
    discoveryId,
    status: DiscoveryStatus.Queued,
  });
}

type ClaimedDiscovery = {
  id: string;
  organizationId: string;
  connectionId: string;
  installationId: string;
};

export type DiscoveryResult =
  /** Pacing: run again at `until` (ISO 8601). */
  | { kind: "waiting"; until: string }
  /** Already finished, or unknown. */
  | { kind: "skipped" }
  | {
    kind: "finished";
    status: "completed" | "partial" | "failed";
    outcome: DiscoveryOutcome | null;
    /** Resources the scan made unavailable (completed scans only). */
    unavailable: number;
    /** Resources the scan made available again (completed scans only). */
    restored: number;
  };

/**
 * Claims the discovery: a queued row whose pacing time has come moves to
 * running; a running row (a crashed or retried run) is resumed.
 */
async function claim(
  database: PgDatabase,
  discoveryId: string,
): Promise<ClaimedDiscovery | { waitUntil: string } | null> {
  return await withPgTransaction(database, async (transaction) => {
    const row = (await transaction.query<
      ClaimedDiscovery & { status: string; notBefore: Date; due: boolean }
    >(
      `select id, organization_id as "organizationId",
         connection_id as "connectionId", installation_id as "installationId",
         status, not_before as "notBefore", not_before <= now() as due
         from bakery.integration_discoveries where id = $1 for update`,
      [discoveryId],
    )).rows[0];
    if (
      row === undefined ||
      (row.status !== DiscoveryStatus.Queued &&
        row.status !== DiscoveryStatus.Running)
    ) return null;
    if (!row.due) return { waitUntil: row.notBefore.toISOString() };
    await transaction.query(
      `update bakery.integration_discoveries
          set status = 'running', started_at = coalesce(started_at, now()),
              updated_at = now(), version = version + 1
        where id = $1`,
      [discoveryId],
    );
    return {
      id: row.id,
      organizationId: row.organizationId,
      connectionId: row.connectionId,
      installationId: row.installationId,
    };
  });
}

/** Finishes a running discovery; a finished one is left as it is. */
async function finish(
  client: Pick<PgTransactionClient, "query">,
  discoveryId: string,
  status: "completed" | "partial" | "failed",
  outcome: DiscoveryOutcome | null,
  counts: { listed: number | null; unavailable: number | null } = {
    listed: null,
    unavailable: null,
  },
): Promise<void> {
  await client.query(
    `update bakery.integration_discoveries
        set status = $2, outcome_code = $3, completed_at = now(),
            listed_count = $4, unavailable_count = $5,
            updated_at = now(), version = version + 1
      where id = $1 and status = 'running'`,
    [discoveryId, status, outcome, counts.listed, counts.unavailable],
  );
}

type ScanTarget = {
  connectionStatus: string;
  /** Read after the reconcile; the availability write requires it unchanged. */
  connectionVersion: number;
  installationStatus: string;
  installationExternalId: string;
};

/**
 * Scans every repository the installation covers with an unnarrowed
 * metadata-read token, revoked afterwards. Null when the scan did not
 * complete: a failed page (including 429), more pages than the bound, or
 * a refused token.
 */
async function scan(
  dependencies: ReconcileDependencies,
  installationId: number,
  signal: AbortSignal,
): Promise<{ listed: Set<number> } | { incomplete: DiscoveryOutcome }> {
  let minted: Awaited<
    ReturnType<ReconcileDependencies["github"]["mintDiscoveryToken"]>
  >;
  try {
    const credentials = await withPgTransaction(
      dependencies.database,
      (transaction) => readAppCredentials(transaction),
    );
    if (credentials === null) {
      return { incomplete: DiscoveryOutcome.DependencyUnavailable };
    }
    const key = await loadSecretKey(dependencies.secretsKey);
    // The PEM lives only for this signing call.
    const pem = await openAppSecret(key, credentials.privateKey);
    const jwt = await createGitHubAppJwt(credentials.appId, pem);
    minted = await dependencies.github.mintDiscoveryToken(
      { jwt, installationId },
      signal,
    );
  } catch (error) {
    // No key, an unreadable key or a failed mint: the scan never started,
    // and the discovery finishes instead of staying running.
    if (signal.aborted) throw error;
    return { incomplete: DiscoveryOutcome.DependencyUnavailable };
  }
  if (minted.kind === "refused") {
    return { incomplete: DiscoveryOutcome.TokenRefused };
  }
  const listed = new Set<number>();
  try {
    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
      const result = await dependencies.github.listInstallationRepositories(
        minted.token,
        page,
        signal,
      );
      for (const id of result.repositoryIds) listed.add(id);
      if (!result.hasNext) return { listed };
    }
    return { incomplete: DiscoveryOutcome.ScanTruncated };
  } catch (error) {
    // A failed page, including a rate limit, a rejected token or a
    // timeout GitHub's client classified.
    if (error instanceof StandardError || error instanceof GitHubReadFailure) {
      return { incomplete: DiscoveryOutcome.ScanIncomplete };
    }
    throw error;
  } finally {
    await dependencies.github.revokeInstallationToken(minted.token);
  }
}

/**
 * Runs one discovery: claim it, reconcile its installation, scan, and on a
 * complete scan set each of the connection's live repository resources
 * available exactly when the installation still lists it. Rows are never
 * added: only the setup flow, which proves the connecting user administers
 * a repository, records one. Any scan that did not complete changes no
 * resource. The availability write rechecks, under the connection and
 * installation row locks, that both are still enabled and that no edit or
 * reconcile moved the broker generation captured at claim.
 */
export async function executeDiscovery(
  dependencies: ReconcileDependencies,
  discoveryId: string,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const claimed = await claim(dependencies.database, discoveryId);
  if (claimed === null) return { kind: "skipped" };
  if ("waitUntil" in claimed) {
    return { kind: "waiting", until: claimed.waitUntil };
  }
  const generation = dependencies.broker.generation(claimed.connectionId);
  const done = async (
    status: "partial" | "failed",
    outcome: DiscoveryOutcome,
  ): Promise<DiscoveryResult> => {
    await withPgTransaction(
      dependencies.database,
      (transaction) => finish(transaction, discoveryId, status, outcome),
    );
    return { kind: "finished", status, outcome, unavailable: 0, restored: 0 };
  };
  try {
    await reconcileInstallation(dependencies, claimed.installationId, signal);
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    return await done(
      DiscoveryStatus.Partial,
      DiscoveryOutcome.DependencyUnavailable,
    );
  }
  const target = (await dependencies.database.query<ScanTarget>(
    `select connection.status as "connectionStatus",
       connection.version as "connectionVersion",
       installation.status as "installationStatus",
       installation.external_authorization_id as "installationExternalId"
       from bakery.integration_connections as connection
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1 and connection.id = $2
        and connection.archived_at is null`,
    [claimed.organizationId, claimed.connectionId],
  )).rows[0];
  if (target?.connectionStatus !== "enabled") {
    return await done(
      DiscoveryStatus.Failed,
      DiscoveryOutcome.ConnectionUnavailable,
    );
  }
  if (target.installationStatus !== "enabled") {
    return await done(
      DiscoveryStatus.Failed,
      DiscoveryOutcome.InstallationUnavailable,
    );
  }
  const scanned = await scan(
    dependencies,
    Number(target.installationExternalId),
    signal,
  );
  if ("incomplete" in scanned) {
    return await done(DiscoveryStatus.Partial, scanned.incomplete);
  }
  const written = await withPgTransaction(
    dependencies.database,
    (transaction) =>
      applyScan(
        transaction,
        claimed,
        scanned.listed,
        target.connectionVersion,
        () => dependencies.broker.isCurrent(claimed.connectionId, generation),
      ),
  );
  if (written === null) {
    return await done(
      DiscoveryStatus.Partial,
      DiscoveryOutcome.ConnectionChanged,
    );
  }
  // Availability narrows what the next token reaches: drop cached tokens.
  if (written.unavailable + written.restored > 0) {
    await dependencies.broker.editing(claimed.connectionId, async () => {});
  }
  return {
    kind: "finished",
    status: DiscoveryStatus.Completed,
    outcome: null,
    ...written,
  };
}

/**
 * Writes a complete scan, or returns null (writing nothing) when the
 * connection or installation is no longer enabled, or the connection
 * version or the broker generation moved since the scan began.
 */
async function applyScan(
  transaction: PgTransactionClient,
  claimed: ClaimedDiscovery,
  listed: ReadonlySet<number>,
  expectedVersion: number,
  isCurrent: () => boolean,
): Promise<{ unavailable: number; restored: number } | null> {
  // Installation before connection, the order reconciliation locks them in.
  const installation = (await transaction.query<{ status: string }>(
    `select status from bakery.integration_installations
      where id = $1 for update`,
    [claimed.installationId],
  )).rows[0];
  const locked = (await transaction.query<
    { status: string; installationId: string; version: number }
  >(
    `select status, installation_id as "installationId", version
       from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null
      for update`,
    [claimed.organizationId, claimed.connectionId],
  )).rows[0];
  if (
    installation?.status !== "enabled" || locked?.status !== "enabled" ||
    locked.installationId !== claimed.installationId ||
    // An edit committed by any server process moved the version; one this
    // process has in flight moved the broker generation.
    locked.version !== expectedVersion || !isCurrent()
  ) return null;
  const resources = (await transaction.query<
    {
      id: string;
      externalId: string;
      available: boolean;
      generation: number;
    }
  >(
    `select id, external_id as "externalId", available,
       last_discovery_generation as generation
       from bakery.integration_resources
      where organization_id = $1 and connection_id = $2
        and kind = 'repository' and archived_at is null
      order by id
      for update`,
    [claimed.organizationId, claimed.connectionId],
  )).rows;
  const generation =
    Math.max(0, ...resources.map((resource) => resource.generation)) + 1;
  const traceId = crypto.randomUUID();
  let unavailable = 0;
  let restored = 0;
  let matched = 0;
  for (const resource of resources) {
    const present = listed.has(Number(resource.externalId));
    if (present) matched += 1;
    if (present === resource.available) continue;
    const updated = await transaction.query<{ version: number }>(
      `update bakery.integration_resources
          set available = $3, last_discovery_generation = $4,
              version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2
        returning version`,
      [claimed.organizationId, resource.id, present, generation],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) throw new StandardError({ code: "INTERNAL" });
    if (present) restored += 1;
    else unavailable += 1;
    await appendDomainEvent(transaction, {
      organizationId: claimed.organizationId,
      eventType: RESOURCES_CHANGED,
      aggregateId: resource.id,
      aggregateVersion: version,
      payload: { resourceId: resource.id, resourceVersion: version },
      traceId,
    });
  }
  if (unavailable + restored > 0) {
    // A check holding the earlier selection fails its version recheck.
    const bumped = await transaction.query<{ version: number }>(
      `update bakery.integration_connections
          set version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2
        returning version`,
      [claimed.organizationId, claimed.connectionId],
    );
    const version = bumped.rows[0]?.version;
    if (version === undefined) throw new StandardError({ code: "INTERNAL" });
    await appendDomainEvent(transaction, {
      organizationId: claimed.organizationId,
      eventType: CONNECTION_UPDATED,
      aggregateId: claimed.connectionId,
      aggregateVersion: version,
      payload: { resourceId: claimed.connectionId, resourceVersion: version },
      traceId,
    });
  }
  await finish(transaction, claimed.id, DiscoveryStatus.Completed, null, {
    listed: matched,
    unavailable,
  });
  return { unavailable, restored };
}

/**
 * Queued or running discoveries untouched for `staleMs` (and past their
 * pacing time), oldest first, for the recovery function to send again.
 * Each is touched, so one row is re-sent at most once per `staleMs`; claim
 * and finish are idempotent.
 */
export async function staleDiscoveries(
  database: PgDatabase,
  limit = 50,
  staleMs = DISCOVERY_STALE_MS,
): Promise<{ id: string; version: number }[]> {
  const result = await database.query<{ id: string; version: number }>(
    `update bakery.integration_discoveries set updated_at = now()
      where id in (
        select id from bakery.integration_discoveries
         where status in ('queued', 'running')
           and greatest(updated_at, not_before)
             < now() - ($2::bigint * interval '1 millisecond')
         order by updated_at, id
         limit $1
         for update skip locked)
      returning id, version`,
    [limit, staleMs],
  );
  return result.rows;
}
