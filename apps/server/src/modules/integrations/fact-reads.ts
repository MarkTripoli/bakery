import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { AppCredentials } from "./callbacks.ts";
import {
  type GitHubCheckRun,
  type GitHubInstallationToken,
  type GitHubIssueItem,
  type GitHubPermissions,
  GitHubReadFailure,
} from "./github-app.ts";
import { InstallationStatus } from "./installation-fan-out.ts";
import {
  type IntakeRoutePurpose,
  isSupportedEvent,
  type SupportedEvent,
} from "./intake-events.ts";
import { ReceiptReason } from "./intake-receipts.ts";
import type { ReconcileDependencies } from "./reconcile.ts";
import {
  boundFactSummary,
  type RemoteFact,
  RemoteFactKind,
  RemoteFactSchema,
} from "./remote-facts.ts";
import type { TokenTarget } from "./token-broker.ts";
import { type AuthorityScope, lockAuthority } from "./write-authority.ts";

/**
 * What the route processor (`intake-workflow.ts`) and the reconciliation sweep
 * (`fact-sweep.ts`) share.
 *
 * Both judge the live authority of the installation, connection and repository
 * before a provider request and again inside the transaction that stores its
 * answer; both read GitHub through a token narrowed to one repository and one
 * read permission; and both turn what they read into facts the ordered stores
 * accept. Keeping that here means the sweep does not depend on the processor.
 */

/** Pages of 50 check runs one route reads for a commit. */
export const MAX_CHECK_PAGES = 4;

/** Outcome codes the processor stores on a route in `outcome_code`. */
export const RouteOutcomeCode = Object.freeze(
  {
    // completed
    AlreadyCurrent: "already_current",
    InstallationUnchanged: "installation_unchanged",
    InstallationTransitioned: "installation_transitioned",
    InstallationSuperseded: "installation_superseded",
    DiscoveryQueued: "discovery_queued",
    DiscoveryActive: "discovery_active",
    FactWritten: "fact_written",
    FactUnchanged: "fact_unchanged",
    FactStale: "fact_stale",
    FactGone: "fact_gone",
    FactAbsent: "fact_absent",
    ChecksTruncated: "checks_truncated",
    IssueTransferred: "issue_transferred",
    PullRequestGone: "pull_request_gone",
    RepositoryMoved: "repository_moved",
    // ignored
    ConnectionNotEnabled: ReceiptReason.ConnectionNotEnabled,
    ConnectionChanged: "connection_changed",
    InstallationUnavailable: "installation_unavailable",
    InstallationPending: ReceiptReason.InstallationPending,
    InstallationSuspended: ReceiptReason.InstallationSuspended,
    InstallationRevoked: ReceiptReason.InstallationRevoked,
    UnselectedRepository: ReceiptReason.UnselectedRepository,
    UntrackedPullRequest: ReceiptReason.UntrackedPullRequest,
    UnsupportedEvent: ReceiptReason.UnsupportedEvent,
    ProjectionIncomplete: "projection_incomplete",
    PullRequestNotTicket: "pull_request_not_ticket",
    PermissionMissing: "permission_missing",
    // deferred
    RateLimited: "rate_limited",
    ProviderError: "provider_error",
    // failed
    MaxAttempts: "max_attempts",
  } as const,
);
export type RouteOutcomeCode =
  (typeof RouteOutcomeCode)[keyof typeof RouteOutcomeCode];

/** The part of the live authority the verdict reads; a `RouteAuthority` is one. */
export type AuthorityFacts = {
  connection: { status: string; installationId: string } | null;
  installation: { status: string } | null;
  resource: { selected: boolean; available: boolean } | null;
  /** Whether a pull request or check event names a pull request a task registered. */
  tracked: boolean;
};

/** What a `fact_refresh` route, or a sweep stream, reads: an issue, a pull request or a commit's checks. */
export type Subject = "issue" | "pull_request" | "check";

const SUBJECTS: Partial<Record<SupportedEvent, Subject>> = {
  issues: "issue",
  pull_request: "pull_request",
  check_run: "check",
  check_suite: "check",
};

export function subjectOf(eventKind: string): Subject | null {
  return isSupportedEvent(eventKind) ? SUBJECTS[eventKind] ?? null : null;
}

/** The GitHub App permission scope a read of each subject needs. */
const SUBJECT_SCOPE = {
  issue: "issues",
  pull_request: "pull_requests",
  check: "checks",
} as const satisfies Record<Subject, string>;

/** The outcome code of an installation that is not enabled, by its status. */
export function installationNotEnabled(status: string): RouteOutcomeCode {
  switch (status) {
    case InstallationStatus.Suspended:
      return RouteOutcomeCode.InstallationSuspended;
    case InstallationStatus.Revoked:
      return RouteOutcomeCode.InstallationRevoked;
    default:
      return RouteOutcomeCode.InstallationPending;
  }
}

/** What the verdict reads of a route, or of a sweep checkpoint dressed as one. */
export type VerdictRoute = {
  purpose: IntakeRoutePurpose;
  installationId: string;
  resourceId: string | null;
  eventKind: string;
};

/**
 * The reason a route must not run, or null when its live authority still
 * holds. A lifecycle (`installation_reconcile`) route still runs against a
 * suspended installation, because the unsuspend that the delivery announces
 * is exactly what it must act on; every other route needs an enabled
 * installation, an enabled connection of the same installation and, when it
 * names a repository, a selected and available resource. A route about a
 * pull request needs a tracked pull request. Nothing here reads the payload.
 */
export function authorityVerdict(
  route: VerdictRoute,
  authority: AuthorityFacts,
): RouteOutcomeCode | null {
  const { connection, installation, resource } = authority;
  if (connection === null || connection.status !== "enabled") {
    return RouteOutcomeCode.ConnectionNotEnabled;
  }
  if (connection.installationId !== route.installationId) {
    return RouteOutcomeCode.ConnectionChanged;
  }
  if (installation === null) return RouteOutcomeCode.InstallationUnavailable;
  const installationAllowed = route.purpose === "installation_reconcile"
    ? installation.status === InstallationStatus.Enabled ||
      installation.status === InstallationStatus.Suspended
    : installation.status === InstallationStatus.Enabled;
  if (!installationAllowed) return installationNotEnabled(installation.status);
  if (route.purpose === "installation_reconcile") return null;
  // A route that names a repository resource needs that resource to be live.
  if (
    (route.purpose === "fact_refresh" || route.resourceId !== null) &&
    resource === null
  ) return RouteOutcomeCode.UnselectedRepository;
  if (resource !== null && (!resource.selected || !resource.available)) {
    return RouteOutcomeCode.UnselectedRepository;
  }
  if (route.purpose === "fact_refresh") {
    const subject = subjectOf(route.eventKind);
    if (subject === null) return RouteOutcomeCode.UnsupportedEvent;
    if (subject !== "issue" && !authority.tracked) {
      return RouteOutcomeCode.UntrackedPullRequest;
    }
  }
  return null;
}

/** What the write-time guard needs of a route, or of a sweep checkpoint dressed as one. */
export type WriteGuardScope =
  & AuthorityScope
  & Pick<VerdictRoute, "purpose" | "eventKind">;

/**
 * Re-tests the authority the recheck found, inside the transaction that is
 * about to write. The provider read between the two can take seconds, so a
 * repository deselected, a connection revoked or an installation suspended in
 * the meantime must end the route `ignored` with nothing stored. The rows are
 * locked `for share` by `lockAuthority`, which the reconciliation sweep uses
 * too, so none of them can change before this transaction commits. Returns
 * the reason the write must not happen, or null while the authority holds.
 */
export async function authorityDeniedAtWrite(
  transaction: PgTransactionClient,
  scope: WriteGuardScope,
): Promise<RouteOutcomeCode | null> {
  const locked = await lockAuthority(transaction, scope);
  // Whether a pull request is still tracked is decided by the write itself.
  return authorityVerdict(scope, { ...locked, tracked: true });
}

/** The repository resource a fact is stored under, with its organization. */
export type FactScope = { organizationId: string; resourceId: string };

/**
 * The fact for one issue item a fresh read returned: identity, state and the
 * bounded summary, ordered by the item's `updated_at` and the time the read
 * began. Shared by the route processor and the reconciliation sweep, so both
 * store an issue the same way. The caller has already told a pull request
 * item from an issue.
 */
export function issueFactOf(
  scope: FactScope,
  item: GitHubIssueItem,
  observedStartedAt: Date,
): RemoteFact {
  return RemoteFactSchema.parse({
    organizationId: scope.organizationId,
    resourceId: scope.resourceId,
    kind: RemoteFactKind.Issue,
    externalId: String(item.id),
    number: item.number,
    headSha: null,
    state: item.state,
    conclusion: null,
    providerUpdatedAt: new Date(item.updatedAt),
    observedStartedAt,
    summary: boundFactSummary({
      labels: item.labels,
      locked: item.locked,
      stateReason: item.stateReason,
    }),
  });
}

/**
 * The fact for one check run of `headSha`, or null when it has no place in
 * the order: a run orders by when it completed, else when it started, and one
 * with neither, or for another commit, is left out (the caller counts it).
 */
export function checkRunFactOf(
  scope: FactScope,
  headSha: string,
  run: GitHubCheckRun,
  observedStartedAt: Date,
): RemoteFact | null {
  const providerTime = run.completedAt ?? run.startedAt;
  if (providerTime === null || run.headSha !== headSha) return null;
  const candidate = RemoteFactSchema.safeParse({
    organizationId: scope.organizationId,
    resourceId: scope.resourceId,
    kind: RemoteFactKind.CheckRun,
    externalId: String(run.id),
    number: null,
    headSha: run.headSha,
    state: run.status,
    conclusion: run.conclusion === "" ? null : run.conclusion,
    providerUpdatedAt: new Date(providerTime),
    observedStartedAt,
    summary: {
      name: run.name,
      status: run.status,
      // Null once GitHub no longer has the creating App: an unknown author.
      appId: run.appId,
      appSlug: run.appSlug,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
  });
  return candidate.success ? candidate.data : null;
}

/** Sees the GitHub App permissions a read of this subject asks the token for. */
export function permissionsFor(subject: Subject): GitHubPermissions {
  return { metadata: "read", [SUBJECT_SCOPE[subject]]: "read" };
}

/** What a read token is minted from, all read from Bakery's own rows. */
export type ReadTokenAuthority = {
  connectionId: string;
  /** Broker generation captured before the rows below were read. */
  generation: number;
  connection: { status: string };
  installation: { status: string; externalId: string; registrationId: string };
  /** The repository the token is narrowed to. */
  resource: { externalId: string };
  /** The registered App's credentials; a mismatch with the installation's registration is a dependency failure. */
  credentials: AppCredentials | null;
};

/**
 * A token narrowed to the one repository and the one read permission of
 * `subject`. A connection or installation that is not enabled, or one edited
 * since `generation` was captured, is refused by the broker. Shared by the
 * route processor and the reconciliation sweep.
 */
export async function mintReadToken(
  dependencies: ReconcileDependencies,
  authority: ReadTokenAuthority,
  subject: Subject,
  signal: AbortSignal,
): Promise<GitHubInstallationToken | { kind: "refused" }> {
  const { credentials, installation, resource, connection } = authority;
  if (
    credentials === null ||
    credentials.registrationId !== installation.registrationId
  ) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const target: TokenTarget = {
    connectionId: authority.connectionId,
    generation: authority.generation,
    status: connection.status,
    installationStatus: installation.status,
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId: Number(installation.externalId),
    repositoryIds: [Number(resource.externalId)],
    permissions: permissionsFor(subject),
  };
  return await dependencies.broker.token(target, signal);
}

/**
 * Drops a token GitHub failed from the broker's cache, as the connection
 * probe does. A rate limit or timeout says nothing against the token, and a
 * client that went away says nothing about it either; any other failure drops
 * it so the next attempt mints afresh.
 */
export function forgetFailedToken(
  dependencies: Pick<ReconcileDependencies, "broker">,
  connectionId: string,
  token: string,
  error: unknown,
  signal: AbortSignal,
): void {
  const kept = signal.aborted ||
    (error instanceof GitHubReadFailure &&
      (error.kind === "rate_limited" || error.kind === "timeout"));
  if (!kept) dependencies.broker.forget(connectionId, token);
}
