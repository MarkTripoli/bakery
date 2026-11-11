import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { FactWriteResult } from "./remote-facts.ts";

/**
 * Pull request rows and the repository join.
 *
 * A pull request is tracked only after a task registers it; nothing here
 * adopts a pull request GitHub merely mentions. Observations come from fresh
 * provider reads and follow the same rule as remote facts: a write needs a
 * newer (provider_updated_at, observed_started_at) pair, and a read of the
 * state already stored changes nothing but the stored read start.
 */

/** Lifecycle a tracked pull request is stored in. */
export const PullRequestStatus = Object.freeze(
  {
    Open: "open",
    Closed: "closed",
    Merged: "merged",
  } as const,
);
export type PullRequestStatus =
  (typeof PullRequestStatus)[keyof typeof PullRequestStatus];

const FULL_SHA = /^[0-9a-f]{40}$/;
const PULL_REQUEST_COLUMNS = `id, organization_id as "organizationId",
  task_id as "taskId", repository_id as "repositoryId",
  provider_number as "providerNumber", url, head_sha as "headSha",
  base_sha as "baseSha", status, merged_sha as "mergedSha",
  provider_updated_at as "providerUpdatedAt",
  observed_started_at as "observedStartedAt",
  last_observed_at as "lastObservedAt", version`;

const ShaSchema = z.string().regex(FULL_SHA).describe(
  "Full lowercase 40-character Git commit SHA.",
);
const RepositoryIdSchema = z.string().uuid().describe(
  "Bakery repository (bakery.repositories) the pull request belongs to.",
);

/** One tracked pull request as stored. */
export const PullRequestRecordSchema = z.object({
  id: z.string().uuid().describe("Bakery id of the pull request row."),
  organizationId: z.string().uuid().describe(
    "Organization that owns the row; every query filters on it.",
  ),
  taskId: z.string().uuid().describe(
    "Task the pull request was registered for.",
  ),
  repositoryId: z.string().uuid().describe(
    "Bakery repository (bakery.repositories) the pull request belongs to.",
  ),
  providerNumber: z.number().int().positive().describe(
    "Pull request number inside its GitHub repository.",
  ),
  url: z.string().min(1).max(2048).describe(
    "Provider page of the pull request, as GitHub reported it.",
  ),
  headSha: ShaSchema,
  baseSha: ShaSchema,
  status: z.enum([
    PullRequestStatus.Open,
    PullRequestStatus.Closed,
    PullRequestStatus.Merged,
  ]).describe("open, closed (not merged) or merged."),
  mergedSha: z.string().regex(FULL_SHA).nullable().describe(
    "Commit that merged the pull request; null unless it is merged.",
  ),
  providerUpdatedAt: z.date().nullable().describe(
    "Provider time of the last stored observation; null until the first read.",
  ),
  observedStartedAt: z.date().nullable().describe(
    "Time the read behind the last stored observation began; null until the first read.",
  ),
  lastObservedAt: z.date().nullable().describe(
    "Time the last stored observation was written; null until the first read.",
  ),
  version: z.number().int().positive().describe(
    "Row version; it moves only when an observation changes the stored state.",
  ),
}).strict().describe(
  "One pull request a task registered, with the state of its latest stored observation.",
);
export type PullRequestRecord = z.output<typeof PullRequestRecordSchema>;

/** The GitHub repository resource whose Bakery repository is wanted. */
export const RepositoryResourceSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization of the connection; only its repositories can match.",
  ),
  connectionId: z.string().uuid().describe(
    "Connection the repository resource was discovered through; only repositories bound to it can match.",
  ),
  externalId: z.string().min(1).max(64).describe(
    "Numeric GitHub repository id as decimal text.",
  ),
  displayName: z.string().min(1).max(512).describe(
    "GitHub repository full name, owner/name.",
  ),
}).strict().describe(
  "Identity of a GitHub repository resource: organization, connection, numeric id and full name.",
);
export type RepositoryResource = z.output<typeof RepositoryResourceSchema>;

/**
 * The single definition of how a GitHub repository resource maps to a Bakery
 * repository. The match is the non-archived `bakery.repositories` row of the
 * same organization and the same integration connection whose free-text
 * `provider_repo_id` equals the resource's numeric `external_id` or its full
 * `display_name`. No match, or more than one, gives null: the repository is
 * untracked and nothing is adopted.
 *
 * The identity is trusted as given: callers pass the resource row's own
 * current `external_id` and `display_name`, for selected, available,
 * non-archived resources only. A stale name read from another resource row
 * resolves to whatever repository that name still matches.
 */
export async function resolveRepositoryId(
  transaction: PgTransactionClient,
  resource: RepositoryResource,
): Promise<string | null> {
  const identity = RepositoryResourceSchema.parse(resource);
  const matches = await transaction.query<{ id: string }>(
    `select id from bakery.repositories
      where organization_id = $1 and integration_connection_id = $2
        and archived_at is null and provider_repo_id in ($3, $4)
      order by id
      limit 2`,
    [
      identity.organizationId,
      identity.connectionId,
      identity.externalId,
      identity.displayName,
    ],
  );
  return matches.rows.length === 1 ? matches.rows[0].id : null;
}

/** A pull request a task opened, to be tracked from now on. */
export const PullRequestRegistrationSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization that owns the task and the repository.",
  ),
  taskId: z.string().uuid().describe(
    "Task the pull request belongs to.",
  ),
  repositoryId: z.string().uuid().describe(
    "Bakery repository the pull request was opened in.",
  ),
  providerNumber: z.number().int().positive().describe(
    "Pull request number inside its GitHub repository.",
  ),
  url: z.string().min(1).max(2048).describe(
    "Provider page of the pull request.",
  ),
  headSha: ShaSchema,
  baseSha: ShaSchema,
}).strict().describe(
  "Registration of one pull request a task opened: where it lives and the two commits it joined.",
);
export type PullRequestRegistration = z.output<
  typeof PullRequestRegistrationSchema
>;

/**
 * Starts tracking a pull request as `open`. Registering the same
 * (repository, number) again for the same task is a no-op that returns the
 * stored row; the same pair for another task is a conflict, never a silent
 * hand-over. A repository or task of another organization is refused by the
 * composite foreign keys, or reported as not found when the pair is taken.
 */
export async function registerPullRequest(
  transaction: PgTransactionClient,
  input: PullRequestRegistration,
): Promise<{ created: boolean; pullRequest: PullRequestRecord }> {
  const registration = PullRequestRegistrationSchema.parse(input);
  const inserted = await transaction.query(
    `insert into bakery.pull_requests (
       id, organization_id, task_id, repository_id, provider_number, url,
       head_sha, base_sha, status, version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
     on conflict (repository_id, provider_number) do nothing
     returning ${PULL_REQUEST_COLUMNS}`,
    [
      crypto.randomUUID(),
      registration.organizationId,
      registration.taskId,
      registration.repositoryId,
      registration.providerNumber,
      registration.url,
      registration.headSha,
      registration.baseSha,
      PullRequestStatus.Open,
    ],
  );
  if (inserted.rows[0] !== undefined) {
    return {
      created: true,
      pullRequest: PullRequestRecordSchema.parse(inserted.rows[0]),
    };
  }
  const existing = await transaction.query(
    `select ${PULL_REQUEST_COLUMNS} from bakery.pull_requests
      where organization_id = $1 and repository_id = $2
        and provider_number = $3`,
    [
      registration.organizationId,
      registration.repositoryId,
      registration.providerNumber,
    ],
  );
  if (existing.rows[0] === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const pullRequest = PullRequestRecordSchema.parse(existing.rows[0]);
  if (pullRequest.taskId !== registration.taskId) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "pull_request_registered_for_another_task" },
    });
  }
  return { created: false, pullRequest };
}

/** What to look a tracked pull request up by; at least one of the two. */
export const TrackedPullRequestQuerySchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization the repository belongs to.",
  ),
  repositoryId: z.string().uuid().describe(
    "Bakery repository to look in.",
  ),
  number: z.number().int().positive().optional().describe(
    "Pull request number to match; omitted to match on the head SHA alone.",
  ),
  headSha: z.string().regex(FULL_SHA).optional().describe(
    "Head commit SHA to match, as a check event carries it; omitted to match on the number alone.",
  ),
}).strict().refine(
  (query) => query.number !== undefined || query.headSha !== undefined,
  { message: "a lookup needs a pull request number or a head SHA" },
).describe(
  "Lookup of a tracked pull request in one repository by number, by head SHA, or by either.",
);
export type TrackedPullRequestQuery = z.output<
  typeof TrackedPullRequestQuerySchema
>;

/**
 * The tracked pull request of a repository that matches the number or the
 * head SHA, or null when none is registered. A number match wins over a SHA
 * match. A row of any status counts: tracking ends only when the row does.
 *
 * A head SHA alone may match several tracked pull requests and returns the
 * lowest number; callers that route by head SHA need existence only and pass
 * `number` when they need a specific one.
 */
export async function findTrackedPullRequest(
  transaction: PgTransactionClient,
  query: TrackedPullRequestQuery,
): Promise<PullRequestRecord | null> {
  const lookup = TrackedPullRequestQuerySchema.parse(query);
  const found = await transaction.query(
    `select ${PULL_REQUEST_COLUMNS} from bakery.pull_requests
      where organization_id = $1 and repository_id = $2
        and (provider_number = $3::integer or head_sha = $4::text)
      order by (provider_number = $3::integer) desc nulls last,
        provider_number
      limit 1`,
    [
      lookup.organizationId,
      lookup.repositoryId,
      lookup.number ?? null,
      lookup.headSha ?? null,
    ],
  );
  return found.rows[0] === undefined
    ? null
    : PullRequestRecordSchema.parse(found.rows[0]);
}

/** One fresh provider read of a pull request. */
export const PullRequestObservationSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization that owns the tracked pull request.",
  ),
  number: z.number().int().positive().describe(
    "Pull request number inside its GitHub repository.",
  ),
  state: z.enum(["open", "closed"]).describe(
    "GitHub state; a merged pull request reads closed with merged true.",
  ),
  merged: z.boolean().describe(
    "Whether GitHub reports the pull request merged.",
  ),
  url: z.string().min(1).max(2048).describe(
    "Provider page of the pull request.",
  ),
  headSha: ShaSchema,
  baseSha: ShaSchema,
  mergedSha: z.string().regex(FULL_SHA).nullable().describe(
    "Commit GitHub reports for the merge; only kept when the pull request is merged.",
  ),
  providerUpdatedAt: z.date().describe(
    "Provider updated_at of the pull request.",
  ),
  observedStartedAt: z.date().describe(
    "Time Bakery began the read, taken before the request was sent.",
  ),
}).strict().refine(
  (observation) => !observation.merged || observation.state === "closed",
  { message: "a merged pull request must read closed" },
).describe(
  "A fresh provider read of one pull request with the ordering marker the store compares before writing.",
);
export type PullRequestObservation = z.output<
  typeof PullRequestObservationSchema
>;

/** Closed plus merged is `merged`; every other read keeps GitHub's state. */
export function pullRequestStatus(
  observation: Pick<PullRequestObservation, "state" | "merged">,
): PullRequestStatus {
  return observation.merged ? PullRequestStatus.Merged : observation.state;
}

/**
 * Stores a fresh read of a registered pull request when its marker is newer
 * than the stored one and the state differs. An older read is `stale`. A read
 * of the state already stored is `unchanged`: it leaves `version` and the
 * state alone, and when it began later than the stored read, the stored read
 * start and `last_observed_at` move up to it, so an earlier-started read of
 * another state in the same provider second cannot overwrite a state a later
 * read confirmed. A pull request has no gone state, so every stored change
 * moves the provider time with it and the pair order alone is enough. A pull
 * request nobody registered is not found: the caller looks it up with
 * `findTrackedPullRequest` first.
 *
 * The row is locked (`select … for update`) before anything is decided, and
 * the lock lasts for the transaction. The write, the confirm and the verdict
 * therefore all see the same stored state: another writer cannot commit
 * between a read that found its state stored and the statement that records
 * the later read start, so a later-started read is never discarded as stale.
 */
export async function observePullRequest(
  transaction: PgTransactionClient,
  repositoryId: string,
  input: PullRequestObservation,
): Promise<FactWriteResult> {
  const repository = RepositoryIdSchema.parse(repositoryId);
  const observation = PullRequestObservationSchema.parse(input);
  const status = pullRequestStatus(observation);
  const mergedSha = status === PullRequestStatus.Merged
    ? observation.mergedSha
    : null;
  const locked = await transaction.query(
    `select ${PULL_REQUEST_COLUMNS} from bakery.pull_requests
      where organization_id = $1 and repository_id = $2
        and provider_number = $3
      for update`,
    [observation.organizationId, repository, observation.number],
  );
  if (locked.rows[0] === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const stored = PullRequestRecordSchema.parse(locked.rows[0]);
  const written = await transaction.query(
    `update bakery.pull_requests
        set url = $4, head_sha = $5, base_sha = $6, status = $7,
            merged_sha = $8, provider_updated_at = $9,
            observed_started_at = $10, last_observed_at = now(),
            version = version + 1
      where organization_id = $1 and repository_id = $2
        and provider_number = $3
        and (provider_updated_at is null
          or (provider_updated_at, observed_started_at)
            < ($9::timestamptz, $10::timestamptz))
        and (provider_updated_at, url, head_sha, base_sha, status, merged_sha)
          is distinct from
          ($9::timestamptz, $4::text, $5::text, $6::text, $7::text, $8::text)
      returning version`,
    [
      observation.organizationId,
      repository,
      observation.number,
      observation.url,
      observation.headSha,
      observation.baseSha,
      status,
      mergedSha,
      observation.providerUpdatedAt,
      observation.observedStartedAt,
    ],
  );
  if (written.rowCount === 1) return "written";
  // Not written: the same state is stored, or a newer one is. A read of the
  // stored state that began later confirms it; only the read clock moves.
  const confirmed = await transaction.query(
    `update bakery.pull_requests
        set observed_started_at = $10, last_observed_at = now()
      where organization_id = $1 and repository_id = $2
        and provider_number = $3
        and (provider_updated_at, url, head_sha, base_sha, status, merged_sha)
          is not distinct from
          ($9::timestamptz, $4::text, $5::text, $6::text, $7::text, $8::text)
        and observed_started_at < $10::timestamptz
      returning version`,
    [
      observation.organizationId,
      repository,
      observation.number,
      observation.url,
      observation.headSha,
      observation.baseSha,
      status,
      mergedSha,
      observation.providerUpdatedAt,
      observation.observedStartedAt,
    ],
  );
  if (confirmed.rowCount === 1) return "unchanged";
  // Neither statement matched, and the lock held since the first select means
  // the stored row is still the one that select returned.
  const same = stored.providerUpdatedAt?.getTime() ===
      observation.providerUpdatedAt.getTime() &&
    stored.url === observation.url && stored.headSha === observation.headSha &&
    stored.baseSha === observation.baseSha && stored.status === status &&
    stored.mergedSha === mergedSha;
  return same ? "unchanged" : "stale";
}
