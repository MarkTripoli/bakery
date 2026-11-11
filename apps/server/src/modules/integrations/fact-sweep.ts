import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { type AppCredentials, readAppCredentials } from "./callbacks.ts";
import {
  authorityDeniedAtWrite,
  checkRunFactOf,
  forgetFailedToken,
  installationNotEnabled,
  issueFactOf,
  MAX_CHECK_PAGES,
  mintReadToken,
  RouteOutcomeCode,
  type Subject,
} from "./fact-reads.ts";
import { DEFAULT_RATE_LIMIT_SECONDS, GitHubReadFailure } from "./github-app.ts";
import { InstallationStatus } from "./installation-fan-out.ts";
import {
  observePullRequest,
  PullRequestStatus,
  resolveRepositoryId,
} from "./pull-requests.ts";
import type { ReconcileDependencies } from "./reconcile.ts";
import {
  type FactWriteResult,
  type RemoteFact,
  upsertFact,
} from "./remote-facts.ts";
import {
  advanceIssueCursor,
  CheckpointStatus,
  CheckpointSuperseded,
  type CheckpointWrite,
  claimDueCheckpoint,
  type ClaimedCheckpoint,
  ensureCheckpoints,
  ISSUE_STEP_REQUESTS,
  issueRequest,
  isSyncStream,
  KEYSET_BATCH,
  MAX_SWEEP_CHECKPOINTS,
  readIssueCursor,
  readKeysetCursor,
  releaseCheckpoint,
  startIssueRun,
  SYNC_BLOCKED_MS,
  SYNC_LEASE_MS,
  SYNC_REST_MS,
  SyncOutcomeCode,
  SyncStream,
  writeCheckpoint,
} from "./sync-checkpoints.ts";

/**
 * Reconciliation sweep.
 *
 * Webhooks can be missed, so a cron function re-reads what Bakery tracks:
 * every selected repository has one checkpoint per stream. The `issues`
 * stream lists the repository's issues oldest update first with a keyset
 * cursor (see `advanceIssueCursor`); the `pull_requests` and `checks` streams
 * rotate through the open pull requests a task registered, 25 rows at a time,
 * by a keyset cursor over the row id. Every fact comes from a fresh provider
 * read and is stored through the ordered stores, so a sweep can never
 * overwrite newer state. A scan that fails, is rate limited or hits its cap
 * ends `partial` and resumes at its cursor. Nothing is ever marked closed,
 * gone or absent because a list did not show it, and pull request items on
 * the issue list are counted, never stored as issues.
 *
 * Authority is checked twice. Before every provider call the step rereads the
 * installation, connection and repository resource (`assertEligible`); then,
 * because a request can take seconds, the transaction that stores its answer
 * locks the same three rows `for share` and judges them again with the route
 * processor's `authorityVerdict` from `fact-reads.ts` (`guardWrite`). A
 * repository deselected, a
 * connection revoked or an installation suspended in between therefore leaves
 * no fact and no progress, and the checkpoint is parked `ineligible`.
 *
 * A scan cannot skip an unedited issue because the list shifted, except in the
 * documented offset-walk case: at least 50 issues inside two consecutive
 * seconds, with an edit or close of a read, in-window issue made before a
 * request with `page` greater than 1, which hides at most one unedited issue
 * per such edit from that scan.
 *
 * Nothing here admits a ticket, runs a check or writes to GitHub.
 */

/** Counts one step reports. */
export type StepTally = {
  /** Provider requests made. */
  requests: number;
  written: number;
  unchanged: number;
  stale: number;
  /** Check runs left out: no time to order them by, or another commit. */
  skipped: number;
  /** Items of the issue list that were pull requests: counted, never stored as issues. */
  pullRequestItems: number;
  /** Tracked pull request rows the step read. */
  rows: number;
  /** Rows whose read found the object gone; nothing is concluded from that. */
  gone: number;
  /** Heads whose check run list was cut off at the page cap. */
  truncated: number;
};

const emptyTally = (): StepTally => ({
  requests: 0,
  written: 0,
  unchanged: 0,
  stale: 0,
  skipped: 0,
  pullRequestItems: 0,
  rows: 0,
  gone: 0,
  truncated: 0,
});

function addWrite(tally: StepTally, result: FactWriteResult): void {
  tally[result] += 1;
}

export type StepOutcome =
  | { kind: "skipped"; reason: "not_found" | "superseded" | "not_runnable" }
  | {
    kind: "stepped";
    checkpointId: string;
    stream: SyncStream;
    /** Status the checkpoint was left in. */
    status: CheckpointStatus;
    code: SyncOutcomeCode;
    /** Why a checkpoint was not read: the live authority it needs no longer holds. */
    reason: string | null;
    /** Milliseconds from now until the checkpoint is due again; 0 is at once. */
    waitMs: number;
    tally: StepTally;
  };

/** What a step reads again, from Bakery's own rows, before it calls GitHub. */
type Eligibility = {
  connectionStatus: string;
  connectionInstallationId: string;
  installationStatus: string;
  installationExternalId: string;
  registrationId: string;
  resourceExternalId: string;
  displayName: string;
  /** The resource is selected and still available to the installation. */
  selected: boolean;
};

/** The reason a checkpoint must not be read, or null when its authority holds. */
function eligibilityVerdict(
  checkpoint: Pick<ClaimedCheckpoint, "installationId">,
  eligibility: Eligibility | undefined,
): string | null {
  if (eligibility === undefined) return RouteOutcomeCode.UnselectedRepository;
  if (eligibility.connectionStatus !== "enabled") {
    return RouteOutcomeCode.ConnectionNotEnabled;
  }
  if (eligibility.connectionInstallationId !== checkpoint.installationId) {
    return RouteOutcomeCode.ConnectionChanged;
  }
  if (eligibility.installationStatus !== InstallationStatus.Enabled) {
    return installationNotEnabled(eligibility.installationStatus);
  }
  if (!eligibility.selected) return RouteOutcomeCode.UnselectedRepository;
  return null;
}

const ELIGIBILITY_SQL = `select connection.status as "connectionStatus",
       connection.installation_id as "connectionInstallationId",
       installation.status as "installationStatus",
       installation.external_authorization_id as "installationExternalId",
       installation.registration_id as "registrationId",
       resource.external_id as "resourceExternalId",
       resource.display_name as "displayName",
       (resource.selected and resource.available) as selected
  from bakery.integration_resources as resource
  join bakery.integration_connections as connection
    on connection.organization_id = resource.organization_id
   and connection.id = resource.connection_id
   and connection.archived_at is null
  join bakery.integration_installations as installation
    on installation.id = connection.installation_id
 where resource.organization_id = $1 and resource.connection_id = $2
   and resource.id = $3 and resource.kind = 'repository'
   and resource.archived_at is null`;

async function readEligibility(
  queryable: PgTransactionClient,
  checkpoint: ClaimedCheckpoint,
): Promise<Eligibility | undefined> {
  const found = await queryable.query<Eligibility>(ELIGIBILITY_SQL, [
    checkpoint.organizationId,
    checkpoint.connectionId,
    checkpoint.resourceId,
  ]);
  return found.rows[0];
}

/** Everything one step needs about the authority of its checkpoint. */
type SweepAuthority = {
  eligibility: Eligibility;
  credentials: AppCredentials | null;
  /** Broker generation captured before this state was read. */
  generation: number;
  /** The Bakery repository of the resource; read for the pull request and check streams only. */
  repositoryId: string | null;
};

type Loaded =
  | { verdict: string }
  | { verdict: null; authority: SweepAuthority };

/**
 * Reads the live state a checkpoint is rechecked against, in one read-only
 * transaction. The broker generation is captured first, so an edit of the
 * connection that commits afterwards refuses the token mint.
 */
async function loadAuthority(
  dependencies: ReconcileDependencies,
  checkpoint: ClaimedCheckpoint,
): Promise<Loaded> {
  const generation = dependencies.broker.generation(checkpoint.connectionId);
  return await withPgTransaction(
    dependencies.database,
    async (transaction): Promise<Loaded> => {
      const eligibility = await readEligibility(transaction, checkpoint);
      const verdict = eligibilityVerdict(checkpoint, eligibility);
      if (verdict !== null || eligibility === undefined) {
        return { verdict: verdict ?? RouteOutcomeCode.UnselectedRepository };
      }
      const repositoryId = checkpoint.stream === SyncStream.Issues
        ? null
        : await resolveRepositoryId(transaction, {
          organizationId: checkpoint.organizationId,
          connectionId: checkpoint.connectionId,
          externalId: eligibility.resourceExternalId,
          displayName: eligibility.displayName,
        });
      return {
        verdict: null,
        authority: {
          eligibility,
          credentials: await readAppCredentials(transaction),
          generation,
          repositoryId,
        },
      };
    },
  );
}

/** The live authority no longer holds; the step stops before its next provider call. */
class Ineligible extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("SYNC_CHECKPOINT_INELIGIBLE");
    this.name = "Ineligible";
    this.reason = reason;
  }
}

/** GitHub answered 301 or 308 for a repository path: the repository moved. */
class RepositoryMoved extends Error {
  constructor() {
    super("SYNC_REPOSITORY_MOVED");
    this.name = "RepositoryMoved";
  }
}

/** What a step keeps while it runs and what a stop needs to leave the checkpoint right. */
type Progress = {
  dependencies: ReconcileDependencies;
  checkpoint: ClaimedCheckpoint;
  signal: AbortSignal;
  tally: StepTally;
  /** Row version the next write must name. */
  version: number;
  /** The cursor as last committed; the stored one until the step commits. */
  cursor: unknown;
  pagesRead: number;
  /** Whether the step committed any progress, so a stop leaves `partial`. */
  committed: boolean;
};

type Step = Progress & {
  authority: SweepAuthority;
  /** Set while the step holds a token, so a provider failure drops it. */
  token: string | null;
};

/**
 * Writes the checkpoint inside `transaction`, keeps the version current and
 * records the progress, so a later stop resumes after it.
 */
async function commit(
  progress: Progress,
  transaction: PgTransactionClient,
  write: CheckpointWrite,
): Promise<void> {
  progress.version = await writeCheckpoint(
    transaction,
    {
      organizationId: progress.checkpoint.organizationId,
      id: progress.checkpoint.id,
    },
    progress.version,
    write,
  );
  progress.cursor = write.cursor;
  progress.pagesRead = write.pagesRead;
  progress.committed = true;
}

/**
 * Rechecks the live authority before a provider call: the installation,
 * connection and repository resource must still be enabled, selected and
 * available, and the connection must not have been edited since the token's
 * generation was captured. Throws `Ineligible`, which parks the checkpoint
 * without the call.
 */
async function assertEligible(step: Step): Promise<void> {
  step.signal.throwIfAborted();
  const { dependencies, checkpoint, authority } = step;
  const verdict = eligibilityVerdict(
    checkpoint,
    await readEligibility(dependencies.database, checkpoint),
  );
  if (verdict !== null) throw new Ineligible(verdict);
  if (
    !dependencies.broker.isCurrent(
      checkpoint.connectionId,
      authority.generation,
    )
  ) throw new Ineligible(RouteOutcomeCode.ConnectionChanged);
}

/** The event whose rules `authorityVerdict` applies to a stream, as a route of that event would. */
const STREAM_EVENT = {
  [SyncStream.Issues]: "issues",
  [SyncStream.PullRequests]: "pull_request",
  [SyncStream.Checks]: "check_run",
} as const satisfies Record<SyncStream, string>;

/**
 * Re-tests the live authority inside the transaction that is about to store a
 * provider read, as the route processor does for its own writes. The checks
 * before a request (`assertEligible`) cannot cover the seconds the request
 * takes, so a repository deselected, an unavailable one, a revoked connection
 * or a suspended installation in the meantime must leave no fact and no
 * progress. The three rows are locked `for share`, in the order the reconcile
 * and the discovery take theirs, and `authorityVerdict` judges them. Throws
 * `Ineligible`, which rolls the transaction back and parks the checkpoint at
 * the cursor it last committed.
 */
async function guardWrite(
  step: Progress,
  transaction: PgTransactionClient,
): Promise<void> {
  const { checkpoint } = step;
  const denied = await authorityDeniedAtWrite(transaction, {
    organizationId: checkpoint.organizationId,
    connectionId: checkpoint.connectionId,
    installationId: checkpoint.installationId,
    resourceId: checkpoint.resourceId,
    purpose: "fact_refresh",
    eventKind: STREAM_EVENT[checkpoint.stream],
  });
  if (denied !== null) throw new Ineligible(denied);
}

const settled = (
  progress: Progress,
  status: CheckpointStatus,
  code: SyncOutcomeCode,
  waitMs: number,
  reason: string | null = null,
): StepOutcome => ({
  kind: "stepped",
  checkpointId: progress.checkpoint.id,
  stream: progress.checkpoint.stream,
  status,
  code,
  reason,
  waitMs,
  tally: progress.tally,
});

/** Writes the state a stopped step leaves, logs the code, and reports it. */
async function stop(
  progress: Progress,
  code: SyncOutcomeCode,
  status: CheckpointStatus,
  waitMs: number,
  reason: string | null = null,
): Promise<StepOutcome> {
  await withPgTransaction(
    progress.dependencies.database,
    (transaction) =>
      commit(progress, transaction, {
        cursor: progress.cursor,
        status,
        outcomeCode: code,
        waitMs,
        completed: false,
        pagesRead: progress.pagesRead,
      }),
  );
  // The code and ids only: never GitHub's answer, a token or a payload.
  console.warn(JSON.stringify({
    component: "integrations",
    event: "fact_sweep_step",
    checkpointId: progress.checkpoint.id,
    stream: progress.checkpoint.stream,
    code,
  }));
  return settled(progress, status, code, waitMs, reason);
}

type Tracked = { id: string; providerNumber: number; headSha: string };

/**
 * The next batch of open pull requests a task registered in the repository,
 * by id after the keyset cursor. A rotation reads only rows Bakery tracks, so
 * it never adopts a pull request GitHub merely mentions.
 */
async function trackedRows(
  database: PgDatabase,
  scope: { organizationId: string; repositoryId: string },
  after: string | null,
): Promise<Tracked[]> {
  const found = await database.query<Tracked>(
    `select id, provider_number as "providerNumber", head_sha as "headSha"
       from bakery.pull_requests
      where organization_id = $1 and repository_id = $2 and status = $3
        and ($4::uuid is null or id > $4::uuid)
      order by id
      limit $5`,
    [
      scope.organizationId,
      scope.repositoryId,
      PullRequestStatus.Open,
      after,
      KEYSET_BATCH,
    ],
  );
  return found.rows;
}

/** The scan read everything its stream had: complete it and rest. */
async function completeEmpty(step: Step): Promise<StepOutcome> {
  await withPgTransaction(
    step.dependencies.database,
    (transaction) =>
      commit(step, transaction, {
        cursor: { after: null },
        status: CheckpointStatus.Idle,
        outcomeCode: SyncOutcomeCode.Completed,
        waitMs: SYNC_REST_MS,
        completed: true,
        pagesRead: 0,
      }),
  );
  return settled(
    step,
    CheckpointStatus.Idle,
    SyncOutcomeCode.Completed,
    SYNC_REST_MS,
  );
}

// ------------------------------------------------------------------- issues

/**
 * The issue scan. Each request is one page; its facts and the advanced cursor
 * commit in one transaction, so a crash re-reads at most that page (an
 * idempotent upsert). The step stops after five requests with the scan
 * `partial` and the cursor kept.
 */
async function issuesStep(step: Step, token: string): Promise<StepOutcome> {
  const { dependencies, checkpoint, authority } = step;
  const scope = {
    organizationId: checkpoint.organizationId,
    resourceId: checkpoint.resourceId,
  };
  // An idle checkpoint is a new run, or a blocked one armed again; the cursor
  // helper tells them apart by what the stopped scan stored.
  const starting = checkpoint.status === CheckpointStatus.Idle;
  let cursor = readIssueCursor(checkpoint.cursor, new Date());
  if (starting) cursor = startIssueRun(cursor, new Date());
  let pagesRead = starting ? 0 : checkpoint.pagesRead;
  for (let request = 1; request <= ISSUE_STEP_REQUESTS; request++) {
    await assertEligible(step);
    const next = issueRequest(cursor);
    // Taken before the request, so an item the page shows is never older than this.
    const observedStartedAt = new Date();
    const page = await dependencies.github.listRepositoryIssues({
      token,
      fullName: authority.eligibility.displayName,
      state: next.state,
      ...(next.since === null ? {} : { since: next.since }),
      page: next.page,
    }, step.signal);
    step.tally.requests += 1;
    const advance = advanceIssueCursor(cursor, page);
    const facts: RemoteFact[] = [];
    let pullRequestItems = 0;
    for (const item of page.items) {
      if (item.kind === "pull_request") pullRequestItems += 1;
      else facts.push(issueFactOf(scope, item, observedStartedAt));
    }
    pagesRead += 1;
    const capped = !advance.completed && request === ISSUE_STEP_REQUESTS;
    const writes = await withPgTransaction(
      dependencies.database,
      async (transaction) => {
        await guardWrite(step, transaction);
        const results: FactWriteResult[] = [];
        for (const fact of facts) {
          results.push(await upsertFact(transaction, fact));
        }
        await commit(step, transaction, {
          cursor: advance.cursor,
          status: advance.completed
            ? CheckpointStatus.Idle
            : CheckpointStatus.Partial,
          outcomeCode: advance.completed
            ? SyncOutcomeCode.Completed
            : capped
            ? SyncOutcomeCode.RequestCap
            : null,
          // A step in progress keeps its lease; a finished one names its wait.
          waitMs: advance.completed ? SYNC_REST_MS : capped ? 0 : SYNC_LEASE_MS,
          completed: advance.completed,
          pagesRead,
        });
        return results;
      },
    );
    for (const result of writes) addWrite(step.tally, result);
    step.tally.pullRequestItems += pullRequestItems;
    cursor = advance.cursor;
    if (advance.completed) {
      return settled(
        step,
        CheckpointStatus.Idle,
        SyncOutcomeCode.Completed,
        SYNC_REST_MS,
      );
    }
    if (capped) {
      return settled(
        step,
        CheckpointStatus.Partial,
        SyncOutcomeCode.RequestCap,
        0,
      );
    }
  }
  throw new Error("SYNC_ISSUE_STEP_UNREACHABLE");
}

// ------------------------------------------------- pull requests and checks

/**
 * Keeps a rotation moving past a row that failed, in its read or in the
 * transaction that stores it, so one poisoned row (a head GitHub no longer
 * knows, an answer the store rejects) cannot hold the rest back: the row is
 * skipped until the next rotation. A rate limit retries the same row, a
 * missing permission blocks the stream, an authority that no longer holds
 * parks the checkpoint as it was, and an abort is no failure of the row, so
 * none of them skips.
 */
function skipFailedRow(step: Step, row: Tracked, error: unknown): void {
  if (error instanceof Ineligible) return;
  if (
    error instanceof GitHubReadFailure &&
    (error.kind === "rate_limited" || error.kind === "forbidden")
  ) return;
  if (step.signal.aborted) return;
  // Applied by the stop that follows; nothing is written here.
  step.cursor = { after: row.id };
  step.pagesRead += 1;
  step.committed = true;
}

/**
 * The write that ends the row at `index`: the last row of a batch that
 * reached the end of the tracked rows completes the rotation (the cursor
 * wraps to the start), the last row of a full batch leaves it `partial`, and
 * every other row keeps the lease.
 */
function rowWrite(
  step: Step,
  rows: readonly Tracked[],
  index: number,
): CheckpointWrite {
  const row = rows[index];
  const pagesRead = step.pagesRead + 1;
  if (index < rows.length - 1) {
    return {
      cursor: { after: row.id },
      status: CheckpointStatus.Partial,
      outcomeCode: null,
      waitMs: SYNC_LEASE_MS,
      completed: false,
      pagesRead,
    };
  }
  if (rows.length < KEYSET_BATCH) {
    return {
      cursor: { after: null },
      status: CheckpointStatus.Idle,
      outcomeCode: step.tally.truncated > 0
        ? SyncOutcomeCode.ChecksTruncated
        : SyncOutcomeCode.Completed,
      waitMs: SYNC_REST_MS,
      completed: true,
      pagesRead,
    };
  }
  return {
    cursor: { after: row.id },
    status: CheckpointStatus.Partial,
    outcomeCode: SyncOutcomeCode.RequestCap,
    waitMs: 0,
    completed: false,
    pagesRead,
  };
}

function rowOutcome(step: Step, write: CheckpointWrite): StepOutcome {
  return settled(
    step,
    write.status,
    write.outcomeCode ?? SyncOutcomeCode.RequestCap,
    write.waitMs,
  );
}

/**
 * The pull request rotation: up to 25 open tracked rows after the cursor,
 * each read fresh and stored when newer. A pull request GitHub answers 404 or
 * 410 for is counted and nothing else: the stores keep no gone state for a
 * pull request and a missing object proves nothing. A moved repository path
 * ends the step.
 */
async function pullRequestsStep(
  step: Step,
  rows: readonly Tracked[],
  token: string,
): Promise<StepOutcome> {
  const { dependencies, checkpoint, authority } = step;
  const repositoryId = authority.repositoryId!;
  let last: CheckpointWrite | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    await assertEligible(step);
    const observedStartedAt = new Date();
    let read;
    try {
      read = await dependencies.github.readPullRequest({
        token,
        fullName: authority.eligibility.displayName,
        number: row.providerNumber,
      }, step.signal);
    } catch (error) {
      skipFailedRow(step, row, error);
      throw error;
    }
    step.tally.requests += 1;
    step.tally.rows += 1;
    if ("kind" in read && read.kind === "moved") throw new RepositoryMoved();
    const write = rowWrite(step, rows, index);
    try {
      await withPgTransaction(dependencies.database, async (transaction) => {
        await guardWrite(step, transaction);
        if ("kind" in read) {
          step.tally.gone += 1;
        } else if (read.number !== row.providerNumber) {
          step.tally.skipped += 1;
        } else {
          try {
            addWrite(
              step.tally,
              await observePullRequest(transaction, repositoryId, {
                organizationId: checkpoint.organizationId,
                number: read.number,
                state: read.state,
                merged: read.merged,
                url: read.url,
                headSha: read.headSha,
                baseSha: read.baseSha,
                mergedSha: read.mergedSha,
                providerUpdatedAt: new Date(read.updatedAt),
                observedStartedAt,
              }),
            );
          } catch (error) {
            // Unregistered since the batch was read: nothing to keep.
            if (
              !(error instanceof StandardError &&
                error.code === "RESOURCE_NOT_FOUND")
            ) throw error;
            step.tally.skipped += 1;
          }
        }
        await commit(step, transaction, write);
      });
    } catch (error) {
      // The row's own write failed (for example an answer the store rejects).
      skipFailedRow(step, row, error);
      throw error;
    }
    last = write;
  }
  return rowOutcome(step, last!);
}

/**
 * The check rotation: for up to 25 open tracked pull requests, the check
 * runs of the head (up to four pages of 50), each stored when newer. A head
 * shared by two rows is read once. A list cut off at the page cap is counted
 * as truncated and the runs it did not reach stay unknown, never passed.
 */
async function checksStep(
  step: Step,
  rows: readonly Tracked[],
  token: string,
): Promise<StepOutcome> {
  const { dependencies, checkpoint, authority } = step;
  const scope = {
    organizationId: checkpoint.organizationId,
    resourceId: checkpoint.resourceId,
  };
  const heads = new Set<string>();
  let last: CheckpointWrite | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const facts: RemoteFact[] = [];
    if (!heads.has(row.headSha)) {
      heads.add(row.headSha);
      step.tally.rows += 1;
      let truncated = false;
      for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
        await assertEligible(step);
        // Taken before the request, so a run the page shows is never older than this.
        const observedStartedAt = new Date();
        let result;
        try {
          result = await dependencies.github.listCheckRuns({
            token,
            fullName: authority.eligibility.displayName,
            headSha: row.headSha,
            page,
          }, step.signal);
        } catch (error) {
          skipFailedRow(step, row, error);
          throw error;
        }
        step.tally.requests += 1;
        for (const run of result.checkRuns) {
          const fact = checkRunFactOf(
            scope,
            row.headSha,
            run,
            observedStartedAt,
          );
          if (fact === null) step.tally.skipped += 1;
          else facts.push(fact);
        }
        if (!result.hasNext) break;
        if (page === MAX_CHECK_PAGES) truncated = true;
      }
      if (truncated) step.tally.truncated += 1;
    }
    const write = rowWrite(step, rows, index);
    try {
      await withPgTransaction(dependencies.database, async (transaction) => {
        await guardWrite(step, transaction);
        for (const fact of facts) {
          addWrite(step.tally, await upsertFact(transaction, fact));
        }
        await commit(step, transaction, write);
      });
    } catch (error) {
      // The row's own write failed: skip its head until the next rotation.
      skipFailedRow(step, row, error);
      throw error;
    }
    last = write;
  }
  return rowOutcome(step, last!);
}

// ---------------------------------------------------------------- the step

/** The permission scope each stream reads with. */
const SUBJECTS: Record<SyncStream, Subject> = {
  [SyncStream.Issues]: "issue",
  [SyncStream.PullRequests]: "pull_request",
  [SyncStream.Checks]: "check",
};

/**
 * Turns a failure into the state the checkpoint is left in. A rate limit
 * leaves the scan `partial` and waits as long as GitHub said; a forbidden
 * read blocks the checkpoint for 30 minutes; a moved repository or any other
 * failure leaves it `partial` for 5 minutes. A live authority that no longer
 * holds (the connection edited, the resource deselected or removed) parks the
 * checkpoint in the status it was claimed in, 5 minutes out, or `partial`
 * when the step had already committed pages. An aborted request is not a
 * failure of the checkpoint: it propagates.
 */
async function failure(
  step: Progress,
  error: unknown,
): Promise<StepOutcome> {
  step.signal.throwIfAborted();
  const parked = step.committed
    ? CheckpointStatus.Partial
    : step.checkpoint.status;
  if (error instanceof Ineligible) {
    return await stop(
      step,
      SyncOutcomeCode.Ineligible,
      parked,
      SYNC_REST_MS,
      error.reason,
    );
  }
  if (error instanceof RepositoryMoved) {
    return await stop(
      step,
      SyncOutcomeCode.RepositoryMoved,
      CheckpointStatus.Partial,
      SYNC_REST_MS,
    );
  }
  if (error instanceof GitHubReadFailure && error.kind === "rate_limited") {
    const seconds = error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS;
    return await stop(
      step,
      SyncOutcomeCode.RateLimited,
      CheckpointStatus.Partial,
      seconds * 1000,
    );
  }
  if (error instanceof GitHubReadFailure && error.kind === "forbidden") {
    return await stop(
      step,
      SyncOutcomeCode.PermissionMissing,
      CheckpointStatus.Blocked,
      SYNC_BLOCKED_MS,
    );
  }
  if (
    error instanceof StandardError &&
    (error.code === "RESOURCE_NOT_FOUND" || error.code === "STATE_CONFLICT")
  ) {
    return await stop(
      step,
      SyncOutcomeCode.Ineligible,
      parked,
      SYNC_REST_MS,
      error.code === "STATE_CONFLICT"
        ? RouteOutcomeCode.ConnectionChanged
        : RouteOutcomeCode.UnselectedRepository,
    );
  }
  return await stop(
    step,
    SyncOutcomeCode.ProviderError,
    CheckpointStatus.Partial,
    SYNC_REST_MS,
  );
}

/** Runs the stream the checkpoint belongs to; throws for `failure` to classify. */
async function run(step: Step): Promise<StepOutcome> {
  const { checkpoint, authority, dependencies } = step;
  const stream = checkpoint.stream;
  const idle = checkpoint.status === CheckpointStatus.Idle;
  let rows: Tracked[] = [];
  if (stream === SyncStream.Issues) {
    // A new scan counts its pages from zero.
    if (idle) step.pagesRead = 0;
  } else {
    // A completed rotation stores the start of the next, so the stored cursor
    // is where this one begins; a blocked checkpoint armed again keeps the row
    // its rotation stopped at instead of reading the first rows twice.
    const keyset = readKeysetCursor(checkpoint.cursor);
    // A rotation that starts at the first row counts its rows from zero.
    if (idle && keyset.after === null) step.pagesRead = 0;
    if (authority.repositoryId !== null) {
      rows = await trackedRows(dependencies.database, {
        organizationId: checkpoint.organizationId,
        repositoryId: authority.repositoryId,
      }, keyset.after);
    }
    // An unmapped repository, or a rotation with nothing left to read, ends
    // the scan without a token or a provider call.
    if (rows.length === 0) return await completeEmpty(step);
  }
  const { eligibility } = authority;
  const minted = await mintReadToken(
    dependencies,
    {
      connectionId: checkpoint.connectionId,
      generation: authority.generation,
      connection: { status: eligibility.connectionStatus },
      installation: {
        status: eligibility.installationStatus,
        externalId: eligibility.installationExternalId,
        registrationId: eligibility.registrationId,
      },
      resource: { externalId: eligibility.resourceExternalId },
      credentials: authority.credentials,
    },
    SUBJECTS[stream],
    step.signal,
  );
  if (minted.kind === "refused") {
    return await stop(
      step,
      SyncOutcomeCode.PermissionMissing,
      CheckpointStatus.Blocked,
      SYNC_BLOCKED_MS,
    );
  }
  step.token = minted.token;
  switch (stream) {
    case SyncStream.Issues:
      return await issuesStep(step, minted.token);
    case SyncStream.PullRequests:
      return await pullRequestsStep(step, rows, minted.token);
    case SyncStream.Checks:
      return await checksStep(step, rows, minted.token);
  }
}

type CheckpointRow = Omit<ClaimedCheckpoint, "stream" | "status"> & {
  stream: string;
  status: string;
};

async function loadCheckpoint(
  database: PgDatabase,
  checkpointId: string,
): Promise<CheckpointRow | null> {
  const found = await database.query<CheckpointRow>(
    `select id, organization_id as "organizationId",
       connection_id as "connectionId", installation_id as "installationId",
       resource_id as "resourceId", stream, status, cursor,
       pages_read as "pagesRead", version
       from bakery.integration_sync_checkpoints
      where id = $1`,
    [checkpointId],
  );
  return found.rows[0] ?? null;
}

const superseded: StepOutcome = { kind: "skipped", reason: "superseded" };

/**
 * The body of a step: recheck the live authority, run the stream, and turn
 * every failure it can classify into the state the checkpoint is left in.
 * What it cannot settle (an abort, the database failing while the state is
 * written) it throws. `held` always names the progress object that holds the
 * newest version the step wrote, for the caller's release.
 */
async function attempt(
  dependencies: ReconcileDependencies,
  progress: Progress,
  held: { current: Progress },
  signal: AbortSignal,
): Promise<StepOutcome> {
  const { checkpoint } = progress;
  let step: Step | null = null;
  try {
    const loaded = await loadAuthority(dependencies, checkpoint);
    if (loaded.verdict !== null) {
      // Parked before any provider call.
      return await stop(
        progress,
        SyncOutcomeCode.Ineligible,
        checkpoint.status,
        SYNC_REST_MS,
        loaded.verdict,
      );
    }
    step = { ...progress, authority: loaded.authority, token: null };
    held.current = step;
    return await run(step);
  } catch (error) {
    if (error instanceof CheckpointSuperseded) return superseded;
    // Only GitHub's own failures count against a token.
    const providerFailure = error instanceof GitHubReadFailure ||
      (error instanceof StandardError &&
        error.code === "DEPENDENCY_UNAVAILABLE");
    if (step !== null && step.token !== null && providerFailure) {
      forgetFailedToken(
        dependencies,
        checkpoint.connectionId,
        step.token,
        error,
        signal,
      );
    }
    try {
      return await failure(step ?? progress, error);
    } catch (settling) {
      if (settling instanceof CheckpointSuperseded) return superseded;
      throw settling;
    }
  }
}

/**
 * Runs one step of a checkpoint: recheck the live authority, then at most
 * five issue list requests, or up to 25 tracked pull request rows, committing
 * the cursor after each page or row. The checkpoint id is the only input;
 * every later query takes its organization from the stored row. A checkpoint
 * whose resource is no longer eligible is parked without a provider call, and
 * so is one that stops being eligible while a request is in flight: every
 * write rechecks it first (`guardWrite`).
 *
 * Writes name the version the claim produced, so a step whose lease was taken
 * over changes nothing. A failure the step cannot settle (an abort, the
 * database failing while it parks the checkpoint) gives the lease back before
 * it is rethrown, so the checkpoint is due again in `SYNC_REST_MS` with its
 * cursor and counts as last committed, and no failure holds it for the whole
 * `SYNC_LEASE_MS`; a lease the release cannot reach still runs out by itself.
 */
export async function runStreamStep(
  dependencies: ReconcileDependencies,
  checkpointId: string,
  signal: AbortSignal,
): Promise<StepOutcome> {
  const row = await loadCheckpoint(dependencies.database, checkpointId);
  if (row === null) return { kind: "skipped", reason: "not_found" };
  if (
    !isSyncStream(row.stream) ||
    (row.status !== CheckpointStatus.Idle &&
      row.status !== CheckpointStatus.Partial)
  ) return { kind: "skipped", reason: "not_runnable" };
  const checkpoint: ClaimedCheckpoint = {
    ...row,
    stream: row.stream,
    status: row.status,
  };
  const progress: Progress = {
    dependencies,
    checkpoint,
    signal,
    tally: emptyTally(),
    version: checkpoint.version,
    cursor: checkpoint.cursor,
    pagesRead: checkpoint.pagesRead,
    committed: false,
  };
  const held = { current: progress };
  try {
    return await attempt(dependencies, progress, held, signal);
  } catch (error) {
    await releaseCheckpoint(
      dependencies.database,
      { organizationId: checkpoint.organizationId, id: checkpoint.id },
      held.current.version,
    );
    throw error;
  }
}

// ------------------------------------------------------------------- sweep

const SWEEP_FUNCTION_ID = "bakery-integration-fact-sweep";

/** What one claim-and-run of a sweep reports. */
export type SweepStepResult = {
  checkpointId: string;
  outcome: StepOutcome;
};

/**
 * Claims the next due checkpoint that this sweep has not run yet and runs one
 * step on it. Null when nothing is due.
 */
export async function sweepNext(
  dependencies: ReconcileDependencies,
  alreadyRun: readonly string[],
  signal: AbortSignal,
): Promise<SweepStepResult | null> {
  const claimed = await claimDueCheckpoint(dependencies.database, alreadyRun);
  if (claimed === null) return null;
  return {
    checkpointId: claimed.id,
    outcome: await runStreamStep(dependencies, claimed.id, signal),
  };
}

/**
 * Every five minutes, creates the missing checkpoints, arms the blocked ones
 * that are due, and runs one step on each of up to 25 due checkpoints, one
 * `step.run` per checkpoint so a retry repeats only the unfinished one. The
 * order is by last completed scan, never-completed first, and each
 * checkpoint runs at most once per sweep, so a long scan cannot starve the
 * others. One sweep runs at a time.
 */
export function createIntegrationFactSweep(
  options: ReconcileDependencies & { client: Inngest },
) {
  const { client, ...dependencies } = options;
  return client.createFunction(
    {
      id: SWEEP_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "*/5 * * * *" }],
    },
    async ({ step }) => {
      const ensured = await step.run(
        "ensure-sync-checkpoints",
        () => ensureCheckpoints(dependencies.database),
      );
      const ran: string[] = [];
      const outcomes: Record<string, number> = {};
      for (let index = 0; index < MAX_SWEEP_CHECKPOINTS; index++) {
        const result = await step.run(
          `sync-checkpoint-${index}`,
          () => sweepNext(dependencies, ran, new AbortController().signal),
        );
        if (result === null) break;
        ran.push(result.checkpointId);
        const key = result.outcome.kind === "stepped"
          ? result.outcome.code
          : result.outcome.reason;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
      }
      return { ...ensured, ran: ran.length, outcomes };
    },
  );
}
