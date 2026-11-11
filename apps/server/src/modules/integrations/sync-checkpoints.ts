import { z } from "zod";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { GITHUB_READ_PAGE_SIZE } from "./github-app.ts";

/**
 * Resumable reconciliation progress.
 *
 * One checkpoint belongs to one selected repository resource and one stream:
 * `issues`, `pull_requests` or `checks`. The row holds the stream's cursor,
 * so a scan that fails, is rate limited or hits its request cap resumes where
 * it stopped instead of starting over, and a completed scan waits before the
 * next one. Nothing here concludes anything from a gap: a checkpoint records
 * how far a scan got, never that an object is absent.
 */

/** Streams a repository resource is reconciled through. */
export const SyncStream = Object.freeze(
  {
    Issues: "issues",
    PullRequests: "pull_requests",
    Checks: "checks",
  } as const,
);
export type SyncStream = (typeof SyncStream)[keyof typeof SyncStream];

/** Every stream, in the order `ensureCheckpoints` creates them. */
export const SYNC_STREAMS: readonly SyncStream[] = Object.freeze([
  SyncStream.Issues,
  SyncStream.PullRequests,
  SyncStream.Checks,
]);

export function isSyncStream(value: unknown): value is SyncStream {
  return typeof value === "string" &&
    (SYNC_STREAMS as readonly string[]).includes(value);
}

/**
 * Where a checkpoint stands. `idle`: no scan in progress (never run, or the
 * last one completed). `partial`: a scan is in progress and resumes at its
 * cursor. `blocked`: GitHub refused the permission the scan needs; it is
 * retried after `SYNC_BLOCKED_MS`.
 */
export const CheckpointStatus = Object.freeze(
  {
    Idle: "idle",
    Partial: "partial",
    Blocked: "blocked",
  } as const,
);
export type CheckpointStatus =
  (typeof CheckpointStatus)[keyof typeof CheckpointStatus];

/** Outcome codes a step stores on a checkpoint in `outcome_code`. */
export const SyncOutcomeCode = Object.freeze(
  {
    Completed: "completed",
    RequestCap: "request_cap",
    RateLimited: "rate_limited",
    ProviderError: "provider_error",
    PermissionMissing: "permission_missing",
    RepositoryMoved: "repository_moved",
    ChecksTruncated: "checks_truncated",
    Ineligible: "ineligible",
  } as const,
);
export type SyncOutcomeCode =
  (typeof SyncOutcomeCode)[keyof typeof SyncOutcomeCode];

/** A completed scan, a provider error and a moved repository wait this long. */
export const SYNC_REST_MS = 5 * 60_000;
/** A blocked checkpoint waits this long before it is armed again. */
export const SYNC_BLOCKED_MS = 30 * 60_000;
/**
 * A claimed checkpoint is not due again for this long, so a worker that died
 * mid-step leaves it to the next sweep after the lease and a live worker's
 * checkpoint is never claimed twice. A step that fails but can still reach the
 * database gives the lease back at once (`releaseCheckpoint`), so no failure
 * holds a checkpoint longer than this.
 */
export const SYNC_LEASE_MS = 10 * 60_000;
/** Requests one issues step makes before it leaves the scan `partial`. */
export const ISSUE_STEP_REQUESTS = 5;
/** Tracked rows one pull request or check step reads. */
export const KEYSET_BATCH = 25;
/** Checkpoints one sweep runs. */
export const MAX_SWEEP_CHECKPOINTS = 25;
/** An incremental scan starts this far before its high-water mark. */
export const ISSUE_WINDOW_OVERLAP_MS = 60_000;
/** GitHub's `since` has one-second resolution, so the edge steps back one. */
export const ISSUE_SINCE_STEP_MS = 1000;
/** Items one issue list request returns; the client fixes it. */
export const ISSUE_PAGE_SIZE = GITHUB_READ_PAGE_SIZE;

const GitHubTimeSchema = z.string().datetime({ offset: true }).describe(
  "ISO 8601 time at one-second resolution, as GitHub reports updated_at.",
);

/**
 * The cursor of the `issues` stream.
 *
 * A scan reads GitHub's issue list oldest update first. The `edge` is the
 * latest `updated_at` seen so far in the run; every request after the first
 * asks for items updated since one second before it, at page `k`. While a
 * page shows an item later than the edge the edge advances and `k` goes back
 * to 1, so a page offset only outlives a change of the list inside a walk.
 * Only a full page that holds nothing later than the edge, a run of at least
 * 50 issues inside two consecutive seconds, walks forward with `k + 1`.
 */
export const IssueCursorSchema = z.object({
  initial: z.boolean().describe(
    "True until the first scan completes: that scan lists open issues only and sends no since on its first request.",
  ),
  runStartedAt: GitHubTimeSchema.describe(
    "When the scan in progress began, at one-second resolution; an initial scan sets its high-water mark from this when it completes. An initial scan that stored a page, was blocked and started again keeps its first start.",
  ),
  edge: GitHubTimeSchema.nullable().describe(
    "Latest updated_at any page of the scan in progress showed; null until its first page. It only ever increases within a scan.",
  ),
  k: z.number().int().min(1).max(1_000_000).describe(
    "Page the next request asks for. 1 except while walking a full page that holds no item later than the edge.",
  ),
  highWater: GitHubTimeSchema.nullable().describe(
    "Latest update the last completed scan covered; the next scan starts 60 seconds before it. Null before the first scan completes.",
  ),
}).strict().describe(
  "Resume point of the issue scan of one repository: the scan kind, its start, its edge, its page offset and the previous scan's high-water mark.",
);
export type IssueCursor = z.output<typeof IssueCursorSchema>;

/** The cursor of a stream that rotates through the tracked pull requests. */
export const KeysetCursorSchema = z.object({
  after: z.string().uuid().nullable().describe(
    "Id of the last pull request row the rotation read; the next step takes rows with a greater id. Null starts a rotation from the first row.",
  ),
}).strict().describe(
  "Resume point of a pull request or check rotation: the id of the last tracked row read.",
);
export type KeysetCursor = z.output<typeof KeysetCursorSchema>;

/** GitHub-style time, whole seconds, UTC, for a millisecond instant. */
export function formatGitHubTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(
    ".000Z",
    "Z",
  );
}

/** The cursor of a checkpoint that never ran: an open-only backfill. */
export function initialIssueCursor(now: Date): IssueCursor {
  return {
    initial: true,
    runStartedAt: formatGitHubTime(now.getTime()),
    edge: null,
    k: 1,
    highWater: null,
  };
}

/**
 * The cursor a stored value that fails validation falls back to: an
 * incremental scan with no high-water mark, which lists every issue in every
 * state, so nothing the damaged cursor stood for is skipped.
 */
export function rescanIssueCursor(now: Date): IssueCursor {
  return { ...initialIssueCursor(now), initial: false };
}

/** Reads the stored cursor: absent is a backfill, unreadable is a full rescan. */
export function readIssueCursor(stored: unknown, now: Date): IssueCursor {
  if (stored === null || stored === undefined) return initialIssueCursor(now);
  const parsed = IssueCursorSchema.safeParse(stored);
  return parsed.success ? parsed.data : rescanIssueCursor(now);
}

/** Reads a rotation cursor; an unreadable one starts the rotation over. */
export function readKeysetCursor(stored: unknown): KeysetCursor {
  const parsed = KeysetCursorSchema.safeParse(stored);
  return parsed.success ? parsed.data : { after: null };
}

/**
 * The cursor of a scan a step claims `idle`: edge and offset reset, history
 * kept. Three cases arrive here.
 *
 * - A checkpoint that never ran or whose scan completed starts a new run, so
 *   `runStartedAt` is now.
 * - A `blocked` checkpoint armed again by `ensureCheckpoints` arrives with the
 *   cursor it was blocked at and starts over at page 1; every page is an
 *   idempotent upsert, so re-reading is safe. What it keeps depends on what
 *   the stopped attempt stored:
 *   - An initial backfill with an edge stored open-only pages (the first page
 *     sets the edge in the transaction that stores it). Its completion sets
 *     the high-water mark to `runStartedAt - 60 s`, so the next scan covers
 *     every change since the backfill began. An issue the first attempt
 *     stored `open` that closed before the restart is absent from the
 *     restarted open-only list, so the restart keeps the first attempt's
 *     start; a fresh one would put that closure outside the next window.
 *   - An initial backfill with no edge stored nothing, so a fresh start
 *     loses nothing and keeps the window narrow.
 *   - An incremental scan keeps its high-water mark, so its first request is
 *     again that mark minus 60 s and a restart loses nothing;
 *     `runStartedAt` plays no part in its completion.
 */
export function startIssueRun(cursor: IssueCursor, now: Date): IssueCursor {
  const keepsBackfillStart = cursor.initial && cursor.edge !== null;
  return {
    ...cursor,
    runStartedAt: keepsBackfillStart
      ? cursor.runStartedAt
      : formatGitHubTime(now.getTime()),
    edge: null,
    k: 1,
  };
}

/** One issue list request, before the client adds `per_page`, `sort` and `direction`. */
export type IssueRequest = {
  state: "open" | "all";
  /** ISO time for GitHub's `since`, or null to send none. */
  since: string | null;
  page: number;
};

/**
 * The request the cursor asks for next. The initial scan lists open issues,
 * the others every state. `since` is one second before the edge once the scan
 * has one (GitHub documents `since` only as "updated after" and times have
 * one-second resolution, so the step back makes an inclusive and an exclusive
 * boundary behave alike), else 60 seconds before the previous scan's
 * high-water mark, else none.
 */
export function issueRequest(cursor: IssueCursor): IssueRequest {
  let since: number | null = null;
  if (cursor.edge !== null) {
    since = Date.parse(cursor.edge) - ISSUE_SINCE_STEP_MS;
  } else if (!cursor.initial && cursor.highWater !== null) {
    since = Date.parse(cursor.highWater) - ISSUE_WINDOW_OVERLAP_MS;
  }
  return {
    state: cursor.initial ? "open" : "all",
    since: since === null ? null : formatGitHubTime(since),
    page: cursor.k,
  };
}

/** What `advanceIssueCursor` needs to know of one answered page. */
export type IssuePage = {
  items: readonly { updatedAt: string }[];
  hasNext: boolean;
};

export type IssueAdvance = {
  cursor: IssueCursor;
  /** True when the page ended the scan; the cursor is then the next scan's start. */
  completed: boolean;
};

/**
 * Moves the cursor past one answered page.
 *
 * The last page (no `rel="next"`, or no items at all, whatever the link
 * says) completes the scan: the high-water mark becomes the latest of itself,
 * the edge and the page's latest update (an initial scan lists no closed
 * issue, so its mark is the scan's start minus 60 seconds, which makes the
 * next scan cover every change since the backfill began), and the edge and
 * offset reset. Any other page either shows an item later than the edge,
 * which advances the edge (a missing edge counts as advanced) and puts the
 * offset back to 1, or is a full page that holds nothing later, a walk, which
 * moves to the next offset under the same `since`.
 *
 * Every request therefore completes the scan, strictly increases the edge or
 * increases the offset, so the loop cannot spin.
 *
 * A walk is the one place a list that shifts can hide an issue. The stride
 * is positional for a request with `page` greater than 1, so an edit or close
 * of a read, in-window issue made before such a request (an edit in the gap
 * after the page-1 request that starts the walk counts) moves that issue to
 * the end of GitHub's list, and the first issue not yet read slides into the
 * already-read range. That loses at most one unedited issue per such edit; the
 * next webhook for it, or any later scan whose window (high-water mark minus
 * 60 seconds) reaches it, observes it. An edit made before a page-1 request
 * loses nothing, because the edge advance restarts at page 1. A walk needs at
 * least 50 issues inside two consecutive seconds, so steady-state scans never
 * walk.
 */
export function advanceIssueCursor(
  cursor: IssueCursor,
  page: IssuePage,
): IssueAdvance {
  let latest: number | null = null;
  for (const item of page.items) {
    const time = Date.parse(item.updatedAt);
    if (!Number.isNaN(time) && (latest === null || time > latest)) {
      latest = time;
    }
  }
  if (!page.hasNext || page.items.length === 0) {
    const covered = [
      cursor.highWater === null ? null : Date.parse(cursor.highWater),
      cursor.edge === null ? null : Date.parse(cursor.edge),
      latest,
    ].filter((time): time is number => time !== null);
    const highWater = cursor.initial
      ? Date.parse(cursor.runStartedAt) - ISSUE_WINDOW_OVERLAP_MS
      : covered.length === 0
      ? null
      : Math.max(...covered);
    return {
      completed: true,
      cursor: {
        initial: false,
        runStartedAt: cursor.runStartedAt,
        edge: null,
        k: 1,
        highWater: highWater === null ? null : formatGitHubTime(highWater),
      },
    };
  }
  const edge = cursor.edge === null ? null : Date.parse(cursor.edge);
  if (latest !== null && (edge === null || latest > edge)) {
    return {
      completed: false,
      cursor: { ...cursor, edge: formatGitHubTime(latest), k: 1 },
    };
  }
  return { completed: false, cursor: { ...cursor, k: cursor.k + 1 } };
}

/** A checkpoint a worker holds the lease on. */
export type ClaimedCheckpoint = {
  id: string;
  organizationId: string;
  connectionId: string;
  installationId: string;
  resourceId: string;
  stream: SyncStream;
  /** Status before the claim: `idle` starts a scan, `partial` resumes one. */
  status: typeof CheckpointStatus.Idle | typeof CheckpointStatus.Partial;
  cursor: unknown;
  pagesRead: number;
  /** Row version after the claim; every later write must name it. */
  version: number;
};

type ClaimedRow = Omit<ClaimedCheckpoint, "stream" | "status"> & {
  stream: string;
  status: string;
};

/**
 * Creates the missing checkpoints and arms the blocked ones that are due.
 *
 * A checkpoint is inserted for every stream of every selected, available,
 * unarchived repository resource of an enabled connection on an enabled
 * installation; `on conflict do nothing` keeps existing ones and their
 * cursors. A `blocked` checkpoint whose wait is over, on an enabled
 * connection of an enabled installation, goes back to `idle`, so a restored
 * permission is retried without an event. This is a system sweep across
 * organizations; every join names the organization of the row it follows.
 */
export async function ensureCheckpoints(
  database: PgDatabase,
): Promise<{ created: number; rearmed: number }> {
  const created = await database.query(
    `insert into bakery.integration_sync_checkpoints (
       id, organization_id, connection_id, installation_id, resource_id,
       stream, status
     )
     select gen_random_uuid(), resource.organization_id,
            resource.connection_id, resource.installation_id, resource.id,
            stream.name, $2::text
       from bakery.integration_resources as resource
       join bakery.integration_connections as connection
         on connection.organization_id = resource.organization_id
        and connection.id = resource.connection_id
        and connection.installation_id = resource.installation_id
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
      cross join unnest($1::text[]) as stream(name)
      where resource.kind = 'repository' and resource.selected
        and resource.available and resource.archived_at is null
        and connection.status = 'enabled' and connection.archived_at is null
        and installation.status = 'enabled'
     on conflict (resource_id, stream) do nothing`,
    [SYNC_STREAMS, CheckpointStatus.Idle],
  );
  const rearmed = await database.query(
    `update bakery.integration_sync_checkpoints as checkpoint
        set status = $1, version = checkpoint.version + 1
       from bakery.integration_connections as connection,
            bakery.integration_installations as installation
      where checkpoint.status = $2 and checkpoint.not_before <= now()
        and connection.organization_id = checkpoint.organization_id
        and connection.id = checkpoint.connection_id
        and connection.installation_id = checkpoint.installation_id
        and connection.status = 'enabled' and connection.archived_at is null
        and installation.id = connection.installation_id
        and installation.status = 'enabled'`,
    [CheckpointStatus.Idle, CheckpointStatus.Blocked],
  );
  return { created: created.rowCount ?? 0, rearmed: rearmed.rowCount ?? 0 };
}

/**
 * Takes the lease on the due checkpoint that has waited longest since its
 * last completed scan (never-completed first, then by id), skipping rows
 * another worker is claiming. Due means `idle` or `partial` with `not_before`
 * reached, on a selected and available repository of an enabled connection
 * on an enabled installation: a resource that is no longer eligible is never
 * claimed. The claim moves `not_before` forward by the lease and bumps the
 * version, all in one statement, so two concurrent claims never return the
 * same row and a crashed worker's checkpoint is due again after the lease.
 * `excluding` lists checkpoints the caller already ran this sweep, so one
 * long scan cannot take every step of a sweep.
 */
export async function claimDueCheckpoint(
  database: PgDatabase,
  excluding: readonly string[] = [],
): Promise<ClaimedCheckpoint | null> {
  const claimed = await database.query<ClaimedRow>(
    `with due as (
       select checkpoint.id
         from bakery.integration_sync_checkpoints as checkpoint
         join bakery.integration_resources as resource
           on resource.organization_id = checkpoint.organization_id
          and resource.connection_id = checkpoint.connection_id
          and resource.id = checkpoint.resource_id
         join bakery.integration_connections as connection
           on connection.organization_id = checkpoint.organization_id
          and connection.id = checkpoint.connection_id
          and connection.installation_id = checkpoint.installation_id
         join bakery.integration_installations as installation
           on installation.id = connection.installation_id
        where checkpoint.status in ($2, $3) and checkpoint.not_before <= now()
          and checkpoint.id <> all ($4::uuid[])
          and resource.kind = 'repository' and resource.selected
          and resource.available and resource.archived_at is null
          and connection.status = 'enabled' and connection.archived_at is null
          and installation.status = 'enabled'
        order by checkpoint.last_completed_at nulls first, checkpoint.id
        limit 1
        for update of checkpoint skip locked
     )
     update bakery.integration_sync_checkpoints as checkpoint
        set not_before = now() + ($1::bigint * interval '1 millisecond'),
            last_started_at = case when checkpoint.status = $2
              then now() else checkpoint.last_started_at end,
            version = checkpoint.version + 1
       from due
      where checkpoint.id = due.id
      returning checkpoint.id, checkpoint.organization_id as "organizationId",
        checkpoint.connection_id as "connectionId",
        checkpoint.installation_id as "installationId",
        checkpoint.resource_id as "resourceId", checkpoint.stream,
        checkpoint.status, checkpoint.cursor,
        checkpoint.pages_read as "pagesRead", checkpoint.version`,
    [
      SYNC_LEASE_MS,
      CheckpointStatus.Idle,
      CheckpointStatus.Partial,
      [...excluding],
    ],
  );
  const row = claimed.rows[0];
  if (row === undefined || !isSyncStream(row.stream)) return null;
  if (
    row.status !== CheckpointStatus.Idle &&
    row.status !== CheckpointStatus.Partial
  ) return null;
  return { ...row, stream: row.stream, status: row.status };
}

/** The checkpoint a step wrote under was claimed by another worker meanwhile. */
export class CheckpointSuperseded extends Error {
  constructor() {
    super("SYNC_CHECKPOINT_SUPERSEDED");
    this.name = "CheckpointSuperseded";
  }
}

/** What one write leaves on a checkpoint. */
export type CheckpointWrite = {
  cursor: unknown;
  status: CheckpointStatus;
  outcomeCode: SyncOutcomeCode | null;
  /** Milliseconds from the database clock until the checkpoint is due; 0 is due at once. */
  waitMs: number;
  /** A completed scan: stamps `last_completed_at` and moves the generation. */
  completed: boolean;
  pagesRead: number;
};

/**
 * Gives back the lease of a claimed checkpoint whose step failed in a way it
 * could not settle (an abort, the database), so the checkpoint is due again
 * after `SYNC_REST_MS`, as after any other provider error, instead of after
 * the whole `SYNC_LEASE_MS`. Status, cursor and counts stay as the step last
 * committed them: a page already stored is kept and the scan resumes after it.
 * It applies only to the version the caller holds, so a checkpoint another
 * worker took over, or one the step already settled, is left alone. It never
 * throws, because the caller rethrows the failure it is answering; when the
 * release itself fails the lease runs out on its own. Returns whether the
 * lease was given back.
 */
export async function releaseCheckpoint(
  database: PgDatabase,
  identity: { organizationId: string; id: string },
  version: number,
): Promise<boolean> {
  try {
    const released = await database.query(
      `update bakery.integration_sync_checkpoints
          set outcome_code = $4,
              not_before = now() + ($5::bigint * interval '1 millisecond'),
              version = version + 1
        where organization_id = $1 and id = $2 and version = $3`,
      [
        identity.organizationId,
        identity.id,
        version,
        SyncOutcomeCode.ProviderError,
        SYNC_REST_MS,
      ],
    );
    return released.rowCount === 1;
  } catch {
    // The lease runs out by itself; the original failure is what the caller reports.
    console.warn(JSON.stringify({
      component: "integrations",
      event: "sync_checkpoint_release_failed",
      checkpointId: identity.id,
    }));
    return false;
  }
}

/**
 * Writes the cursor, status and wait of a claimed checkpoint, version + 1,
 * only while the version is still the one the writer holds. A write that
 * finds another version throws `CheckpointSuperseded`, so a transaction that
 * also stored facts rolls them back with it. Returns the new version.
 */
export async function writeCheckpoint(
  transaction: PgTransactionClient,
  identity: { organizationId: string; id: string },
  version: number,
  write: CheckpointWrite,
): Promise<number> {
  const updated = await transaction.query<{ version: number }>(
    `update bakery.integration_sync_checkpoints
        set cursor = $4::jsonb, status = $5, outcome_code = $6,
            not_before = now() + ($7::bigint * interval '1 millisecond'),
            generation = generation + $8::integer,
            last_completed_at = case when $9::boolean
              then now() else last_completed_at end,
            pages_read = $10, version = version + 1
      where organization_id = $1 and id = $2 and version = $3
      returning version`,
    [
      identity.organizationId,
      identity.id,
      version,
      JSON.stringify(write.cursor),
      write.status,
      write.outcomeCode,
      write.waitMs,
      write.completed ? 1 : 0,
      write.completed,
      write.pagesRead,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new CheckpointSuperseded();
  return row.version;
}
