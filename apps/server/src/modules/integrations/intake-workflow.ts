import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { type AppCredentials, readAppCredentials } from "./callbacks.ts";
import { queueDiscovery } from "./discovery-queue.ts";
import {
  authorityDeniedAtWrite,
  authorityVerdict,
  checkRunFactOf,
  forgetFailedToken,
  installationNotEnabled,
  issueFactOf,
  MAX_CHECK_PAGES,
  mintReadToken,
  RouteOutcomeCode,
  subjectOf,
} from "./fact-reads.ts";
import { DEFAULT_RATE_LIMIT_SECONDS, GitHubReadFailure } from "./github-app.ts";
import { InstallationStatus } from "./installation-fan-out.ts";
import {
  type IntakeProjection,
  IntakeProjectionSchema,
  type IntakeRoutePurpose,
} from "./intake-events.ts";
import { INTAKE_RECEIVED_EVENT, RouteStatus } from "./intake-receipts.ts";
import {
  findTrackedPullRequest,
  observePullRequest,
  resolveRepositoryId,
} from "./pull-requests.ts";
import {
  type ReconcileDependencies,
  reconcileInstallation,
} from "./reconcile.ts";
import {
  type FactWriteResult,
  markGone,
  type RemoteFact,
  RemoteFactKind,
  upsertFact,
} from "./remote-facts.ts";

/**
 * Route processor.
 *
 * A route is one connection's share of a verified delivery. The processor
 * claims it, rechecks the live authority of the installation, connection and
 * resource it names, and only then acts, and never from the payload: a
 * lifecycle event runs the existing reconcile, a repository event queues the
 * existing discovery, and an issue, pull request or check event re-reads the
 * object from GitHub and stores that read through the ordered stores. A
 * delayed, reordered or forged delivery can therefore point the processor at
 * an object but never decide what is true about it. Nothing here admits a
 * ticket, runs a check or writes to GitHub.
 */

/** A route stops after this many claims; the next claim settles it `failed`. */
export const MAX_ROUTE_ATTEMPTS = 10;
/** A `processing` route is taken over this long after its claim. */
export const PROCESSING_STALE_MS = 10 * 60_000;
/** First step of the retry back-off, in seconds. */
export const RETRY_BASE_SECONDS = 30;
/** Longest wait between two attempts, in seconds. */
export const RETRY_MAX_SECONDS = 3600;
/** A `pending` route is left to the outbox this long before recovery resends it. */
export const PENDING_GRACE_MS = 60_000;
/** Routes the recovery resends in one run. */
export const RECOVERY_BATCH = 100;

/**
 * Seconds to wait before the next attempt of a route whose `attempts`-th
 * claim failed for a reason other than a rate limit: `30 * 2^attempts`,
 * never more than an hour.
 */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Number.isFinite(attempts)
    ? Math.min(Math.max(0, Math.trunc(attempts)), 20)
    : 0;
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** exponent);
}

/** Statuses a processing attempt can settle a route in. */
type SettledStatus =
  | typeof RouteStatus.Completed
  | typeof RouteStatus.Ignored
  | typeof RouteStatus.Deferred
  | typeof RouteStatus.Failed;

/** Why a call took no action on a route. */
export type SkipReason =
  | "not_found"
  | "terminal"
  | "not_due"
  | "in_progress"
  | "superseded";

/** Fact writes one route made; check routes write several. */
export type FactTally = {
  written: number;
  unchanged: number;
  stale: number;
  /** Check runs left out: no time to order them by, or another commit. */
  skipped: number;
};

export type RouteOutcome =
  | { kind: "skipped"; reason: SkipReason }
  | {
    kind: SettledStatus;
    code: string;
    /** ISO time a deferred route may run again; null for every other status. */
    notBefore: string | null;
    tally: FactTally | null;
  };

/** A route as its processor sees it after the claim. */
export type RouteClaim = {
  routeId: string;
  organizationId: string;
  connectionId: string;
  installationId: string;
  resourceId: string | null;
  purpose: IntakeRoutePurpose;
  inboundEventId: string;
  eventKind: string;
  /** Claims including this one. */
  attempts: number;
  /** Route version after the claim; the settle only applies to it. */
  version: number;
  /** The receipt's bounded projection, a hint to where to look; null when unreadable. */
  projection: IntakeProjection | null;
};

type ClaimResult =
  | { kind: "claimed"; claim: RouteClaim }
  | { kind: "ended"; outcome: RouteOutcome };

type ClaimRow = {
  id: string;
  organizationId: string;
  connectionId: string;
  installationId: string;
  resourceId: string | null;
  purpose: string;
  status: string;
  attempts: number;
  version: number;
  due: boolean;
  stale: boolean;
  inboundEventId: string;
  eventKind: string;
  projection: unknown;
};

const ended = (outcome: RouteOutcome): ClaimResult => ({
  kind: "ended",
  outcome,
});

const settledOutcome = (
  kind: SettledStatus,
  code: string,
  notBefore: Date | null = null,
  tally: FactTally | null = null,
): RouteOutcome => ({
  kind,
  code,
  notBefore: notBefore === null ? null : notBefore.toISOString(),
  tally,
});

function isRoutePurpose(value: string): value is IntakeRoutePurpose {
  return value === "installation_reconcile" || value === "discovery" ||
    value === "fact_refresh";
}

/**
 * Takes the route under its row lock. A terminal route, a deferred route not
 * yet due and a route another worker holds fresh are skipped; a route already
 * claimed `MAX_ROUTE_ATTEMPTS` times is settled `failed(max_attempts)`; any
 * other is moved to `processing` with one more attempt. The route id is the
 * only input: every later query takes its organization from the claimed row.
 */
async function claimRoute(
  database: PgDatabase,
  routeId: string,
): Promise<ClaimResult> {
  return await withPgTransaction(database, async (transaction) => {
    const found = await transaction.query<ClaimRow>(
      `select route.id, route.organization_id as "organizationId",
         route.connection_id as "connectionId",
         route.installation_id as "installationId",
         route.resource_id as "resourceId", route.purpose, route.status,
         route.attempts, route.version, route.not_before <= now() as due,
         route.updated_at <= now() - ($2::bigint * interval '1 millisecond')
           as stale,
         route.inbound_event_id as "inboundEventId",
         event.event_kind as "eventKind",
         event.normalized_projection as projection
       from bakery.inbound_event_routes as route
       join bakery.inbound_events as event on event.id = route.inbound_event_id
       where route.id = $1
       for update of route`,
      [routeId, PROCESSING_STALE_MS],
    );
    const row = found.rows[0];
    if (row === undefined) {
      return ended({ kind: "skipped", reason: "not_found" });
    }
    switch (row.status) {
      case RouteStatus.Pending:
        break;
      case RouteStatus.Deferred:
        if (!row.due) return ended({ kind: "skipped", reason: "not_due" });
        break;
      case RouteStatus.Processing:
        if (!row.stale) {
          return ended({ kind: "skipped", reason: "in_progress" });
        }
        break;
      default:
        return ended({ kind: "skipped", reason: "terminal" });
    }
    if (row.attempts >= MAX_ROUTE_ATTEMPTS) {
      await transaction.query(
        `update bakery.inbound_event_routes
            set status = $3, outcome_code = $4, updated_at = now(),
                version = version + 1
          where organization_id = $1 and id = $2`,
        [
          row.organizationId,
          row.id,
          RouteStatus.Failed,
          RouteOutcomeCode.MaxAttempts,
        ],
      );
      return ended(
        settledOutcome(RouteStatus.Failed, RouteOutcomeCode.MaxAttempts),
      );
    }
    if (!isRoutePurpose(row.purpose)) {
      await transaction.query(
        `update bakery.inbound_event_routes
            set status = $3, outcome_code = $4, updated_at = now(),
                version = version + 1
          where organization_id = $1 and id = $2`,
        [
          row.organizationId,
          row.id,
          RouteStatus.Ignored,
          RouteOutcomeCode.UnsupportedEvent,
        ],
      );
      return ended(
        settledOutcome(RouteStatus.Ignored, RouteOutcomeCode.UnsupportedEvent),
      );
    }
    const claimed = await transaction.query<{ version: number }>(
      `update bakery.inbound_event_routes
          set status = $3, attempts = attempts + 1, updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2
        returning version`,
      [row.organizationId, row.id, RouteStatus.Processing],
    );
    const projection = IntakeProjectionSchema.safeParse(row.projection);
    return {
      kind: "claimed",
      claim: {
        routeId: row.id,
        organizationId: row.organizationId,
        connectionId: row.connectionId,
        installationId: row.installationId,
        resourceId: row.resourceId,
        purpose: row.purpose,
        inboundEventId: row.inboundEventId,
        eventKind: row.eventKind,
        attempts: row.attempts + 1,
        version: claimed.rows[0].version,
        projection: projection.success ? projection.data : null,
      },
    };
  });
}

/** What the processor reads again, from Bakery's own rows, before it acts. */
export type RouteAuthority = {
  connection: {
    status: string;
    installationId: string;
  } | null;
  installation: {
    status: string;
    externalId: string;
    registrationId: string;
    /** Reconciled at or after the receipt arrived, so a reconcile adds nothing. */
    alreadyCurrent: boolean;
  } | null;
  resource: {
    externalId: string;
    displayName: string;
    selected: boolean;
    available: boolean;
  } | null;
  /** The registered App's credentials; read only for routes that call GitHub. */
  credentials: AppCredentials | null;
  /** Broker generation captured before this state was read. */
  generation: number;
  /** Whether a pull request or check event names a pull request a task registered. */
  tracked: boolean;
  /** The Bakery repository of the resource, for routes about pull requests. */
  repositoryId: string | null;
};

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Reads the live state a route is rechecked against, in one read-only
 * transaction. The broker generation is captured first, so an edit of the
 * connection that commits afterwards refuses the token mint.
 */
async function loadAuthority(
  dependencies: ReconcileDependencies,
  claim: RouteClaim,
): Promise<RouteAuthority> {
  const generation = dependencies.broker.generation(claim.connectionId);
  return await withPgTransaction(dependencies.database, async (transaction) => {
    const connection = (await transaction.query<{
      status: string;
      installationId: string;
    }>(
      `select status, installation_id as "installationId"
         from bakery.integration_connections
        where organization_id = $1 and id = $2 and archived_at is null`,
      [claim.organizationId, claim.connectionId],
    )).rows[0] ?? null;
    const installation = (await transaction.query<{
      status: string;
      externalId: string;
      registrationId: string;
      alreadyCurrent: boolean;
    }>(
      `select installation.status,
         installation.external_authorization_id as "externalId",
         installation.registration_id as "registrationId",
         coalesce(installation.last_checked_at >= (
           select received_at from bakery.inbound_events where id = $2
         ), false) as "alreadyCurrent"
         from bakery.integration_installations as installation
        where installation.id = $1`,
      [claim.installationId, claim.inboundEventId],
    )).rows[0] ?? null;
    const resource = claim.resourceId === null
      ? null
      : (await transaction.query<
        {
          externalId: string;
          displayName: string;
          selected: boolean;
          available: boolean;
        }
      >(
        `select external_id as "externalId", display_name as "displayName",
         selected, available
         from bakery.integration_resources
        where organization_id = $1 and connection_id = $2 and id = $3
          and kind = 'repository' and archived_at is null`,
        [claim.organizationId, claim.connectionId, claim.resourceId],
      )).rows[0] ?? null;
    const subject = claim.purpose === "fact_refresh"
      ? subjectOf(claim.eventKind)
      : null;
    let repositoryId: string | null = null;
    let tracked = false;
    if (resource !== null && subject !== null && subject !== "issue") {
      repositoryId = await resolveRepositoryId(transaction, {
        organizationId: claim.organizationId,
        connectionId: claim.connectionId,
        externalId: resource.externalId,
        displayName: resource.displayName,
      });
      // A lookup needs a number (pull request) or a full SHA (check); a
      // projection that holds neither tracks nothing.
      const number = claim.projection?.number ?? undefined;
      const headSha = claim.projection?.headSha ?? undefined;
      const lookup = subject === "pull_request"
        ? number === undefined ? null : { number }
        : headSha === undefined || !FULL_SHA.test(headSha)
        ? null
        : { headSha };
      tracked = repositoryId !== null && lookup !== null &&
        await findTrackedPullRequest(transaction, {
            organizationId: claim.organizationId,
            repositoryId,
            ...lookup,
          }) !== null;
    }
    return {
      connection,
      installation,
      resource,
      credentials: subject === null
        ? null
        : await readAppCredentials(transaction),
      generation,
      tracked,
      repositoryId,
    };
  });
}

/** What one attempt decided; `within` runs inside the settling transaction. */
type Decision = {
  status: SettledStatus;
  code: string;
  notBefore?: Date;
  tally?: FactTally;
  within?: (transaction: PgTransactionClient) => Promise<{
    status: SettledStatus;
    code: string;
    tally?: FactTally;
  }>;
};

const decide = (
  status: SettledStatus,
  code: string,
  extra: Partial<Pick<Decision, "notBefore" | "tally" | "within">> = {},
): Decision => ({ status, code, ...extra });

/** The route is not retried: its authority or its subject no longer exists. */
const ignore = (code: RouteOutcomeCode): Decision =>
  decide(RouteStatus.Ignored, code);

type Within = NonNullable<Decision["within"]>;

/** Runs a write of the settling transaction only while the route's authority still holds. */
const whileAuthorized =
  (claim: RouteClaim, write: Within): Within => async (transaction) => {
    const denied = await authorityDeniedAtWrite(transaction, claim);
    return denied === null
      ? await write(transaction)
      : { status: RouteStatus.Ignored, code: denied };
  };

const emptyTally = (): FactTally => ({
  written: 0,
  unchanged: 0,
  stale: 0,
  skipped: 0,
});

function addWrite(tally: FactTally, result: FactWriteResult): void {
  tally[result] += 1;
}

/** `fact_written` if anything changed, else `fact_stale` if a newer one was kept, else `fact_unchanged`. */
function factCode(tally: FactTally): RouteOutcomeCode {
  if (tally.written > 0) return RouteOutcomeCode.FactWritten;
  if (tally.stale > 0) return RouteOutcomeCode.FactStale;
  return RouteOutcomeCode.FactUnchanged;
}

/**
 * The trace id of the delivery that made the route: the one its
 * `intake.received` domain event carries, so a discovery a delivery causes
 * can be followed back to its receipt. A route whose event is gone gets a
 * fresh id instead.
 */
async function routeTraceId(
  transaction: PgTransactionClient,
  claim: RouteClaim,
): Promise<string> {
  const found = await transaction.query<{ traceId: string | null }>(
    `select trace_id as "traceId" from bakery.domain_events
      where organization_id = $1 and aggregate_id = $2 and event_type = $3
      order by aggregate_version
      limit 1`,
    [claim.organizationId, claim.routeId, INTAKE_RECEIVED_EVENT],
  );
  return found.rows[0]?.traceId ?? crypto.randomUUID();
}

/**
 * Lock the installation row, then the connection row (the order the
 * reconcile and `queueDiscovery` require), and queue the connection's
 * discovery attributed to the principal who created the connection: a
 * webhook has no principal of its own. The discovery carries the route's own
 * trace id. An installation or connection that is no longer enabled settles
 * the route `ignored`. `completedCode` overrides the stored code of a route
 * that queued (or found) a discovery for another reason, such as a moved
 * repository.
 */
async function queueRouteDiscovery(
  transaction: PgTransactionClient,
  claim: RouteClaim,
  completedCode: RouteOutcomeCode | null = null,
): Promise<{ status: SettledStatus; code: string }> {
  const installation = (await transaction.query<{ status: string }>(
    `select status from bakery.integration_installations
      where id = $1 for update`,
    [claim.installationId],
  )).rows[0];
  const connection = (await transaction.query<{
    status: string;
    installationId: string;
    createdBy: string;
  }>(
    `select status, installation_id as "installationId",
       created_by as "createdBy"
       from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null
      for update`,
    [claim.organizationId, claim.connectionId],
  )).rows[0];
  if (connection === undefined || connection.status !== "enabled") {
    return {
      status: RouteStatus.Ignored,
      code: RouteOutcomeCode.ConnectionNotEnabled,
    };
  }
  if (connection.installationId !== claim.installationId) {
    return {
      status: RouteStatus.Ignored,
      code: RouteOutcomeCode.ConnectionChanged,
    };
  }
  if (installation === undefined) {
    return {
      status: RouteStatus.Ignored,
      code: RouteOutcomeCode.InstallationUnavailable,
    };
  }
  if (installation.status !== InstallationStatus.Enabled) {
    return {
      status: RouteStatus.Ignored,
      code: installationNotEnabled(installation.status),
    };
  }
  const { queued } = await queueDiscovery(transaction, {
    organizationId: claim.organizationId,
    connectionId: claim.connectionId,
    installationId: claim.installationId,
    principalId: connection.createdBy,
    traceId: await routeTraceId(transaction, claim),
  });
  return {
    status: RouteStatus.Completed,
    code: completedCode ??
      (queued
        ? RouteOutcomeCode.DiscoveryQueued
        : RouteOutcomeCode.DiscoveryActive),
  };
}

/** `installation_reconcile`: the existing live reconcile, skipped when it already ran after the receipt. */
async function reconcileRoute(
  dependencies: ReconcileDependencies,
  claim: RouteClaim,
  authority: RouteAuthority,
  signal: AbortSignal,
): Promise<Decision> {
  if (authority.installation?.alreadyCurrent === true) {
    return decide(RouteStatus.Completed, RouteOutcomeCode.AlreadyCurrent);
  }
  const outcome = await reconcileInstallation(
    dependencies,
    claim.installationId,
    signal,
  );
  switch (outcome.kind) {
    case "unchanged":
      return decide(
        RouteStatus.Completed,
        RouteOutcomeCode.InstallationUnchanged,
      );
    case "transitioned":
      return decide(
        RouteStatus.Completed,
        RouteOutcomeCode.InstallationTransitioned,
      );
    case "superseded":
      return decide(
        RouteStatus.Completed,
        RouteOutcomeCode.InstallationSuperseded,
      );
  }
}

type FactReader = {
  claim: RouteClaim;
  authority: RouteAuthority;
  resource: NonNullable<RouteAuthority["resource"]>;
  dependencies: ReconcileDependencies;
  token: string;
  signal: AbortSignal;
};

type RepositoryCheck = "same" | "different" | "moved" | "gone";

/**
 * Whether the repository path still names the repository Bakery stored. A
 * 404 or a redirect says nothing about the repository by itself: a name can
 * be reused by another repository, and an issue can be transferred out of one
 * that still exists. The stable numeric id settles which.
 */
async function checkRepository(reader: FactReader): Promise<RepositoryCheck> {
  const identity = await reader.dependencies.github.readRepositoryIdentity({
    token: reader.token,
    fullName: reader.resource.displayName,
  }, reader.signal);
  if (identity.kind === "present") {
    return String(identity.id) === reader.resource.externalId
      ? "same"
      : "different";
  }
  return identity.kind;
}

/** Marks the stored issue facts of a number gone, in the settling transaction. */
async function markIssueGone(
  transaction: PgTransactionClient,
  claim: RouteClaim,
  resourceId: string,
  number: number,
  observedStartedAt: Date,
): Promise<FactWriteResult | "absent"> {
  const stored = await transaction.query<{ externalId: string }>(
    `select external_id as "externalId"
       from bakery.integration_remote_facts
      where organization_id = $1 and resource_id = $2 and kind = $3
        and number = $4
      order by external_id`,
    [
      claim.organizationId,
      resourceId,
      RemoteFactKind.Issue,
      number,
    ],
  );
  if (stored.rows.length === 0) return "absent";
  const tally = emptyTally();
  for (const fact of stored.rows) {
    addWrite(
      tally,
      await markGone(transaction, {
        organizationId: claim.organizationId,
        resourceId,
        kind: RemoteFactKind.Issue,
        externalId: fact.externalId,
      }, observedStartedAt).then((result) =>
        result === "absent" ? "unchanged" : result
      ),
    );
  }
  return tally.written > 0
    ? "written"
    : tally.stale > 0
    ? "stale"
    : "unchanged";
}

/** A moved repository: no fact is written; the discovery rescans the connection. */
const repositoryMoved = (reader: FactReader): Decision =>
  decide(RouteStatus.Completed, RouteOutcomeCode.RepositoryMoved, {
    within: (transaction) =>
      queueRouteDiscovery(
        transaction,
        reader.claim,
        RouteOutcomeCode.RepositoryMoved,
      ),
  });

/** An issue event: a fresh issue read, stored when newer. */
async function refreshIssue(reader: FactReader): Promise<Decision> {
  const { claim, resource } = reader;
  const number = claim.projection?.number;
  if (number === null || number === undefined) {
    return ignore(RouteOutcomeCode.ProjectionIncomplete);
  }
  const resourceId = claim.resourceId!;
  const observedStartedAt = new Date();
  const read = await reader.dependencies.github.readIssue({
    token: reader.token,
    fullName: resource.displayName,
    number,
  }, reader.signal);
  if (read.kind === "moved") {
    // A moved issue path under a repository that still has its id means the
    // issue was transferred out; a moved repository path is a rename.
    if (await checkRepository(reader) !== "same") {
      return repositoryMoved(reader);
    }
    return decide(RouteStatus.Completed, RouteOutcomeCode.IssueTransferred, {
      within: whileAuthorized(claim, async (transaction) => {
        const result = await markIssueGone(
          transaction,
          claim,
          resourceId,
          number,
          observedStartedAt,
        );
        return {
          status: RouteStatus.Completed,
          code: result === "stale"
            ? RouteOutcomeCode.FactStale
            : RouteOutcomeCode.IssueTransferred,
        };
      }),
    });
  }
  if (read.kind === "gone") {
    if (await checkRepository(reader) !== "same") {
      return decide(RouteStatus.Completed, RouteOutcomeCode.RepositoryMoved);
    }
    return decide(RouteStatus.Completed, RouteOutcomeCode.FactGone, {
      within: whileAuthorized(claim, async (transaction) => {
        const result = await markIssueGone(
          transaction,
          claim,
          resourceId,
          number,
          observedStartedAt,
        );
        return {
          status: RouteStatus.Completed,
          code: result === "absent"
            ? RouteOutcomeCode.FactAbsent
            : result === "stale"
            ? RouteOutcomeCode.FactStale
            : RouteOutcomeCode.FactGone,
        };
      }),
    });
  }
  if (read.kind === "pull_request") {
    return ignore(RouteOutcomeCode.PullRequestNotTicket);
  }
  if (read.number !== number) {
    return ignore(RouteOutcomeCode.ProjectionIncomplete);
  }
  const fact = issueFactOf(
    { organizationId: claim.organizationId, resourceId },
    read,
    observedStartedAt,
  );
  return decide(RouteStatus.Completed, RouteOutcomeCode.FactWritten, {
    within: whileAuthorized(claim, async (transaction) => {
      const tally = emptyTally();
      addWrite(tally, await upsertFact(transaction, fact));
      return { status: RouteStatus.Completed, code: factCode(tally), tally };
    }),
  });
}

/** A pull request event: a fresh read of a tracked pull request, stored when newer. */
async function refreshPullRequest(reader: FactReader): Promise<Decision> {
  const { claim, authority, resource } = reader;
  const number = claim.projection?.number;
  const repositoryId = authority.repositoryId;
  if (number === null || number === undefined || repositoryId === null) {
    return ignore(RouteOutcomeCode.ProjectionIncomplete);
  }
  const observedStartedAt = new Date();
  const read = await reader.dependencies.github.readPullRequest({
    token: reader.token,
    fullName: resource.displayName,
    number,
  }, reader.signal);
  if ("kind" in read) {
    // Pull requests cannot be transferred, so a moved path is a moved repository.
    if (read.kind === "moved") return repositoryMoved(reader);
    return decide(
      RouteStatus.Completed,
      await checkRepository(reader) === "same"
        ? RouteOutcomeCode.PullRequestGone
        : RouteOutcomeCode.RepositoryMoved,
    );
  }
  if (read.number !== number) {
    return ignore(RouteOutcomeCode.ProjectionIncomplete);
  }
  const observation = {
    organizationId: claim.organizationId,
    number: read.number,
    state: read.state,
    merged: read.merged,
    url: read.url,
    headSha: read.headSha,
    baseSha: read.baseSha,
    mergedSha: read.mergedSha,
    providerUpdatedAt: new Date(read.updatedAt),
    observedStartedAt,
  };
  return decide(RouteStatus.Completed, RouteOutcomeCode.FactWritten, {
    within: whileAuthorized(claim, async (transaction) => {
      try {
        const tally = emptyTally();
        addWrite(
          tally,
          await observePullRequest(transaction, repositoryId, observation),
        );
        return { status: RouteStatus.Completed, code: factCode(tally), tally };
      } catch (error) {
        // Unregistered between the recheck and this write: nothing to keep.
        if (
          error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
        ) {
          return {
            status: RouteStatus.Ignored,
            code: RouteOutcomeCode.UntrackedPullRequest,
          };
        }
        throw error;
      }
    }),
  });
}

/** A check event: fresh check runs of the tracked head commit, each stored when newer. */
async function refreshChecks(reader: FactReader): Promise<Decision> {
  const { claim, resource } = reader;
  const headSha = claim.projection?.headSha;
  if (headSha === null || headSha === undefined) {
    return ignore(RouteOutcomeCode.ProjectionIncomplete);
  }
  const resourceId = claim.resourceId!;
  const facts: RemoteFact[] = [];
  const tally = emptyTally();
  let truncated = false;
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    // Taken before the request, so a run the page shows is never older than this.
    const observedStartedAt = new Date();
    const result = await reader.dependencies.github.listCheckRuns({
      token: reader.token,
      fullName: resource.displayName,
      headSha,
      page,
    }, reader.signal);
    for (const run of result.checkRuns) {
      const fact = checkRunFactOf(
        { organizationId: claim.organizationId, resourceId },
        headSha,
        run,
        observedStartedAt,
      );
      if (fact === null) {
        tally.skipped += 1;
      } else {
        facts.push(fact);
      }
    }
    if (!result.hasNext) break;
    if (page === MAX_CHECK_PAGES) truncated = true;
  }
  return decide(RouteStatus.Completed, RouteOutcomeCode.FactWritten, {
    within: whileAuthorized(claim, async (transaction) => {
      for (const fact of facts) {
        addWrite(tally, await upsertFact(transaction, fact));
      }
      return {
        status: RouteStatus.Completed,
        // A cut-off list says nothing about the runs it did not reach.
        code: truncated ? RouteOutcomeCode.ChecksTruncated : factCode(tally),
        tally,
      };
    }),
  });
}

/**
 * A fact route: a token narrowed to the one repository and the one read
 * permission, then the fresh read that belongs to the event. The token is
 * dropped from the broker's cache when GitHub rejects or errs on it, as the
 * connection probe does.
 */
async function refreshFact(
  dependencies: ReconcileDependencies,
  claim: RouteClaim,
  authority: RouteAuthority,
  signal: AbortSignal,
): Promise<Decision> {
  const subject = subjectOf(claim.eventKind);
  const { installation, resource, credentials, connection } = authority;
  if (
    subject === null || installation === null || resource === null ||
    connection === null
  ) return ignore(RouteOutcomeCode.UnsupportedEvent);
  const minted = await mintReadToken(
    dependencies,
    {
      connectionId: claim.connectionId,
      generation: authority.generation,
      connection,
      installation,
      resource,
      credentials,
    },
    subject,
    signal,
  );
  if (minted.kind === "refused") {
    return ignore(RouteOutcomeCode.PermissionMissing);
  }
  const reader: FactReader = {
    claim,
    authority,
    resource,
    dependencies,
    token: minted.token,
    signal,
  };
  try {
    switch (subject) {
      case "issue":
        return await refreshIssue(reader);
      case "pull_request":
        return await refreshPullRequest(reader);
      case "check":
        return await refreshChecks(reader);
    }
  } catch (error) {
    forgetFailedToken(
      dependencies,
      claim.connectionId,
      minted.token,
      error,
      signal,
    );
    throw error;
  }
}

/** Runs the action the route's purpose calls for; throws for the caller to classify. */
async function act(
  dependencies: ReconcileDependencies,
  claim: RouteClaim,
  authority: RouteAuthority,
  signal: AbortSignal,
): Promise<Decision> {
  switch (claim.purpose) {
    case "installation_reconcile":
      return await reconcileRoute(dependencies, claim, authority, signal);
    case "discovery":
      return decide(RouteStatus.Completed, RouteOutcomeCode.DiscoveryQueued, {
        within: (transaction) => queueRouteDiscovery(transaction, claim),
      });
    case "fact_refresh":
      return await refreshFact(dependencies, claim, authority, signal);
  }
}

/**
 * Turns a failed attempt into a deferral. A rate limit waits the time GitHub
 * named (at most an hour); every other failure, GitHub's or our own, backs
 * off `30 * 2^attempts` seconds up to an hour. A route that is gone from
 * under the reconcile is ignored. An aborted request is not a failure of the
 * route: it propagates.
 */
function failureDecision(
  error: unknown,
  claim: RouteClaim,
  signal: AbortSignal,
): Decision {
  signal.throwIfAborted();
  if (error instanceof GitHubReadFailure && error.kind === "rate_limited") {
    const seconds = error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS;
    return decide(RouteStatus.Deferred, RouteOutcomeCode.RateLimited, {
      notBefore: new Date(Date.now() + seconds * 1000),
    });
  }
  if (error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND") {
    return ignore(RouteOutcomeCode.InstallationUnavailable);
  }
  const changed = error instanceof StandardError &&
    error.code === "STATE_CONFLICT";
  return decide(
    RouteStatus.Deferred,
    changed
      ? RouteOutcomeCode.ConnectionChanged
      : RouteOutcomeCode.ProviderError,
    {
      notBefore: new Date(
        Date.now() + retryDelaySeconds(claim.attempts) * 1000,
      ),
    },
  );
}

/** Thrown inside the settling transaction when another worker took the route over. */
class RouteSuperseded extends Error {
  constructor() {
    super("INTAKE_ROUTE_SUPERSEDED");
    this.name = "RouteSuperseded";
  }
}

/**
 * One transaction: the decision's writes (facts, the discovery queue), then
 * the route's status and outcome, version + 1. The route update only applies
 * to the version the claim produced; if another worker claimed the stale
 * route meanwhile, the whole transaction rolls back and nothing is kept.
 */
async function settle(
  database: PgDatabase,
  claim: RouteClaim,
  decision: Decision,
): Promise<RouteOutcome> {
  try {
    return await withPgTransaction(database, async (transaction) => {
      const final = decision.within === undefined
        ? decision
        : { ...decision, ...await decision.within(transaction) };
      const updated = await transaction.query(
        `update bakery.inbound_event_routes
            set status = $3, outcome_code = $4,
                not_before = coalesce($5::timestamptz, not_before),
                updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2 and status = $6
            and version = $7`,
        [
          claim.organizationId,
          claim.routeId,
          final.status,
          final.code,
          decision.notBefore ?? null,
          RouteStatus.Processing,
          claim.version,
        ],
      );
      if (updated.rowCount !== 1) throw new RouteSuperseded();
      return settledOutcome(
        final.status,
        final.code,
        final.status === RouteStatus.Deferred
          ? decision.notBefore ?? null
          : null,
        final.tally ?? null,
      );
    });
  } catch (error) {
    if (error instanceof RouteSuperseded) {
      return { kind: "skipped", reason: "superseded" };
    }
    throw error;
  }
}

/** Everything after the claim: recheck, act, settle, and the one log line a deferral earns. */
async function processClaim(
  dependencies: ReconcileDependencies,
  claim: RouteClaim,
  signal: AbortSignal,
): Promise<RouteOutcome> {
  const authority = await loadAuthority(dependencies, claim);
  const reason = authorityVerdict(claim, authority);
  let decision: Decision;
  if (reason !== null) {
    decision = ignore(reason);
  } else {
    try {
      decision = await act(dependencies, claim, authority, signal);
    } catch (error) {
      decision = failureDecision(error, claim, signal);
    }
  }
  const outcome = await settle(dependencies.database, claim, decision);
  if (outcome.kind === RouteStatus.Deferred) {
    // The code and attempt only: never GitHub's answer, a token or a payload.
    console.warn(JSON.stringify({
      component: "integrations",
      event: "intake_route_deferred",
      routeId: claim.routeId,
      code: outcome.code,
      attempts: claim.attempts,
    }));
  }
  return outcome;
}

/**
 * Puts a claimed route back to `deferred` with the standard back-off, keeping
 * its attempts, when a failure the processor did not classify escaped after
 * the claim (the database, an abort, a bug). Without it the route would stay
 * `processing` until its claim goes stale, and a retry of the same function
 * would only find it `in_progress`. It applies only to the version the claim
 * produced, so a route another worker took over or already settled is left
 * alone, and it never throws: the caller rethrows the original error.
 */
async function releaseClaim(
  database: PgDatabase,
  claim: RouteClaim,
): Promise<void> {
  try {
    await database.query(
      `update bakery.inbound_event_routes
          set status = $3, outcome_code = $4,
              not_before = now() + ($5::bigint * interval '1 second'),
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = $6
          and version = $7`,
      [
        claim.organizationId,
        claim.routeId,
        RouteStatus.Deferred,
        RouteOutcomeCode.ProviderError,
        retryDelaySeconds(claim.attempts),
        RouteStatus.Processing,
        claim.version,
      ],
    );
  } catch {
    // The recovery cron takes the route over once its claim is stale.
    console.warn(JSON.stringify({
      component: "integrations",
      event: "intake_route_release_failed",
      routeId: claim.routeId,
      attempts: claim.attempts,
    }));
  }
}

/**
 * Processes one route: claim it, recheck its live authority, act, and settle
 * it in one transaction. Rechecking comes before any provider call, so a
 * suspended installation, a revoked or disabled connection or a deselected
 * repository settles `ignored` without touching GitHub; the writes recheck
 * the same authority again inside the settling transaction. A route is
 * retried only through deferral: a rate limit waits as long as GitHub said,
 * any other failure backs off (an unexpected one releases the claim first and
 * is rethrown), and the claim after the tenth attempt settles it
 * `failed(max_attempts)`. Replaying a settled route is a no-op.
 */
export async function processRoute(
  dependencies: ReconcileDependencies,
  routeId: string,
  signal: AbortSignal,
): Promise<RouteOutcome> {
  const claimed = await claimRoute(dependencies.database, routeId);
  if (claimed.kind === "ended") return claimed.outcome;
  const { claim } = claimed;
  try {
    return await processClaim(dependencies, claim, signal);
  } catch (error) {
    await releaseClaim(dependencies.database, claim);
    throw error;
  }
}

const INTAKE_FUNCTION_ID = "bakery-integration-intake";
const INTAKE_RECOVERY_FUNCTION_ID = "bakery-integration-intake-recovery";
const INTAKE_EVENT = INNGEST_EVENT_DEFINITIONS["intake.received"].name;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route an `intake.received` event names: the aggregate of its domain event. */
export function eventRouteId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const id = (data as { aggregateId?: unknown }).aggregateId;
  return typeof id === "string" && UUID.test(id) ? id : undefined;
}

/**
 * Processes the route each `intake.received` event names. The concurrency
 * limit bounds provider calls; a route claimed twice (the outbox and the
 * recovery both sent it) is processed once.
 */
export function createIntegrationIntakeWorkflow(
  options: ReconcileDependencies & { client: Inngest },
) {
  const { client, ...dependencies } = options;
  return client.createFunction(
    {
      id: INTAKE_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 4 }],
      triggers: [{ event: INTAKE_EVENT }],
    },
    async ({ event, step }) => {
      const routeId = eventRouteId(event);
      if (!routeId) throw new Error("INTEGRATION_INTAKE_EVENT_INVALID");
      return await step.run(
        `process-intake-route-${routeId}`,
        () => processRoute(dependencies, routeId, new AbortController().signal),
      );
    },
  );
}

/** A route the recovery sends again. */
export type DueRoute = {
  id: string;
  inboundEventId: string;
  version: number;
};

/**
 * Routes left behind: `pending` ones the outbox did not wake within a minute,
 * `deferred` ones whose wait is over, and `processing` ones whose claim is
 * older than `PROCESSING_STALE_MS`. `failed`, `completed` and `ignored` routes
 * are never listed. This is a system sweep across organizations; each route is
 * processed under its own organization.
 */
export async function dueRoutes(
  database: PgDatabase,
  limit = RECOVERY_BATCH,
): Promise<DueRoute[]> {
  const result = await database.query<DueRoute>(
    `select id, inbound_event_id as "inboundEventId", version
       from bakery.inbound_event_routes
      where (status = $2
          and updated_at <= now() - ($5::bigint * interval '1 millisecond'))
        or (status = $3 and not_before <= now())
        or (status = $4
          and updated_at <= now() - ($6::bigint * interval '1 millisecond'))
      order by updated_at, id
      limit $1`,
    [
      limit,
      RouteStatus.Pending,
      RouteStatus.Deferred,
      RouteStatus.Processing,
      PENDING_GRACE_MS,
      PROCESSING_STALE_MS,
    ],
  );
  return result.rows;
}

/**
 * Every minute, sends `intake.received` again for the routes `dueRoutes`
 * lists. The processor reads the route id from `data.aggregateId`, as the
 * outbox delivery sets it, so the resent event carries the same field.
 */
export function createIntegrationIntakeRecovery(
  options: Pick<ReconcileDependencies, "database"> & { client: Inngest },
) {
  return options.client.createFunction(
    {
      id: INTAKE_RECOVERY_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const due = await step.run(
        "due-integration-intake-routes",
        () => dueRoutes(options.database),
      );
      for (const route of due) {
        await step.sendEvent(
          `rearm-integration-intake-${route.id}-${route.version}`,
          {
            name: INTAKE_EVENT,
            data: {
              aggregateId: route.id,
              payload: { inboundEventId: route.inboundEventId },
            },
          },
        );
      }
      return { rearmed: due.length };
    },
  );
}
