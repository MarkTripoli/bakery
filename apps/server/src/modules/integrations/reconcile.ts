import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { openAppSecret, readAppCredentials } from "./callbacks.ts";
import {
  CheckProblem,
  PermissionsSchema,
  probe,
  type ProbeOutcome,
  selectedRepositoryIds,
} from "./checks.ts";
import {
  createGitHubAppJwt,
  DEFAULT_RATE_LIMIT_SECONDS,
  type GitHubAppClient,
  GitHubReadFailure,
} from "./github-app.ts";
import {
  fanOutConnections,
  HEALTH_CHANGED,
  InstallationStatus,
  liveConnections,
  RECONCILE_OPERATION,
} from "./installation-fan-out.ts";
import { GITHUB_PROVIDER } from "./postgres.ts";
import type { InstallationTokenBroker } from "./token-broker.ts";

const REVALIDATE_OPERATION = "integrationConnections.revalidate";

/** What GitHub reported about the installation, read with App authority. */
export type ObservedInstallation = "active" | "suspended" | "deleted";

function isInstallationStatus(value: string): value is InstallationStatus {
  return (Object.values(InstallationStatus) as string[]).includes(value);
}

/**
 * The installation state machine. Returns the status GitHub's observation
 * moves `current` to, or null when it stays. Revoked is terminal: GitHub
 * gives a reinstall a new installation id, so a revoked row never returns.
 */
export function installationTransition(
  current: InstallationStatus,
  observed: ObservedInstallation,
): InstallationStatus | null {
  if (current === InstallationStatus.Revoked) return null;
  const next = observed === "deleted"
    ? InstallationStatus.Revoked
    : observed === "suspended"
    ? InstallationStatus.Suspended
    : InstallationStatus.Enabled;
  return next === current ? null : next;
}

export type ReconcileDependencies = {
  database: PgDatabase;
  github: GitHubAppClient;
  secretsKey?: SecretsKeyConfig;
  broker: InstallationTokenBroker;
};

export type ReconcileOutcome =
  | { kind: "unchanged"; status: InstallationStatus }
  | {
    kind: "transitioned";
    from: InstallationStatus;
    to: InstallationStatus;
    connections: number;
    /**
     * Enabled connections an unsuspend probed and recorded health for;
     * zero for every other transition.
     */
    revalidated: number;
  }
  /** Another reconcile or setup moved the row first; nothing was written. */
  | { kind: "superseded" };

type InstallationRow = {
  id: string;
  registrationId: string;
  externalAuthorizationId: string;
  externalAccountId: string;
  status: string;
  version: number;
};

async function readInstallation(
  transaction: PgTransactionClient,
  installationId: string,
  lock: boolean,
): Promise<InstallationRow | undefined> {
  const result = await transaction.query<InstallationRow>(
    `select id, registration_id as "registrationId",
       external_authorization_id as "externalAuthorizationId",
       external_account_id as "externalAccountId", status, version
       from bakery.integration_installations where id = $1
       ${lock ? "for update" : ""}`,
    [installationId],
  );
  return result.rows[0];
}

/**
 * Reads the installation's state from GitHub with App authority. A
 * registration other than the one the installation was bound through, an
 * installation id or account GitHub answers differently, or any provider
 * failure is DEPENDENCY_UNAVAILABLE: reconciliation never transitions on an
 * answer it cannot attribute.
 */
async function observe(
  dependencies: ReconcileDependencies,
  row: InstallationRow,
  credentials: NonNullable<Awaited<ReturnType<typeof readAppCredentials>>>,
  signal: AbortSignal,
): Promise<ObservedInstallation> {
  const installationId = Number(row.externalAuthorizationId);
  if (credentials.registrationId !== row.registrationId) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const key = await loadSecretKey(dependencies.secretsKey);
  let pem: string;
  try {
    pem = await openAppSecret(key, credentials.privateKey);
  } catch {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  // The PEM lives only for this signing call.
  const jwt = await createGitHubAppJwt(credentials.appId, pem);
  signal.throwIfAborted();
  const read = await dependencies.github.readInstallationState(
    { jwt, installationId },
    signal,
  );
  if (read.kind === "absent") return "deleted";
  if (
    read.installation.id !== installationId ||
    read.installation.appId !== credentials.appId ||
    String(read.installation.account.id) !== row.externalAccountId
  ) throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  return read.installation.suspended ? "suspended" : "active";
}

/**
 * Reconciles one installation row with GitHub, between committed
 * transactions (secrets/preflight.ts precedent):
 * 1. read the row and the App credentials, then GitHub's state outside any
 *    transaction;
 * 2. open a broker edit for every live connection on the installation, so
 *    from here on no token is minted or cached for the state before;
 * 3. in one transaction, lock the row and compare-and-swap on the version
 *    read in step 1; a lost race writes nothing. The transition moves the
 *    installation and fans out to its connections (status only on revoke),
 *    with events and audit. Resources are never touched, so no selection of
 *    any organization is released.
 * No transition still stamps `last_checked_at`.
 */
export async function reconcileInstallation(
  dependencies: ReconcileDependencies,
  installationId: string,
  signal: AbortSignal,
): Promise<ReconcileOutcome> {
  // Stamped first, so a reconcile that fails still yields its sweep slot.
  await dependencies.database.query(
    `update bakery.integration_installations
        set reconcile_attempted_at = now() where id = $1`,
    [installationId],
  );
  const read = await withPgTransaction(
    dependencies.database,
    async (transaction) => ({
      row: await readInstallation(transaction, installationId, false),
      credentials: await readAppCredentials(transaction),
      connections: await liveConnections(transaction, installationId, false),
    }),
  );
  if (read.row === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (read.credentials === null) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const row = read.row;
  if (!isInstallationStatus(row.status)) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const current = row.status;
  const observed = await observe(dependencies, row, read.credentials, signal);
  const next = installationTransition(current, observed);
  if (next === null) {
    const stamped = await dependencies.database.query(
      `update bakery.integration_installations set last_checked_at = now()
        where id = $1 and version = $2`,
      [row.id, row.version],
    );
    return stamped.rowCount === 1
      ? { kind: "unchanged", status: current }
      : { kind: "superseded" };
  }
  const ends = new Map<string, () => void>();
  const cover = (connectionId: string) => {
    if (!ends.has(connectionId)) {
      ends.set(connectionId, dependencies.broker.beginEdit(connectionId));
    }
  };
  for (const connection of read.connections) cover(connection.id);
  let outcome: ReconcileOutcome;
  try {
    outcome = await withPgTransaction(
      dependencies.database,
      (transaction) =>
        applyTransition(transaction, row, current, next, observed, cover),
    );
  } finally {
    for (const end of ends.values()) end();
  }
  // Unsuspend: once the edit windows closed, probe every enabled
  // connection before anything else relies on it. Disabled connections
  // stay disabled and unprobed.
  if (outcome.kind !== "transitioned" || outcome.to !== "enabled") {
    return outcome;
  }
  let revalidated = 0;
  for (const connectionId of ends.keys()) {
    if (await revalidateConnection(dependencies, connectionId, signal)) {
      revalidated += 1;
    }
  }
  return { ...outcome, revalidated };
}

type RevalidationRow = {
  organizationId: string;
  status: string;
  health: string;
  version: number;
  installationExternalId: string;
  installationStatus: string;
  grantedPermissions: unknown;
  /** Inside a rate-limit window GitHub named (`next_allowed_at`). */
  throttled: boolean;
};

/**
 * The bounded read-only check probe, run with system authority for one
 * connection after its installation was unsuspended: a token narrowed to
 * the live selection and the granted permissions, then the repository
 * listing. Records health like integrationConnections.check (compare-and-
 * swap on the version read before the probe) and returns whether it did.
 * A connection that is not enabled, selects nothing, moved meanwhile, or
 * whose probe could not complete keeps its state for the next check.
 */
export async function revalidateConnection(
  dependencies: ReconcileDependencies,
  connectionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  // Captured before the state is read: a later edit refuses the mint.
  const generation = dependencies.broker.generation(connectionId);
  const read = await withPgTransaction(
    dependencies.database,
    async (transaction) => {
      const result = await transaction.query<RevalidationRow>(
        `select connection.organization_id as "organizationId",
           connection.status, connection.health, connection.version,
           connection.external_authorization_id as "installationExternalId",
           connection.granted_permissions as "grantedPermissions",
           installation.status as "installationStatus",
           coalesce(connection.next_allowed_at > now(), false) as "throttled"
           from bakery.integration_connections as connection
           join bakery.integration_installations as installation
             on installation.id = connection.installation_id
          where connection.id = $1 and connection.archived_at is null`,
        [connectionId],
      );
      const row = result.rows[0];
      // Inside a rate-limit window GitHub named, as a check would be refused.
      if (
        row === undefined || row.status !== "enabled" ||
        row.installationStatus !== "enabled" || row.throttled
      ) return null;
      let repositoryIds: number[];
      try {
        repositoryIds = await selectedRepositoryIds(
          transaction,
          row.organizationId,
          connectionId,
        );
      } catch {
        return null;
      }
      const permissions = PermissionsSchema.safeParse(row.grantedPermissions);
      const credentials = await readAppCredentials(transaction);
      if (!permissions.success || credentials === null) return null;
      return { row, repositoryIds, permissions: permissions.data, credentials };
    },
  );
  if (read === null) return false;
  const { row } = read;
  // A provider failure: the probe did not complete. Like an incomplete
  // check, record when it ran and why, leave health as it is, and so let
  // the sweep reach other connections first. A rate limit records only the
  // wait GitHub named, as a check does.
  const incomplete = async (retryAfterSeconds: number | null) => {
    if (retryAfterSeconds !== null) {
      await dependencies.database.query(
        `update bakery.integration_connections
            set next_allowed_at = greatest(
              coalesce(next_allowed_at, $4::timestamptz), $4::timestamptz)
          where organization_id = $1 and id = $2 and version = $3`,
        [
          row.organizationId,
          connectionId,
          row.version,
          new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
        ],
      );
      return false;
    }
    await dependencies.database.query(
      `update bakery.integration_connections
          set last_checked_at = now(), last_problem_code = $4
        where organization_id = $1 and id = $2 and version = $3`,
      [
        row.organizationId,
        connectionId,
        row.version,
        CheckProblem.DependencyUnavailable,
      ],
    );
    return false;
  };
  let outcome: ProbeOutcome;
  try {
    outcome = await dependencies.broker.serialize(
      Number(row.installationExternalId),
      () =>
        probe(dependencies.github, dependencies.broker, {
          connectionId,
          generation,
          installationExternalId: row.installationExternalId,
          status: row.status,
          installationStatus: row.installationStatus,
          repositoryIds: read.repositoryIds,
          permissions: read.permissions,
          appId: read.credentials.appId,
          privateKey: read.credentials.privateKey,
        }, signal),
    );
  } catch (error) {
    if (error instanceof GitHubReadFailure) {
      return await incomplete(
        error.kind === "rate_limited"
          ? error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS
          : null,
      );
    }
    if (!(error instanceof StandardError)) throw error;
    // A refusal (the connection moved meanwhile) records nothing.
    if (error.code === "DEPENDENCY_UNAVAILABLE") return await incomplete(null);
    return false;
  }
  if (!outcome.completed) return await incomplete(null);
  // The probe's health: `auth_required` when GitHub rejected the token and
  // its one replacement. No discovery is queued here: a revalidation runs
  // with system authority, and discoveries name the Admin who asked.
  const health = outcome.health ?? (outcome.healthy ? "healthy" : "degraded");
  // A permission loss is stored only by a check, which queues its discovery
  // as it does: here no code is stored for it, so the next Admin check that
  // finds the loss requests one.
  const problem = outcome.problem === CheckProblem.PermissionLost
    ? null
    : outcome.problem;
  return await withPgTransaction(dependencies.database, async (transaction) => {
    const updated = await transaction.query<{ version: number }>(
      `update bakery.integration_connections
          set health = $4, last_checked_at = now(),
              last_success_at = case when $5 then now() else last_success_at end,
              last_problem_code = $6,
              version = case when $7 then version + 1 else version end,
              updated_at = case when $7 then now() else updated_at end
        where organization_id = $1 and id = $2 and version = $3
          and status = 'enabled'
        returning version`,
      [
        row.organizationId,
        connectionId,
        row.version,
        health,
        outcome.healthy,
        problem,
        health !== row.health,
      ],
    );
    const version = updated.rows[0]?.version;
    if (version === undefined) return false;
    const traceId = crypto.randomUUID();
    await appendAudit(transaction, {
      organizationId: row.organizationId,
      principalId: null,
      operation: REVALIDATE_OPERATION,
      resourceType: "integration_connection",
      resourceId: connectionId,
      requestId: traceId,
      traceId,
      details: {
        provider: GITHUB_PROVIDER,
        healthy: outcome.healthy,
        from: row.health,
        to: health,
        problem: outcome.problem,
      },
    });
    if (health !== row.health) {
      await appendDomainEvent(transaction, {
        organizationId: row.organizationId,
        eventType: HEALTH_CHANGED,
        aggregateId: connectionId,
        aggregateVersion: version,
        payload: { resourceId: connectionId, resourceVersion: version },
        traceId,
      });
    }
    return true;
  });
}

async function applyTransition(
  transaction: PgTransactionClient,
  row: InstallationRow,
  from: InstallationStatus,
  to: InstallationStatus,
  observed: ObservedInstallation,
  cover: (connectionId: string) => void,
): Promise<ReconcileOutcome> {
  const locked = await readInstallation(transaction, row.id, true);
  if (locked === undefined || locked.version !== row.version) {
    return { kind: "superseded" };
  }
  const moved = await transaction.query<{ version: number }>(
    `update bakery.integration_installations
        set status = $3, last_checked_at = now(), updated_at = now(),
            version = version + 1
      where id = $1 and version = $2
      returning version`,
    [row.id, row.version, to],
  );
  const installationVersion = moved.rows[0]?.version;
  if (installationVersion === undefined) return { kind: "superseded" };
  // A connection bound since the first read is fanned out and covered by a
  // broker edit too, before its row changes.
  const traceId = crypto.randomUUID();
  const connections = await fanOutConnections(
    transaction,
    row.id,
    from,
    to,
    traceId,
    { cover },
  );
  await appendAudit(transaction, {
    organizationId: null,
    principalId: null,
    operation: RECONCILE_OPERATION,
    resourceType: "integration_installation",
    resourceId: row.id,
    requestId: traceId,
    traceId,
    details: { provider: GITHUB_PROVIDER, observed, from, to, connections },
  });
  return {
    kind: "transitioned",
    from,
    to,
    connections,
    revalidated: 0,
  };
}

/** Installations reconciled per sweep run. */
export const RECONCILE_BATCH = 25;
/** An installation is due again this long after its last reconcile. */
export const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * Up to `limit` non-revoked installations whose reconcile was not attempted
 * within `intervalMs`, the longest-unattempted first. A failed attempt
 * counts, so failing installations never hold the batch.
 */
export async function dueInstallations(
  database: PgDatabase,
  limit = RECONCILE_BATCH,
  intervalMs = RECONCILE_INTERVAL_MS,
): Promise<string[]> {
  const result = await database.query<{ id: string }>(
    `select id from bakery.integration_installations
      where status <> 'revoked'
        and (reconcile_attempted_at is null
          or reconcile_attempted_at
            < now() - ($2::bigint * interval '1 millisecond'))
      order by reconcile_attempted_at asc nulls first, id
      limit $1`,
    [limit, intervalMs],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Up to `limit` enabled connections on enabled installations whose health
 * is still `unknown` and that were not probed within `intervalMs`, the
 * longest-unprobed first: an unsuspend whose revalidation probe failed or
 * never ran is probed again by the sweep, and one that keeps failing
 * yields its place. A connection inside a rate-limit window GitHub named
 * waits until it ends.
 */
export async function connectionsAwaitingRevalidation(
  database: PgDatabase,
  limit = RECONCILE_BATCH,
  intervalMs = RECONCILE_INTERVAL_MS,
): Promise<string[]> {
  const result = await database.query<{ id: string }>(
    `select connection.id from bakery.integration_connections as connection
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
      where connection.status = 'enabled' and connection.health = 'unknown'
        and connection.archived_at is null and installation.status = 'enabled'
        and (connection.next_allowed_at is null
          or connection.next_allowed_at <= now())
        and (connection.last_checked_at is null
          or connection.last_checked_at
            < now() - ($2::bigint * interval '1 millisecond'))
      order by connection.last_checked_at asc nulls first, connection.id
      limit $1`,
    [limit, intervalMs],
  );
  return result.rows.map((row) => row.id);
}
