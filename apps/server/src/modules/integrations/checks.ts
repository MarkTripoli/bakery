import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  createNormalizedCommandMetadata,
  StandardError,
  toProblem,
} from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { organizationActor } from "./auth-attempts.ts";
import { type AppCredentials, readAppCredentials } from "./callbacks.ts";
import {
  DEFAULT_RATE_LIMIT_SECONDS,
  GITHUB_MAX_TOKEN_REPOSITORIES,
  GITHUB_REPOSITORIES_PER_PAGE,
  type GitHubAppClient,
  type GitHubPermissions,
  GitHubReadFailure,
} from "./github-app.ts";

import { boundRetryAfterSeconds } from "../../platform/retry-after.ts";
import { queueDiscovery } from "./discovery-queue.ts";
import { GITHUB_PROVIDER, type IntegrationsDependencies } from "./postgres.ts";
import {
  connectionNotEnabled,
  installationNotEnabled,
  type InstallationTokenBroker,
} from "./token-broker.ts";

type ConnectionCheck = z.output<typeof contractSchemas.ConnectionCheck>;

const HEALTH_CHANGED = "integration.health_changed";

/** Safe, enumerated outcome codes stored as the connection's last problem. */
export const CheckProblem = Object.freeze(
  {
    TokenRefused: "token_refused",
    /** GitHub rejected the token and its one replacement (401). */
    TokenRejected: "token_rejected",
    RepositoryMissing: "repository_missing",
    PermissionMissing: "permission_missing",
    /** GitHub refused the token's read for want of permission (403). */
    PermissionLost: "permission_lost",
    DependencyUnavailable: "dependency_unavailable",
  } as const,
);
export type CheckProblem = (typeof CheckProblem)[keyof typeof CheckProblem];

export const PermissionsSchema = z.record(
  z.string().min(1).max(64).describe("GitHub App permission scope name."),
  z.enum(["read", "write", "admin"]).describe(
    "GitHub App permission level for one scope.",
  ),
).describe("Permissions the connection was granted at bind.");

type CheckedConnection = {
  id: string;
  status: string;
  health: string;
  version: number;
  nextAllowedAt: Date | null;
  lastProblemCode: string | null;
  installationId: string;
  installationExternalId: string;
  installationStatus: string;
  grantedPermissions: unknown;
};

/** The router validated the path; parse it again so no unchecked value is used. */
function connectionPath(context: ActionContext): string {
  const parsed = contractSchemas.IdPath.safeParse({ id: context.params.id });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

/**
 * The caller's live connection and its installation. Another organization's,
 * an archived or an unknown connection is RESOURCE_NOT_FOUND; a connection
 * that is not enabled, or whose installation is not active, is 409.
 */
async function readCheckedConnection(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
  lock: boolean,
): Promise<CheckedConnection> {
  const result = await transaction.query<CheckedConnection>(
    `select connection.id, connection.status, connection.health,
       connection.version, connection.next_allowed_at as "nextAllowedAt",
       connection.last_problem_code as "lastProblemCode",
       connection.installation_id as "installationId",
       connection.external_authorization_id as "installationExternalId",
       connection.granted_permissions as "grantedPermissions",
       installation.status as "installationStatus"
       from bakery.integration_connections as connection
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1 and connection.id = $2
        and connection.archived_at is null
      ${lock ? "for update of connection" : ""}`,
    [organizationId, connectionId],
  );
  const connection = result.rows[0];
  if (connection === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (connection.status !== "enabled") {
    throw connectionNotEnabled(connection.status);
  }
  if (connection.installationStatus !== "enabled") {
    throw installationNotEnabled();
  }
  return connection;
}

/** 429 carrying how long GitHub asked this caller to wait, 1..3600 s. */
function quotaExceeded(retryAfterSeconds: number): StandardError {
  return new StandardError({
    code: "PROVIDER_QUOTA_EXCEEDED",
    params: { retryAfterSeconds: boundRetryAfterSeconds(retryAfterSeconds) },
  });
}

/**
 * Refuses, before any key is opened or GitHub is called, a connection whose
 * recorded provider rate limit has not yet run out.
 */
function assertWithinQuota(connection: CheckedConnection): void {
  const waitMs = (connection.nextAllowedAt?.getTime() ?? 0) - Date.now();
  if (waitMs > 0) throw quotaExceeded(waitMs / 1000);
}

/** Stable ids of the connection's live, available selected repositories. */
export async function selectedRepositoryIds(
  transaction: PgTransactionClient,
  organizationId: string,
  connectionId: string,
): Promise<number[]> {
  const result = await transaction.query<{ externalId: string }>(
    `select external_id as "externalId" from bakery.integration_resources
      where organization_id = $1 and connection_id = $2 and kind = 'repository'
        and selected and available and archived_at is null
      order by external_id`,
    [organizationId, connectionId],
  );
  const ids = result.rows.map((row) => Number(row.externalId));
  if (ids.length === 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "no_selected_resource" },
    });
  }
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new StandardError({ code: "INTERNAL" });
  }
  // GitHub narrows one installation token to at most 500 repositories.
  if (ids.length > GITHUB_MAX_TOKEN_REPOSITORIES) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "selection_too_large" },
    });
  }
  return ids;
}

/** The connection was edited while the check ran; retrying reads the new state. */
const connectionChanged = () =>
  new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "connection_changed" },
  });

const resultSlot = Symbol("private connection check result");

/**
 * Request-private outcome of the provider probe, handed to the mutation. It
 * carries no token: only what the probe concluded and the connection state
 * it was run against.
 */
const CheckResultSchema = z.object({
  principalId: z.string().uuid().describe(
    "Principal whose request ran the probe.",
  ),
  connectionId: z.string().uuid().describe("Connection the probe checked."),
  expectedVersion: z.number().int().positive().describe(
    "Connection version the probe read; the mutation refuses any other.",
  ),
  installationExternalId: z.string().min(1).describe(
    "GitHub installation id the probe minted its token for.",
  ),
  healthy: z.boolean().describe("Whether the probe completed and passed."),
  completed: z.boolean().describe(
    "Whether the probe completed; an incomplete probe leaves health unchanged.",
  ),
  health: z.enum(["healthy", "degraded", "auth_required"]).nullable()
    .describe(
      "Health the completed probe proved, or null when it did not complete.",
    ),
  discovery: z.boolean().describe(
    "Whether GitHub refused a read for want of permission, so discovery must recheck the selection.",
  ),
  problem: z.enum([
    CheckProblem.TokenRefused,
    CheckProblem.TokenRejected,
    CheckProblem.RepositoryMissing,
    CheckProblem.PermissionMissing,
    CheckProblem.PermissionLost,
    CheckProblem.DependencyUnavailable,
  ]).nullable().describe("Safe outcome code, or null when healthy."),
  capabilities: z.array(
    z.string().min(1).max(80).describe(
      "One `<permission>:<level>` GitHub granted.",
    ),
  ).max(100).describe("Permissions GitHub granted the narrowed token."),
  checkedAt: z.string().datetime().describe("Time the probe finished."),
  fault: z.unknown().describe(
    "Redacted problem when the probe could not complete, else null.",
  ),
  expires: z.number().int().positive().describe(
    "Unix milliseconds after which the result no longer counts; 30 seconds.",
  ),
}).strict().describe(
  "Request-local connection check result; never an input, grant or replay payload.",
);
type CheckResult = z.infer<typeof CheckResultSchema>;
type CheckedContext = ActionContext & { [resultSlot]?: CheckResult };

/**
 * integrationConnections.check: records what the probe the runner attached
 * found. Health moves only here and never changes the lifecycle status;
 * integration.health_changed and the connection version move only when
 * health does. A permission loss newly seen queues a discovery requested by
 * the checking Admin, as integrationDiscoveries.create would. The connection
 * must still be enabled and at the version the probe read, so a result for
 * a previous selection or state is never stored.
 */
export async function checkConnection(
  context: ActionContext,
): Promise<ConnectionCheck> {
  const { context: value, actor } = organizationActor(context);
  const id = connectionPath(value);
  const result = (context as CheckedContext)[resultSlot];
  const { transaction } = value;
  // A permission loss queues a discovery, whose row references the
  // installation: lock the installation before the connection, the order
  // reconciliation and integrationDiscoveries.create take them in.
  if (result?.discovery === true) {
    await transaction.query(
      `select 1 from bakery.integration_installations as installation
         join bakery.integration_connections as connection
           on connection.installation_id = installation.id
        where connection.organization_id = $1 and connection.id = $2
        for update of installation`,
      [actor.organizationId, id],
    );
  }
  const current = await readCheckedConnection(
    transaction,
    actor.organizationId,
    id,
    true,
  );
  if (
    result === undefined || result.principalId !== actor.subject.principalId ||
    result.connectionId !== id
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  // A result held past 30 s (a long row-lock wait) may be stale: retry.
  if (result.expires < Date.now()) throw connectionChanged();
  if (
    current.version !== result.expectedVersion ||
    current.installationExternalId !== result.installationExternalId
  ) throw connectionChanged();
  const health = result.health ?? current.health;
  // A probe that could not complete proves nothing about a recorded
  // permission loss: it stays recorded, so the next 403 does not request
  // discovery a second time for the same loss.
  const lost = current.lastProblemCode === CheckProblem.PermissionLost;
  const problem = !result.completed && lost
    ? CheckProblem.PermissionLost
    : result.problem;
  // Only a check stores permission_lost, and it queues a discovery when it
  // does, so a stored loss is already requested.
  const discovery = result.discovery && !lost;
  const moved = health !== current.health;
  const updated = await transaction.query<{ version: number }>(
    `update bakery.integration_connections
        set health = $4, last_checked_at = $5::timestamptz,
            last_success_at = case when $6 then $5::timestamptz
              else last_success_at end,
            last_problem_code = $7,
            version = case when $8 then version + 1 else version end,
            updated_at = case when $8 then now() else updated_at end
      where organization_id = $1 and id = $2 and version = $3
      returning version`,
    [
      actor.organizationId,
      id,
      current.version,
      health,
      result.checkedAt,
      result.healthy,
      problem,
      moved,
    ],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  // An active scan of the connection answers the loss instead.
  const queued = discovery &&
    (await queueDiscovery(transaction, {
      organizationId: actor.organizationId,
      connectionId: id,
      installationId: current.installationId,
      principalId: actor.subject.principalId,
      traceId: value.traceId,
    })).queued;
  await recordAuthAudit(transaction, value, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationConnectionsCheck,
    resourceType: "integration_connection",
    resourceId: id,
    details: {
      provider: GITHUB_PROVIDER,
      healthy: result.healthy,
      from: current.health,
      to: health,
      // What this probe found, even when the stored problem was kept.
      problem: result.problem,
      discovery: queued,
    },
  });
  if (health !== current.health) {
    await appendDomainEvent(transaction, {
      organizationId: actor.organizationId,
      eventType: HEALTH_CHANGED,
      aggregateId: id,
      aggregateVersion: version,
      payload: { resourceId: id, resourceVersion: version },
      traceId: value.traceId,
    });
  }
  return contractSchemas.ConnectionCheck.parse({
    health,
    healthy: result.healthy,
    checkedAt: result.checkedAt,
    capabilities: result.capabilities,
    fault: result.fault,
  });
}

export type CheckTarget = {
  principalId: string;
  connectionId: string;
  generation: number;
  expectedVersion: number;
  installationExternalId: string;
  status: string;
  installationStatus: string;
  repositoryIds: number[];
  permissions: GitHubPermissions;
  appId: number;
  privateKey: AppCredentials["privateKey"];
};

export type ProbeOutcome = {
  completed: boolean;
  healthy: boolean;
  health: "healthy" | "degraded" | "auth_required" | null;
  discovery: boolean;
  problem: CheckProblem | null;
  capabilities: string[];
};

/** A completed probe that proved the connection unhealthy. */
const unhealthy = (
  problem: CheckProblem,
  capabilities: string[],
  health: "degraded" | "auth_required" = "degraded",
): ProbeOutcome => ({
  completed: true,
  healthy: false,
  health,
  discovery: problem === CheckProblem.PermissionLost,
  problem,
  capabilities,
});

/**
 * Pages `GET /installation/repositories` with one token, reading at most
 * `maxPages`; `complete` when GitHub named no further page.
 */
async function listReached(
  github: GitHubAppClient,
  token: string,
  maxPages: number,
  signal: AbortSignal,
): Promise<{ listed: Set<number>; complete: boolean }> {
  const listed = new Set<number>();
  for (let page = 1; page <= maxPages; page++) {
    const result = await github.listInstallationRepositories(
      token,
      page,
      signal,
    );
    for (const id of result.repositoryIds) listed.add(id);
    if (!result.hasNext) return { listed, complete: true };
  }
  return { listed, complete: false };
}

/**
 * The bounded read-only probe: one narrowed token, then at most enough
 * `GET /installation/repositories` pages to list the selection plus one.
 * Healthy when GitHub granted every requested permission and the token
 * reaches exactly the selected repositories. GitHub rejecting the token
 * (401) drops it and mints exactly one replacement; a rejected replacement
 * proves `auth_required`. A read GitHub forbids (403 without a rate limit)
 * proves the permission lost. A rate limit or timeout throws its
 * GitHubReadFailure to the runner.
 */
export async function probe(
  github: GitHubAppClient,
  broker: InstallationTokenBroker,
  target: Omit<CheckTarget, "principalId" | "expectedVersion">,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const maxPages =
    Math.ceil(target.repositoryIds.length / GITHUB_REPOSITORIES_PER_PAGE) + 1;
  for (let attempt = 1;; attempt++) {
    const minted = await broker.token(
      {
        connectionId: target.connectionId,
        generation: target.generation,
        status: target.status,
        installationStatus: target.installationStatus,
        appId: target.appId,
        privateKey: target.privateKey,
        installationId: Number(target.installationExternalId),
        repositoryIds: target.repositoryIds,
        permissions: target.permissions,
      },
      signal,
    );
    // An edit that committed while GitHub was minting: the token never
    // reaches GitHub again for this check.
    if (!broker.isCurrent(target.connectionId, target.generation)) {
      throw connectionChanged();
    }
    if (minted.kind === "refused") {
      return unhealthy(CheckProblem.TokenRefused, []);
    }
    const capabilities = Object.entries(minted.permissions)
      .map(([scope, level]) => `${scope}:${level}`).sort().slice(0, 100);
    const permitted = Object.entries(target.permissions).every((
      [scope, level],
    ) => minted.permissions[scope] === level);
    let reach: { listed: Set<number>; complete: boolean };
    try {
      reach = await listReached(github, minted.token, maxPages, signal);
    } catch (error) {
      // A client that went away says nothing about the token, and a rate
      // limit or timeout says nothing against it: it stays cached. Any
      // other failure (rejected, forbidden, outage) drops it, so the next
      // mint is fresh rather than a reuse of a revoked or dead token.
      const kept = signal.aborted ||
        (error instanceof GitHubReadFailure &&
          (error.kind === "rate_limited" || error.kind === "timeout"));
      if (!kept) broker.forget(target.connectionId, minted.token);
      if (error instanceof GitHubReadFailure && !signal.aborted) {
        // One replacement, never a loop: the second rejection is final.
        if (error.kind === "rejected" && attempt === 1) continue;
        if (error.kind === "rejected") {
          return unhealthy(CheckProblem.TokenRejected, [], "auth_required");
        }
        if (error.kind === "forbidden") {
          return unhealthy(CheckProblem.PermissionLost, capabilities);
        }
      }
      throw error;
    }
    const reached = reach.complete &&
      reach.listed.size === target.repositoryIds.length &&
      target.repositoryIds.every((id) => reach.listed.has(id));
    if (!reached) {
      return unhealthy(CheckProblem.RepositoryMissing, capabilities);
    }
    if (!permitted) {
      return unhealthy(CheckProblem.PermissionMissing, capabilities);
    }
    return {
      completed: true,
      healthy: true,
      health: "healthy",
      discovery: false,
      problem: null,
      capabilities,
    };
  }
}

/**
 * Wraps integrationConnections.check so GitHub is asked between committed
 * transactions (secrets/preflight.ts precedent):
 * 1. a probe transaction, under the live Admin check, answers a replay from
 *    its stored response and refuses an unknown connection (404) or one that
 *    is not enabled, has an inactive installation or selects nothing (409),
 *    or whose recorded provider rate limit has not run out (429), before any
 *    key is decrypted or GitHub is called;
 * 2. outside any transaction, and one check at a time per installation, the
 *    broker mints (or reuses) a token narrowed to the live selection and the
 *    granted permissions, and the probe reads with it; a provider outage
 *    becomes a redacted fault, never the provider's answer, a rate limit
 *    records `next_allowed_at` and answers 429 PROVIDER_QUOTA_EXCEEDED, and
 *    a provider timeout answers 504 DEPENDENCY_TIMEOUT, both leaving health
 *    unchanged;
 * 3. the result is stored through `next`, which rechecks the Admin, the
 *    status and the version under the row lock.
 */
export function createConnectionCheckRunner(
  authority: ActionAuthorityRunner,
  dependencies: IntegrationsDependencies & { github: GitHubAppClient },
  broker: InstallationTokenBroker,
): ActionAuthorityRunner["run"] {
  return async (action, context, input, next) => {
    const parsed = contractSchemas.Empty.parse(input);
    const metadata = createNormalizedCommandMetadata(
      action,
      context.request,
      context.params,
      parsed,
    );
    // Captured before the status is read: an edit that commits after this
    // point moves it, and the broker then refuses to mint.
    const generation = broker.generation(connectionPath(context));
    const read = await authority.run(
      action,
      context,
      parsed,
      async (authorized) => {
        const replay = await readCompletedCommandReplay({
          context: authorized,
          metadata,
          input: parsed,
        });
        if (replay) {
          return { replay: validateEncodedSuccessResponse(action, replay) };
        }
        const { context: value, actor } = organizationActor(authorized);
        const connectionId = connectionPath(value);
        const connection = await readCheckedConnection(
          value.transaction,
          actor.organizationId,
          connectionId,
          false,
        );
        assertWithinQuota(connection);
        const repositoryIds = await selectedRepositoryIds(
          value.transaction,
          actor.organizationId,
          connectionId,
        );
        const permissions = PermissionsSchema.safeParse(
          connection.grantedPermissions,
        );
        if (!permissions.success) {
          throw new StandardError({ code: "INTERNAL" });
        }
        const credentials = await readAppCredentials(value.transaction);
        if (credentials === null) {
          throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
        }
        return {
          target: {
            principalId: actor.subject.principalId,
            connectionId,
            generation,
            expectedVersion: connection.version,
            installationExternalId: connection.installationExternalId,
            status: connection.status,
            installationStatus: connection.installationStatus,
            repositoryIds,
            permissions: permissions.data,
            appId: credentials.appId,
            privateKey: credentials.privateKey,
          } satisfies CheckTarget,
        };
      },
    ) as
      | { replay: ReturnType<typeof validateEncodedSuccessResponse> }
      | { target: CheckTarget };
    if ("replay" in read) return read.replay;
    const { target } = read;
    context.signal.throwIfAborted();
    const installationId = Number(target.installationExternalId);
    const outcome = await broker.serialize(installationId, async () => {
      // Re-read just before the mint, after any queued check settled: an
      // edit committed since the first read, by this or another server
      // process, refuses the mint, and so does a rate limit a check ahead
      // in the queue just recorded.
      await authority.run(action, context, parsed, async (authorized) => {
        const { context: value, actor } = organizationActor(authorized);
        const current = await readCheckedConnection(
          value.transaction,
          actor.organizationId,
          target.connectionId,
          false,
        );
        if (
          current.version !== target.expectedVersion ||
          current.installationExternalId !== target.installationExternalId
        ) throw connectionChanged();
        assertWithinQuota(current);
      });
      try {
        return {
          ...await probe(dependencies.github, broker, target, context.signal),
          fault: null,
        };
      } catch (caught) {
        // A client that went away records nothing: the abort is not a
        // provider failure.
        context.signal.throwIfAborted();
        let error = caught;
        if (error instanceof GitHubReadFailure) {
          if (error.kind === "rate_limited") {
            // Recorded before this installation's queue moves on, so a
            // check waiting behind this one is refused without calling
            // GitHub. Only the wait is written: health, version and events
            // stay as they are. The write commits; the 429 follows it.
            const seconds = error.retryAfterSeconds ??
              DEFAULT_RATE_LIMIT_SECONDS;
            await authority.run(action, context, parsed, async (authorized) => {
              const { context: value, actor } = organizationActor(authorized);
              await value.transaction.query(
                `update bakery.integration_connections
                    set next_allowed_at = greatest(
                      coalesce(next_allowed_at, $3::timestamptz),
                      $3::timestamptz)
                  where organization_id = $1 and id = $2
                    and archived_at is null`,
                [
                  actor.organizationId,
                  target.connectionId,
                  new Date(Date.now() + seconds * 1000).toISOString(),
                ],
              );
            });
            throw quotaExceeded(seconds);
          }
          if (error.kind === "timeout") {
            throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
          }
          // Any other classified failure the probe did not settle is an
          // outage like the rest.
          error = new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
        }
        // Refusals of our own (409) surface; provider failures become a
        // redacted fault and leave health unchanged.
        if (
          !(error instanceof StandardError) ||
          error.code !== "DEPENDENCY_UNAVAILABLE"
        ) throw error;
        return {
          completed: false,
          healthy: false,
          health: null,
          discovery: false,
          problem: CheckProblem.DependencyUnavailable,
          capabilities: [],
          fault: toProblem(error, {
            requestId: context.requestId,
            traceId: context.traceId,
            publicBaseUrl: dependencies.publicBaseUrl,
          }),
        };
      }
    });
    const result = CheckResultSchema.parse({
      principalId: target.principalId,
      connectionId: target.connectionId,
      expectedVersion: target.expectedVersion,
      installationExternalId: target.installationExternalId,
      ...outcome,
      checkedAt: new Date().toISOString(),
      expires: Date.now() + 30_000,
    });
    return await authority.run(
      action,
      context,
      parsed,
      (authorized) =>
        next(Object.assign({}, authorized, { [resultSlot]: result })),
    );
  };
}
