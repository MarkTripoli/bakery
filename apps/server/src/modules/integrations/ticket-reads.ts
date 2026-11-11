import { StandardError } from "@bakery/contracts/http";
import {
  TICKET_SNAPSHOT_MAX_BLOCKERS,
  TicketSnapshotInputSchema,
} from "@bakery/contracts/ticket-admission";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import type {
  IssueRef,
  PredecessorProof,
  TicketActorRole,
  TicketFactIndex,
  TicketIssueListPage,
  TicketIssueRead,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketReadFailure,
  TicketSourceHandle,
  TicketSourceReader,
} from "../work/ticket-source-reader.ts";
import { readAppCredentials } from "./callbacks.ts";
import {
  authorityVerdict,
  forgetFailedToken,
  type ReadTokenAuthority,
} from "./fact-reads.ts";
import {
  type GitHubBlocker,
  type GitHubInstallationToken,
  type GitHubIssueDetail,
  type GitHubIssueEvent,
  type GitHubPermissions,
  GitHubReadFailure,
} from "./github-app.ts";
import { IntakeProjectionSchema } from "./intake-events.ts";
import type { ReconcileDependencies } from "./reconcile.ts";
import { RemoteFactKind } from "./remote-facts.ts";
import type { TokenTarget } from "./token-broker.ts";

/**
 * The live `TicketSourceReader`: every provider read
 * the work module's ticket admission makes goes through here, so the GitHub
 * client, the token broker and the authority rows stay inside `integrations`.
 *
 * Each read first loads the connection, installation and repository resource
 * rows and applies the same `authorityVerdict` the intake processor applies;
 * a source that has lost its authority gets no provider call at all. The read
 * token is narrowed to the one repository and to `TICKET_READ_PERMISSIONS`.
 * Nothing here holds a database transaction across a provider call, and an
 * answer is evidence about one moment, never a grant.
 *
 * Time strings the reader returns are canonical ISO 8601 with milliseconds
 * (`Date#toISOString`), so a caller may compare them as plain strings.
 */

/**
 * The GitHub App permissions every ticket read asks the token for: the
 * repository's issues and events, and the pull requests that closed a blocker.
 * Metadata read also covers the collaborator permission lookup.
 */
export const TICKET_READ_PERMISSIONS: Readonly<GitHubPermissions> = Object
  .freeze(
    {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    } as const,
  );

/** Pages of 100 issue events one proof or provenance read walks. */
export const TICKET_EVENT_PAGE_LIMIT = 5;
/** Pages of 100 pull requests one predecessor proof walks for a closing commit. */
export const TICKET_PULL_PAGE_LIMIT = 5;
/** Most issue numbers a fact index answers at once. */
export const TICKET_FACT_INDEX_MAX_LIMIT = 100;

const failure = (
  reason: TicketReadFailure["reason"],
  retryAfterSeconds: number | null = null,
): TicketReadFailure => ({ kind: "unavailable", reason, retryAfterSeconds });

/**
 * Maps what a provider call or token mint threw to the reader's answer. An
 * aborted request is not a failure of the provider and propagates. Only the
 * classified GitHub failures and the dependency/authority errors the client
 * and broker raise are answers; any other error is a defect and propagates.
 */
function failureOf(error: unknown, signal: AbortSignal): TicketReadFailure {
  signal.throwIfAborted();
  if (error instanceof GitHubReadFailure) {
    switch (error.kind) {
      case "rate_limited":
        return failure("rate_limited", error.retryAfterSeconds);
      case "timeout":
        return failure("timeout");
      case "rejected":
      case "forbidden":
        return failure("forbidden");
    }
  }
  if (error instanceof StandardError) {
    // The broker refuses a connection or installation that is not enabled, or
    // that was edited since the rows were read: the source lost its authority.
    if (
      error.code === "STATE_CONFLICT" || error.code === "RESOURCE_NOT_FOUND"
    ) {
      return failure("forbidden");
    }
    if (error.code === "DEPENDENCY_UNAVAILABLE") {
      return failure("provider_error");
    }
  }
  throw error;
}

/** What a read needs once the source's authority held and a token was minted. */
type ReadAccess = {
  kind: "ready";
  token: string;
  /** The repository's current name, read from the live resource row. */
  fullName: string;
  /** The numeric GitHub id of the repository, as the resource row stores it. */
  externalRepositoryId: string;
  connectionId: string;
};

/**
 * A token narrowed to the one repository and `TICKET_READ_PERMISSIONS`, shaped
 * after `mintReadToken` of the fact reads. A connection or installation that
 * is not enabled, or one edited since `generation` was captured, is refused by
 * the broker.
 */
export async function mintTicketReadToken(
  dependencies: Pick<ReconcileDependencies, "broker">,
  authority: ReadTokenAuthority,
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
    permissions: { ...TICKET_READ_PERMISSIONS },
  };
  return await dependencies.broker.token(target, signal);
}

/**
 * Loads the handle's authority rows and, only when `authorityVerdict` finds the
 * source live, its credentials, then mints the read token. A source that is
 * not live answers `forbidden` with no token minted and no provider call.
 */
async function openAccess(
  dependencies: ReconcileDependencies,
  handle: TicketSourceHandle,
  signal: AbortSignal,
): Promise<ReadAccess | TicketReadFailure> {
  // Captured before the rows are read, so an edit that commits afterwards
  // refuses the token mint.
  const generation = dependencies.broker.generation(handle.connectionId);
  const loaded = await withPgTransaction(
    dependencies.database,
    async (transaction) => {
      const connection = (await transaction.query<{
        status: string;
        installationId: string;
      }>(
        `select status, installation_id as "installationId"
           from bakery.integration_connections
          where organization_id = $1 and id = $2 and archived_at is null`,
        [handle.organizationId, handle.connectionId],
      )).rows[0] ?? null;
      const installation = connection === null ? null : (await transaction
        .query<{
          status: string;
          externalId: string;
          registrationId: string;
        }>(
          `select status, external_authorization_id as "externalId",
             registration_id as "registrationId"
             from bakery.integration_installations
            where id = $1`,
          [connection.installationId],
        )).rows[0] ?? null;
      const resource = (await transaction.query<{
        externalId: string;
        displayName: string;
        selected: boolean;
        available: boolean;
      }>(
        `select external_id as "externalId", display_name as "displayName",
           selected, available
           from bakery.integration_resources
          where organization_id = $1 and connection_id = $2 and id = $3
            and kind = 'repository' and archived_at is null`,
        [handle.organizationId, handle.connectionId, handle.resourceId],
      )).rows[0] ?? null;
      const denied = authorityVerdict(
            {
              purpose: "fact_refresh",
              installationId: connection?.installationId ?? "",
              resourceId: handle.resourceId,
              eventKind: "issues",
            },
            { connection, installation, resource, tracked: true },
          ) !== null ||
        // The handle names the repository by its numeric id; a resource row
        // that now holds another repository is not the source it was built for.
        resource?.externalId !== handle.externalRepositoryId;
      if (
        denied || connection === null || installation === null ||
        resource === null
      ) return null;
      return {
        connection,
        installation,
        resource,
        credentials: await readAppCredentials(transaction),
      };
    },
  );
  if (loaded === null) return failure("forbidden");
  const minted = await mintTicketReadToken(dependencies, {
    connectionId: handle.connectionId,
    generation,
    connection: loaded.connection,
    installation: loaded.installation,
    resource: loaded.resource,
    credentials: loaded.credentials,
  }, signal);
  if (minted.kind === "refused") return failure("forbidden");
  return {
    kind: "ready",
    token: minted.token,
    fullName: loaded.resource.displayName,
    externalRepositoryId: loaded.resource.externalId,
    connectionId: handle.connectionId,
  };
}

/**
 * Runs one read under the source's live authority. A failure of the provider
 * or the broker becomes the reader's `unavailable` answer, and the token a
 * failed call used is dropped from the broker as the intake processor does.
 */
async function withAccess<T>(
  dependencies: ReconcileDependencies,
  handle: TicketSourceHandle,
  signal: AbortSignal,
  run: (access: ReadAccess) => Promise<T>,
): Promise<T | TicketReadFailure> {
  signal.throwIfAborted();
  let access: ReadAccess | TicketReadFailure;
  try {
    access = await openAccess(dependencies, handle, signal);
  } catch (error) {
    return failureOf(error, signal);
  }
  if (access.kind === "unavailable") return access;
  try {
    return await run(access);
  } catch (error) {
    forgetFailedToken(
      dependencies,
      access.connectionId,
      access.token,
      error,
      signal,
    );
    return failureOf(error, signal);
  }
}

/** Canonical ISO 8601 with milliseconds of a time GitHub reported. */
const iso = (time: string): string => new Date(time).toISOString();

type Absent = { kind: "gone" } | { kind: "moved" };

/**
 * One issue read. A 404, 410 or redirect on the issue says nothing by itself:
 * a repository can be renamed or replaced and an issue transferred out, so the
 * repository's numeric id decides. Only a repository that is still the
 * source's reports the issue `gone` or `moved`; any other repository state is
 * `provider_error`, which the caller retries after discovery caught up.
 */
async function readIssueOrAbsent(
  dependencies: ReconcileDependencies,
  access: ReadAccess,
  number: number,
  signal: AbortSignal,
): Promise<GitHubIssueDetail | Absent | TicketReadFailure> {
  const detail = await dependencies.github.readIssueDetail({
    token: access.token,
    fullName: access.fullName,
    number,
  }, signal);
  if (detail.kind !== "gone" && detail.kind !== "moved") return detail;
  const identity = await dependencies.github.readRepositoryIdentity({
    token: access.token,
    fullName: access.fullName,
  }, signal);
  return identity.kind === "present" &&
      String(identity.id) === access.externalRepositoryId
    ? { kind: detail.kind }
    : failure("provider_error");
}

const sameRepository = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The reference to a blocker the snapshot stores. */
const refOfBlocker = (blocker: GitHubBlocker): IssueRef => ({
  id: String(blocker.id),
  number: blocker.number,
  repositoryFullName: blocker.repositoryFullName,
});

/**
 * Reads up to `TICKET_EVENT_PAGE_LIMIT` pages of an issue's label and close
 * events. GitHub documents no order and a page can keep no event and still
 * have a next page, so pages are walked by `hasNext` alone. `complete` is false
 * when pages remain after the bound: nothing read says what the rest holds.
 */
async function readEvents(
  dependencies: ReconcileDependencies,
  access: ReadAccess,
  number: number,
  signal: AbortSignal,
): Promise<{ events: GitHubIssueEvent[]; complete: boolean }> {
  const events: GitHubIssueEvent[] = [];
  for (let page = 1; page <= TICKET_EVENT_PAGE_LIMIT; page++) {
    const result = await dependencies.github.listIssueEvents({
      token: access.token,
      fullName: access.fullName,
      number,
      page,
    }, signal);
    events.push(...result.items);
    if (!result.hasNext) return { events, complete: true };
  }
  return { events, complete: false };
}

/** Events oldest first: by time, then by the id GitHub assigned in sequence. */
function chronological(events: GitHubIssueEvent[]): GitHubIssueEvent[] {
  return [...events].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id - right.id
  );
}

/** A GitHub login the reader will put into a request path (1 to 39 alphanumerics or hyphens). */
const COLLABORATOR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Builds the live reader. `dependencies.database` is read only for the
 * authority rows; every provider call runs outside a transaction.
 */
export function createTicketSourceReader(
  dependencies: ReconcileDependencies,
): TicketSourceReader {
  const github = dependencies.github;
  return {
    async readIssue(handle, number, signal): Promise<TicketIssueRead> {
      return await withAccess(dependencies, handle, signal, async (access) => {
        const detail = await readIssueOrAbsent(
          dependencies,
          access,
          number,
          signal,
        );
        if (detail.kind === "unavailable") return detail;
        if (detail.kind === "gone" || detail.kind === "moved") {
          return { kind: detail.kind };
        }
        if (detail.kind === "pull_request") {
          return { kind: "pull_request" as const };
        }
        if (detail.number !== number) return failure("provider_error");
        // GitHub documents no label order, so a hold or execute label past the
        // bound may have been cut: the label list is incomplete, and an
        // incomplete list never reads as "not held". Fail closed, as the
        // blocker list and the event pages do. The reason is its own, so a
        // report does not read as a GitHub outage while the issue keeps that
        // many labels.
        if (detail.labelsTruncated) return failure("labels_truncated");
        const snapshot = TicketSnapshotInputSchema.safeParse({
          externalId: String(detail.id),
          number: detail.number,
          title: detail.title,
          body: detail.body,
          bodyTooLarge: detail.bodyTooLarge,
          labels: detail.labels,
          state: detail.state,
          stateReason: detail.stateReason === null ||
              detail.stateReason.length === 0
            ? null
            : detail.stateReason.slice(0, 40),
          locked: detail.locked,
          repositoryFullName: access.fullName,
        });
        // An answer outside the contract is never admitted.
        if (!snapshot.success) return failure("provider_error");
        return {
          kind: "present" as const,
          snapshot: snapshot.data,
          providerUpdatedAt: iso(detail.updatedAt),
          // Unknown is private: only an explicit `private: false` on the
          // issue read says public, and the single-issue read often omits it.
          visibility: detail.repositoryPrivate === false
            ? "public" as const
            : "private" as const,
        };
      });
    },

    async readLinks(handle, number, signal): Promise<TicketLinksRead> {
      return await withAccess(dependencies, handle, signal, async (access) => {
        const detail = await readIssueOrAbsent(
          dependencies,
          access,
          number,
          signal,
        );
        if (detail.kind === "unavailable") return detail;
        // The caller read the issue first; an issue that vanished or became
        // a pull request since gives no links to rely on.
        if (detail.kind !== "issue") return failure("provider_error");
        let parent: IssueRef | null = null;
        if (
          detail.parent !== null &&
          sameRepository(detail.parent.repositoryFullName, access.fullName)
        ) {
          // The issue read names the parent by URL only and the snapshot
          // stores its immutable id, so a parent in this repository is read.
          const read = await readIssueOrAbsent(
            dependencies,
            access,
            detail.parent.number,
            signal,
          );
          if (read.kind === "unavailable") return read;
          if (read.kind === "issue") {
            parent = {
              id: String(read.id),
              number: read.number,
              repositoryFullName: detail.parent.repositoryFullName,
            };
          }
        }
        // A parent in another repository cannot be read through a token
        // narrowed to this one, so its id is unknown; nothing gates on the
        // parent, and the snapshot records none rather than a guessed id.
        let blockedBy: IssueRef[] = [];
        // An unreported blocker count is unknown, never zero: the list alone
        // cannot show a blocker the installation cannot see, so a complete-
        // looking first page is not trusted without the count to check it
        // against. The answer is marked incomplete and the evaluator waits
        // (`links_truncated`), as it does for the sub-issue count below.
        let truncated = detail.blockedByTotal === null;
        if (detail.blockedByTotal !== 0) {
          const page = await github.listBlockedBy({
            token: access.token,
            fullName: access.fullName,
            number,
            page: 1,
          }, signal);
          const listed = page.items.map(refOfBlocker);
          blockedBy = listed.slice(0, TICKET_SNAPSHOT_MAX_BLOCKERS);
          // The list is cut at its bound, or GitHub counts blockers the list
          // did not show (inaccessible ones): either way it is not complete.
          truncated = truncated || page.hasNext ||
            listed.length > blockedBy.length ||
            (detail.blockedByTotal !== null &&
              detail.blockedByTotal !== listed.length);
        }
        // An unreported sub-issue count is unknown, never zero: the epic check
        // cannot pass on it, so the answer is marked incomplete and the
        // evaluator waits (`links_truncated`).
        if (detail.subIssuesTotal === null) truncated = true;
        return {
          kind: "present" as const,
          parent,
          subIssuesTotal: detail.subIssuesTotal ?? 0,
          blockedBy,
          // Informational only: what this issue blocks gates nothing here.
          blockingTotal: detail.blockingTotal ?? 0,
          truncated,
        };
      });
    },

    async readPredecessorProof(
      handle,
      blocker,
      signal,
    ): Promise<PredecessorProof | TicketReadFailure> {
      return await withAccess(
        dependencies,
        handle,
        signal,
        async (access): Promise<PredecessorProof | TicketReadFailure> => {
          // The token reaches only the source repository.
          if (!sameRepository(blocker.repositoryFullName, access.fullName)) {
            return { kind: "inaccessible" };
          }
          const issue = await readIssueOrAbsent(
            dependencies,
            access,
            blocker.number,
            signal,
          );
          if (issue.kind === "unavailable") return issue;
          if (issue.kind === "gone" || issue.kind === "moved") {
            return { kind: "inaccessible" };
          }
          if (issue.kind === "pull_request") {
            return { kind: "proof_unavailable", detail: "blocker_not_issue" };
          }
          if (String(issue.id) !== blocker.id) {
            return {
              kind: "proof_unavailable",
              detail: "blocker_identity_changed",
            };
          }
          if (issue.state === "open") return { kind: "open" };
          if (issue.stateReason !== "completed") {
            return { kind: "closed_unmerged", stateReason: issue.stateReason };
          }
          const { events, complete } = await readEvents(
            dependencies,
            access,
            blocker.number,
            signal,
          );
          // The latest close is unknown while event pages remain unread.
          if (!complete) {
            return { kind: "proof_unavailable", detail: "events_incomplete" };
          }
          const closes = chronological(events).filter((event) =>
            event.event === "closed"
          );
          const closing = closes.at(-1);
          if (closing === undefined) {
            return {
              kind: "proof_unavailable",
              detail: "closing_event_missing",
            };
          }
          if (closing.commitId === null) {
            return { kind: "closed_unmerged", stateReason: "completed" };
          }
          const repository = await github.readRepositoryIdentity({
            token: access.token,
            fullName: access.fullName,
            withDefaultBranch: true,
          }, signal);
          if (
            repository.kind !== "present" ||
            String(repository.id) !== access.externalRepositoryId ||
            repository.defaultBranch === undefined
          ) {
            return { kind: "proof_unavailable", detail: "repository_changed" };
          }
          const merged: {
            number: number;
            mergedAt: string;
            mergeSha: string;
          }[] = [];
          let pullsComplete = false;
          for (let page = 1; page <= TICKET_PULL_PAGE_LIMIT; page++) {
            const pulls = await github.listCommitPullRequests({
              token: access.token,
              fullName: access.fullName,
              sha: closing.commitId,
              page,
            }, signal);
            for (const pull of pulls.items) {
              if (
                pull.merged && pull.mergedAt !== null &&
                pull.baseRef === repository.defaultBranch
              ) {
                merged.push({
                  number: pull.number,
                  mergedAt: iso(pull.mergedAt),
                  mergeSha: pull.mergeCommitSha ?? closing.commitId,
                });
              }
            }
            if (!pulls.hasNext) {
              pullsComplete = true;
              break;
            }
          }
          // The earliest merge into the default branch is the proof; a stable
          // pick when a commit belongs to several merged pull requests.
          merged.sort((left, right) =>
            Date.parse(left.mergedAt) - Date.parse(right.mergedAt) ||
            left.number - right.number
          );
          const proof = merged[0];
          if (proof !== undefined) {
            return {
              kind: "satisfied",
              pullRequestNumber: proof.number,
              mergeSha: proof.mergeSha,
              mergedAt: proof.mergedAt,
            };
          }
          return pullsComplete
            ? { kind: "closed_unmerged", stateReason: "completed" }
            : { kind: "proof_unavailable", detail: "pull_requests_incomplete" };
        },
      );
    },

    async readLabelProvenance(
      handle,
      number,
      label,
      signal,
    ): Promise<TicketLabelProvenance> {
      return await withAccess(
        dependencies,
        handle,
        signal,
        async (access): Promise<TicketLabelProvenance> => {
          const { events, complete } = await readEvents(
            dependencies,
            access,
            number,
            signal,
          );
          // The latest event for the label decides, and pages left unread may
          // hold a later one: without the whole history nothing is verified.
          if (!complete) {
            return { kind: "unverifiable", reason: "events_incomplete" };
          }
          const latest = chronological(events).filter((event) =>
            event.labelName === label &&
            (event.event === "labeled" || event.event === "unlabeled")
          ).at(-1);
          if (latest === undefined || latest.event === "unlabeled") {
            return { kind: "absent" };
          }
          // GitHub names no actor for a deleted account (the ghost user).
          if (latest.actor === null) {
            return { kind: "unverifiable", reason: "ghost_actor" };
          }
          return {
            kind: "applied",
            actorId: String(latest.actor.id),
            actorLogin: latest.actor.login,
            appliedAt: iso(latest.createdAt),
          };
        },
      );
    },

    async readActorRole(handle, login, signal): Promise<TicketActorRole> {
      // A login GitHub cannot issue (a bot's `[bot]` suffix, spaces, slashes)
      // names no collaborator and never reaches a request path.
      if (!COLLABORATOR_LOGIN.test(login)) return { kind: "absent" };
      return await withAccess(
        dependencies,
        handle,
        signal,
        async (access): Promise<TicketActorRole> => {
          const read = await github.readCollaboratorPermission({
            token: access.token,
            fullName: access.fullName,
            login,
          }, signal);
          if (read.kind === "gone") return { kind: "absent" };
          // A moved repository path answers nothing about the user.
          if (read.kind === "moved") return failure("provider_error");
          return {
            kind: "present",
            userId: String(read.userId),
            permission: read.permission,
          };
        },
      );
    },

    async listIssues(handle, request, signal): Promise<TicketIssueListPage> {
      return await withAccess(
        dependencies,
        handle,
        signal,
        async (access): Promise<TicketIssueListPage> => {
          const page = await github.listRepositoryIssues({
            token: access.token,
            fullName: access.fullName,
            state: "open",
            ...(request.since === null ? {} : { since: request.since }),
            page: request.page,
          }, signal);
          return {
            kind: "present",
            // GitHub lists pull requests among the issues; they are no tickets.
            numbers: page.items.filter((item) => item.kind === "issue").map((
              item,
            ) => ({
              number: item.number,
              updatedAt: iso(item.updatedAt),
              labels: item.labels,
            })),
            hasNext: page.hasNext,
          };
        },
      );
    },
  };
}

/** The issue event a route is about, read from the route and its receipt. */
export type IssueRouteTarget = {
  /** Always `issues`: any other event kind has no target. */
  eventKind: "issues";
  /** The `issues` webhook action (`labeled`, `edited`, `closed`...), null when unstated. */
  action: string | null;
  /** The issue number the event names. */
  number: number;
  /** The repository resource the route reads through. */
  resourceId: string;
  organizationId: string;
  connectionId: string;
  /** Bakery's own installation row id (not GitHub's numeric installation id). */
  installationId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The issue a `fact_refresh` route of an `issues` delivery is about, or null
 * for a missing route, any other purpose or event kind, a route without a
 * repository resource, or a receipt whose projection names no issue. Reads the
 * route and its receipt in the caller's transaction and leaves the intake
 * processor's claim alone: the route's own settling is not this function's.
 */
export async function readIssueRouteTarget(
  transaction: PgTransactionClient,
  routeId: string,
): Promise<IssueRouteTarget | null> {
  if (!UUID.test(routeId)) return null;
  const found = await transaction.query<{
    organizationId: string;
    connectionId: string;
    installationId: string;
    resourceId: string | null;
    purpose: string;
    eventKind: string;
    projection: unknown;
  }>(
    `select route.organization_id as "organizationId",
       route.connection_id as "connectionId",
       route.installation_id as "installationId",
       route.resource_id as "resourceId", route.purpose,
       event.event_kind as "eventKind",
       event.normalized_projection as projection
       from bakery.inbound_event_routes as route
       join bakery.inbound_events as event on event.id = route.inbound_event_id
      where route.id = $1`,
    [routeId],
  );
  const row = found.rows[0];
  if (
    row === undefined || row.purpose !== "fact_refresh" ||
    row.eventKind !== "issues" || row.resourceId === null
  ) return null;
  const projection = IntakeProjectionSchema.safeParse(row.projection);
  if (!projection.success || projection.data.number === null) return null;
  return {
    eventKind: "issues",
    action: projection.data.action,
    number: projection.data.number,
    resourceId: row.resourceId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    installationId: row.installationId,
  };
}

/**
 * The live `TicketFactIndex`: the issue facts kept in
 * `integration_remote_facts`, newer than a provider-update marker, oldest
 * first. Closed and gone issues are included, since a close or a removal is
 * what a recheck of a known ticket must see. `afterMarker` alone is exclusive:
 * an issue updated at the marker's instant is not returned again. With
 * `afterNumber` the position is the keyset `(afterMarker, afterNumber)` over
 * the `(provider_updated_at, number)` order, so a caller pages through a tie
 * group longer than the row bound without skipping or repeating a row.
 * `limit` is clamped to 1 to `TICKET_FACT_INDEX_MAX_LIMIT`.
 */
export function createTicketFactIndex(): TicketFactIndex {
  return {
    async listIssueNumbers(transaction, request) {
      if (
        request.afterMarker !== null &&
        Number.isNaN(Date.parse(request.afterMarker))
      ) {
        throw new StandardError({ code: "VALIDATION_FAILED" });
      }
      const limit = Number.isFinite(request.limit)
        ? Math.min(
          TICKET_FACT_INDEX_MAX_LIMIT,
          Math.max(1, Math.trunc(request.limit)),
        )
        : 1;
      const found = await transaction.query<{
        number: number;
        providerUpdatedAt: Date;
        summary: { labels?: unknown } | null;
      }>(
        `select number, provider_updated_at as "providerUpdatedAt", summary
           from bakery.integration_remote_facts
          where organization_id = $1 and resource_id = $2 and kind = $3
            and number is not null
            and ($4::timestamptz is null
              or provider_updated_at > $4::timestamptz
              or ($6::integer is not null
                and provider_updated_at = $4::timestamptz
                and number > $6::integer))
          order by provider_updated_at, number
          limit $5`,
        [
          request.organizationId,
          request.resourceId,
          RemoteFactKind.Issue,
          request.afterMarker,
          limit,
          request.afterNumber ?? null,
        ],
      );
      return found.rows.map((row) => ({
        number: row.number,
        providerUpdatedAt: row.providerUpdatedAt.toISOString(),
        labels: Array.isArray(row.summary?.labels)
          ? row.summary.labels.filter((label): label is string =>
            typeof label === "string"
          )
          : [],
      }));
    },
  };
}
