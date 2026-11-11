import { StandardError } from "@bakery/contracts/http";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import {
  type AdmissionDeps,
  type AdmissionKind,
  admitTicket,
  assertDeps,
  type RecheckAction,
  recheckTicket,
} from "./ticket-admission.ts";
import { requestedIntentFromLabels } from "./ticket-policy.ts";
import { prefetchTicketReads, type TicketPrefetch } from "./ticket-prefetch.ts";
import {
  findTicketForNumber,
  listRotationNumbers,
  lockSourceForUpdate,
  readSourceHandle,
  type TicketSource,
  type TicketSyncCheckpoint,
  type TicketSyncHealth,
  writeRefusedAttempt,
  writeSyncProgress,
} from "./ticket-store.ts";
import type {
  TicketFactIndex,
  TicketReadFailure,
  TicketSourceHandle,
} from "./ticket-source-reader.ts";

/**
 * The per-source sync step shared by the poll function and `ticketSources.sync`.
 * One step looks at a bounded set of issue numbers of one source: issues the
 * fact index lists after the checkpoint (new work), tickets that own a
 * nonterminal request and tickets that wait on a blocker (known work). Each
 * candidate is read live, then admitted or rechecked through the one shared
 * admission code; a candidate the live read does not call for is left alone.
 * Absence is never inferred: a number missing from the fact index closes and
 * suspends nothing. An issue the live read reports gone, moved or closed is an
 * answer, and the recheck of a ticket that owns a request suspends it.
 *
 * The step writes the source row for progress only (checkpoint, health, last
 * sync and problem code), never `version` or `policy_revision`, so an admin's
 * `If-Match` update is not refused because a poll ran.
 */

/** Candidates per step for the poll. */
export const SYNC_STEP_LIMIT = 25;
/** Candidates per step under the registry runner, which prefetches them first. */
export const SYNC_OPERATION_LIMIT = 10;
/** Provider reads in flight at once while prefetching candidates. */
export const SYNC_PREFETCH_PARALLELISM = 5;
/** Consecutive failing steps on one fact-index issue before the checkpoint moves past it. */
export const SYNC_FAILURE_LIMIT = 3;
/**
 * The same for an issue whose read the provider could not answer (an outage or
 * a timeout, not a fault of the issue): a day of five-minute polls. An outage
 * must not pass a new issue, but one issue the provider never answers must not
 * hold every later issue for ever.
 */
export const SYNC_OUTAGE_LIMIT = 288;
/** Wait applied when the provider rate-limits without saying for how long. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Longest wait a provider answer can impose on a source. */
const MAX_RETRY_AFTER_SECONDS = 3600;

export type SyncDeps = AdmissionDeps & {
  factIndex: TicketFactIndex;
  /** Clock for the rate-limit wait; tests set it. */
  now?: () => Date;
};

/** An issue number a step looks at and why. */
export type SyncCandidate = {
  number: number;
  /** `new`: the fact index lists it after the checkpoint; `known`: it has a request or waits. */
  kind: "new" | "known";
  /** Provider-update instant of a `new` candidate, the checkpoint position once passed. */
  providerUpdatedAt: string | null;
};

export type SyncSelection = {
  source: TicketSource;
  handle: TicketSourceHandle;
  /** `new` candidates in marker order, then `known` ones in rotation order. */
  candidates: SyncCandidate[];
};

/**
 * Chooses the candidates of one step from the database alone, at most `limit`.
 * New work gets `max(1, floor(0.4 * limit))` slots in marker order so a long
 * list of old requests cannot starve new issues; known work takes the rest in
 * issue-number order after the rotation cursor, wrapping, so every request and
 * waiting ticket is reached within a few steps.
 */
export async function selectSyncCandidates(
  transaction: PgTransactionClient,
  deps: Pick<SyncDeps, "factIndex">,
  request: { organizationId: string; sourceId: string; limit: number },
): Promise<SyncSelection> {
  const limit = Math.max(1, Math.trunc(request.limit));
  const { source, handle } = await readSourceHandle(
    transaction,
    request.organizationId,
    request.sourceId,
  );
  const checkpoint = source.syncCheckpoint;
  const fresh = await deps.factIndex.listIssueNumbers(transaction, {
    organizationId: request.organizationId,
    resourceId: source.resourceId,
    afterMarker: checkpoint.marker,
    afterNumber: checkpoint.markerNumber,
    limit: Math.max(1, Math.floor(0.4 * limit)),
  });
  const known = await listRotationNumbers(transaction, {
    organizationId: request.organizationId,
    sourceId: request.sourceId,
    requestLabels: [
      source.policy.labels.execute,
      ...(source.policy.labels.planOnly === null
        ? []
        : [source.policy.labels.planOnly]),
    ],
    holdLabel: source.policy.labels.hold,
    after: checkpoint.cursor,
    exclude: fresh.map((entry) => entry.number),
    limit: limit - fresh.length,
  });
  return {
    source,
    handle,
    candidates: [
      ...fresh.map((entry): SyncCandidate => ({
        number: entry.number,
        kind: "new",
        providerUpdatedAt: entry.providerUpdatedAt,
      })),
      ...known.map((number): SyncCandidate => ({
        number,
        kind: "known",
        providerUpdatedAt: null,
      })),
    ],
  };
}

/** How one candidate ended. `unprocessed` was not looked at and is retried. */
export type SyncCandidateResult = {
  number: number;
  kind: SyncCandidate["kind"];
  status: "done" | "failed" | "unprocessed";
  action: "admit" | "recheck" | "none" | null;
  admission: AdmissionKind | null;
  applied: RecheckAction[];
  /** Fixed problem code of a failed candidate; null otherwise. */
  problem: string | null;
  /** The failure is a provider read that may answer next time, bounded by `SYNC_OUTAGE_LIMIT`. */
  transient: boolean;
};

export type SyncStepResult = {
  /** `not_before`: the source waits out a rate limit, nothing was read or written. */
  outcome: "completed" | "rate_limited" | "auth_required" | "not_before";
  results: SyncCandidateResult[];
  health: TicketSyncHealth | null;
  problemCode: string | null;
};

/** The fixed code a refusal is recorded under: its reason, else its first issue code, else its error code. */
export function problemCodeOf(error: StandardError): string {
  const reason = error.params?.reason;
  if (typeof reason === "string") return reason;
  const issues = error.params?.issues;
  if (Array.isArray(issues)) {
    const code = (issues[0] as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return error.code.toLowerCase();
}

/** The code a step that died on an unexpected error is recorded under: `problemCodeOf` of an `INTERNAL` error. */
export const INTERNAL_PROBLEM_CODE = "internal";

/**
 * An unexpected error (never a `StandardError`) that ended a poll step, with
 * the number of the candidate it came from. `candidateNumber` is a fixed
 * integer and `errorName` the class name of the original error. The original
 * stays as `cause`; its message is never copied into this error, because it
 * can hold issue text or a token.
 */
export class TicketCandidateDefect extends Error {
  readonly candidateNumber: number;
  readonly errorName: string;
  constructor(candidateNumber: number, cause: unknown) {
    super("TICKET_CANDIDATE_DEFECT", { cause });
    this.name = "TicketCandidateDefect";
    this.candidateNumber = candidateNumber;
    this.errorName = cause instanceof Error ? cause.name : typeof cause;
  }
}

/** A refusal passes as it is; any other error is named after the candidate it came from. */
function nameCandidate(candidate: SyncCandidate, error: unknown): unknown {
  return error instanceof StandardError
    ? error
    : new TicketCandidateDefect(candidate.number, error);
}

/**
 * Records that a step for one source died on an unexpected error, so the poll
 * moves on to the next source and, on the next run, past this one. It writes
 * the sync columns only, through `writeSyncProgress`: the checkpoint as stored
 * with a fresh `attemptedAt` (no position moves, no wait is lifted), the
 * health `degraded` and the problem code `internal`; `last_synced_at`,
 * `version`, `policy_revision` and `updated_at` stay as they were. A source
 * stored as `auth_required` keeps that health and its problem code, as in
 * `mergeProgress`: lost authority needs a person and a defect must not hide
 * it. It takes the source row `for update` as its only lock, reads nothing
 * from the provider and returns the health it left on the row.
 */
export async function recordStepDefect(
  database: PgDatabase,
  request: {
    organizationId: string;
    sourceId: string;
    signal: AbortSignal;
    now?: Date;
  },
): Promise<TicketSyncHealth> {
  const { organizationId, sourceId, signal } = request;
  const now = request.now ?? new Date();
  return await withPgTransaction(database, async (tx) => {
    const stored = await lockSourceForUpdate(tx, organizationId, sourceId);
    const lostAuthority = stored.syncHealth === "auth_required";
    const health = lostAuthority ? "auth_required" : "degraded";
    await writeSyncProgress(tx, {
      organizationId,
      sourceId,
      checkpoint: { ...stored.syncCheckpoint, attemptedAt: now.toISOString() },
      health,
      problemCode: lostAuthority
        ? stored.lastProblemCode
        : INTERNAL_PROBLEM_CODE,
      synced: false,
    });
    return health;
  }, signal);
}

/**
 * Records that a step for one source ended in a refusal before it wrote
 * anything (its stored policy does not parse, its connection or resource is
 * missing), so the poll stamps the attempt and the code and, on the next run,
 * lists the source behind the rest instead of at the front of every run. It is
 * best effort: a refusal is already the step's outcome, so a write that fails
 * or a source row that is gone leaves the outcome as it was (one log line with
 * the source id, the code and the error class name for a failed write, never
 * its message). It parses nothing and reads nothing from the provider; see
 * `writeRefusedAttempt` for the columns it moves. Returns whether it recorded.
 */
export async function recordStepRefusal(
  database: PgDatabase,
  request: {
    organizationId: string;
    sourceId: string;
    problemCode: string;
    signal: AbortSignal;
    now?: Date;
  },
): Promise<boolean> {
  const { organizationId, sourceId, problemCode, signal } = request;
  try {
    return await withPgTransaction(
      database,
      (tx) =>
        writeRefusedAttempt(tx, {
          organizationId,
          sourceId,
          problemCode,
          attemptedAt: request.now ?? new Date(),
        }),
      signal,
    );
  } catch (error) {
    console.error(JSON.stringify({
      component: "work",
      event: "ticket_poll_refusal_unrecorded",
      sourceId,
      code: problemCode,
      errorName: error instanceof Error ? error.name : typeof error,
    }));
    return false;
  }
}

function isFailure(value: { kind: string }): value is TicketReadFailure {
  return value.kind === "unavailable";
}

type Halt =
  | { kind: "rate_limited"; seconds: number }
  | { kind: "auth_required" };

/**
 * A provider answer that says the whole source cannot be read now: a rate
 * limit (the step stops and the source waits) or lost authority. Other
 * failures reach admission as `provider_unavailable` evidence.
 */
function haltOf(answer: TicketPrefetch): Halt | null {
  const failures: TicketReadFailure[] = [];
  for (
    const value of [
      answer.issue,
      answer.links,
      ...answer.proofs.map((entry) => entry.proof),
      answer.provenance,
      answer.actorRole,
    ]
  ) {
    if (value !== null && isFailure(value)) failures.push(value);
  }
  const limited = failures.find((failure) => failure.reason === "rate_limited");
  if (limited) {
    return {
      kind: "rate_limited",
      seconds: Math.min(
        MAX_RETRY_AFTER_SECONDS,
        Math.max(1, limited.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS),
      ),
    };
  }
  return failures.some((failure) => failure.reason === "forbidden")
    ? { kind: "auth_required" }
    : null;
}

export async function inSavepoint<T>(
  transaction: PgTransactionClient,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  await transaction.query(`savepoint ${name}`);
  try {
    const value = await work();
    await transaction.query(`release savepoint ${name}`);
    return value;
  } catch (error) {
    if (error instanceof StandardError) {
      await transaction.query(`rollback to savepoint ${name}`);
      await transaction.query(`release savepoint ${name}`);
    }
    throw error;
  }
}

/**
 * Runs one step for one source.
 *
 * Without `prefetched` (automation) the step must be allowed to read: it
 * selects in a short transaction, reads each candidate from the provider with
 * no transaction open (five at a time), then runs each candidate in its own
 * transaction and writes the source row in a last one, which locks it and
 * merges with what another run wrote since. With `prefetched` (the
 * operation runner, which read the candidates before the registry transaction
 * opened) everything runs in the caller's one transaction: the source row is
 * locked `for update` first, a candidate with no entry is skipped and retried
 * next step, and each candidate runs in a savepoint so one refusal does not
 * undo the others.
 *
 * Dispatch uses the live labels read for the candidate. A ticket that owns a
 * nonterminal request is rechecked (which advances, resumes, suspends or ends
 * it). Any other ticket, known or not, whose live issue carries a request
 * label is admitted with origin `poll`, which covers a reopened and relabeled
 * ticket and a second generation; admission decides readiness and the
 * automatic window. Everything else is left alone.
 *
 * A failed candidate is recorded in `last_problem_code`, the step goes on and
 * the checkpoint stays behind a failed new issue; after
 * `SYNC_FAILURE_LIMIT` steps in a row failing with the same code on the same
 * number the checkpoint moves past it, but only after `SYNC_OUTAGE_LIMIT`
 * when the failure was the provider not answering, so an outage of a few
 * polls loses no new issue. A rate limit stops the step and keeps
 * the source idle until the provider's wait is over; lost authority stops it
 * and marks the source `auth_required`.
 *
 * An unexpected error in a candidate (its read or its dispatch) is not a
 * failed candidate: it ends the step. In automation mode it is thrown as a
 * `TicketCandidateDefect` naming the candidate, and no checkpoint, cursor or
 * failure counter moves, so the source stays behind that candidate until the
 * defect is fixed. In operation mode it is thrown as it was.
 */
export async function runTicketSourceStep(
  deps: SyncDeps,
  request: {
    organizationId: string;
    sourceId: string;
    limit: number;
    prefetched?: ReadonlyMap<number, TicketPrefetch>;
    signal: AbortSignal;
  },
): Promise<SyncStepResult> {
  const { organizationId, sourceId, signal } = request;
  const prefetched = request.prefetched;
  const transaction = deps.transaction;
  const database: PgDatabase | undefined = deps.database;
  if (prefetched === undefined) {
    assertDeps(deps, null);
  } else if (
    transaction === undefined || database !== undefined || deps.readsAllowed
  ) {
    throw new Error("TICKET_ADMISSION_DEPS_INVALID");
  }
  const now = (deps.now ?? (() => new Date()))();

  if (transaction !== undefined) {
    // Operation mode: the source row first, then the candidates.
    await lockSourceForUpdate(transaction, organizationId, sourceId);
  }
  const selection = transaction !== undefined
    ? await selectSyncCandidates(transaction, deps, request)
    : await withPgTransaction(
      database!,
      (tx) => selectSyncCandidates(tx, deps, request),
      signal,
    );
  const { source, handle, candidates } = selection;
  const checkpoint = source.syncCheckpoint;
  if (
    checkpoint.notBefore !== null &&
    Date.parse(checkpoint.notBefore) > now.getTime()
  ) {
    return {
      outcome: "not_before",
      results: [],
      health: null,
      problemCode: null,
    };
  }

  const runOne = async (
    index: number,
    candidate: SyncCandidate,
    answer: TicketPrefetch,
  ): Promise<SyncCandidateResult> => {
    const dispatch = (tx: PgTransactionClient) =>
      dispatchCandidate(
        {
          reader: deps.reader,
          budget: deps.budget,
          readsAllowed: false,
          transaction: tx,
        },
        source,
        candidate,
        answer,
        signal,
      );
    try {
      return transaction !== undefined
        ? await inSavepoint(
          transaction,
          `ticket_step_${index}`,
          () => dispatch(transaction),
        )
        : await withPgTransaction(database!, dispatch, signal);
    } catch (error) {
      if (!(error instanceof StandardError)) {
        // The poll records a defect by candidate; the registry runner, which
        // has one transaction for the whole call, sees the error as it was.
        throw transaction === undefined
          ? new TicketCandidateDefect(candidate.number, error)
          : error;
      }
      return result(candidate, "failed", { problem: problemCodeOf(error) });
    }
  };

  const results: SyncCandidateResult[] = [];
  let halt: Halt | null = null;
  for (
    let from = 0;
    from < candidates.length;
    from += SYNC_PREFETCH_PARALLELISM
  ) {
    const chunk = candidates.slice(from, from + SYNC_PREFETCH_PARALLELISM);
    const answers: (TicketPrefetch | null)[] =
      prefetched !== undefined || halt !== null
        ? chunk.map((candidate) => prefetched?.get(candidate.number) ?? null)
        : await Promise.all(chunk.map((candidate) =>
          prefetchTicketReads(
            deps.reader,
            handle,
            { number: candidate.number, policy: source.policy, origin: "poll" },
            signal,
          ).catch((error) => {
            throw nameCandidate(candidate, error);
          })
        ));
    for (const [offset, candidate] of chunk.entries()) {
      const answer = answers[offset];
      halt ??= answer === null ? null : haltOf(answer);
      results.push(
        halt !== null || answer === null
          ? result(candidate, "unprocessed")
          : await runOne(from + offset, candidate, answer),
      );
    }
  }

  const failed = results.find((entry) => entry.status === "failed");
  const progress = advanceCheckpoint(checkpoint, candidates, results);
  const health: TicketSyncHealth = halt?.kind === "auth_required"
    ? "auth_required"
    : halt !== null || failed !== undefined
    ? "degraded"
    : "healthy";
  const problemCode = halt?.kind === "rate_limited"
    ? "rate_limited"
    : halt?.kind === "auth_required"
    ? "auth_required"
    : failed?.problem ?? null;
  const ours: Progress = {
    checkpoint: {
      ...progress,
      notBefore: halt?.kind === "rate_limited"
        ? new Date(now.getTime() + halt.seconds * 1000).toISOString()
        : null,
      // Stamped on every step that writes, halted or not: `last_synced_at`
      // stays put on a halt, so the poll orders its sources by this instant.
      attemptedAt: now.toISOString(),
    },
    health,
    problemCode,
    synced: halt === null,
  };
  let written = ours;
  if (transaction !== undefined) {
    // The registry transaction has held the source row since its first query.
    await writeSyncProgress(transaction, { organizationId, sourceId, ...ours });
  } else {
    // Another run may have written since this one read: merge under the lock.
    await withPgTransaction(database!, async (tx) => {
      const stored = await lockSourceForUpdate(tx, organizationId, sourceId);
      written = mergeProgress(checkpoint, ours, stored.syncCheckpoint, now);
      await writeSyncProgress(tx, { organizationId, sourceId, ...written });
    }, signal);
  }
  return {
    outcome: halt?.kind ?? "completed",
    results,
    health: written.health,
    problemCode: written.problemCode,
  };
}

type Progress = {
  checkpoint: TicketSyncCheckpoint;
  health: TicketSyncHealth;
  problemCode: string | null;
  synced: boolean;
};

/** Whether the fact position of `a` is later than that of `b` (no marker is earliest). */
function isLater(
  a: Pick<TicketSyncCheckpoint, "marker" | "markerNumber">,
  b: Pick<TicketSyncCheckpoint, "marker" | "markerNumber">,
): boolean {
  const at = a.marker === null ? -Infinity : Date.parse(a.marker);
  const bt = b.marker === null ? -Infinity : Date.parse(b.marker);
  return at !== bt ? at > bt : (a.markerNumber ?? -1) > (b.markerNumber ?? -1);
}

/**
 * Joins the progress of this step, computed from the checkpoint `read` at its
 * start, with the checkpoint `stored` now. A run that wrote in between (an
 * operation-mode sync, a second poll) is never undone: the fact position and
 * the rotation cursor never move back past the stored ones, and a rate-limit
 * wait still in force survives with the health and problem code that go with
 * it. A step that lost authority keeps `auth_required` and its problem code,
 * which need a person, over the other run's wait; that wait still survives in
 * the checkpoint. Untouched, the stored checkpoint is `read` and this step's
 * wins.
 */
function mergeProgress(
  read: TicketSyncCheckpoint,
  ours: Progress,
  stored: TicketSyncCheckpoint,
  now: Date,
): Progress {
  const mine = ours.checkpoint;
  const position = isLater(stored, read) && !isLater(mine, stored)
    ? stored
    : mine;
  const waiting = stored.notBefore !== null &&
    Date.parse(stored.notBefore) > now.getTime() &&
    (mine.notBefore === null ||
      Date.parse(stored.notBefore) > Date.parse(mine.notBefore));
  const checkpoint: TicketSyncCheckpoint = {
    marker: position.marker,
    markerNumber: position.markerNumber,
    failure: position.failure,
    cursor: stored.cursor !== read.cursor ? stored.cursor : mine.cursor,
    notBefore: waiting ? stored.notBefore : mine.notBefore,
    attemptedAt: mine.attemptedAt,
  };
  return waiting && ours.health !== "auth_required"
    ? {
      checkpoint,
      health: "degraded",
      problemCode: "rate_limited",
      synced: false,
    }
    : { ...ours, checkpoint };
}

function result(
  candidate: SyncCandidate,
  status: SyncCandidateResult["status"],
  detail: Partial<SyncCandidateResult> = {},
): SyncCandidateResult {
  return {
    number: candidate.number,
    kind: candidate.kind,
    status,
    action: null,
    admission: null,
    applied: [],
    problem: null,
    transient: false,
    ...detail,
  };
}

/** Runs one candidate in the transaction `deps` holds. */
async function dispatchCandidate(
  deps: AdmissionDeps,
  source: TicketSource,
  candidate: SyncCandidate,
  answer: TicketPrefetch,
  signal: AbortSignal,
): Promise<SyncCandidateResult> {
  const transaction = deps.transaction!;
  const found = await findTicketForNumber(
    transaction,
    source.organizationId,
    source.id,
    candidate.number,
  );
  if (found?.requestId != null) {
    const rechecked = await recheckTicket(deps, {
      organizationId: source.organizationId,
      ticketId: found.ticketId,
      origin: "poll",
      prefetch: answer,
      signal,
    });
    return result(candidate, "done", {
      action: "recheck",
      applied: rechecked.applied,
    });
  }
  if (isFailure(answer.issue)) {
    // The labels are unknown, so there is nothing to decide; the checkpoint
    // stays behind the candidate and it is read again.
    return result(candidate, "failed", {
      problem: "provider_unavailable",
      // Too many labels lasts as long as the issue does; the rest passes.
      transient: answer.issue.reason !== "labels_truncated",
    });
  }
  if (
    answer.issue.kind === "present" &&
    requestedIntentFromLabels(answer.issue.snapshot.labels, source.policy) !==
      null
  ) {
    const admitted = await admitTicket(deps, {
      organizationId: source.organizationId,
      sourceId: source.id,
      number: candidate.number,
      intent: null,
      origin: "poll",
      caller: null,
      prefetch: answer,
      signal,
    });
    return result(candidate, "done", {
      action: "admit",
      admission: admitted.kind,
    });
  }
  return result(candidate, "done", { action: "none" });
}

/**
 * The checkpoint after a step. New issues pass in marker order up to the first
 * that failed or was not looked at; a failed one is passed only on its
 * `SYNC_FAILURE_LIMIT`-th consecutive failing step with the same code (the
 * `SYNC_OUTAGE_LIMIT`-th when the provider could not be read). The
 * rotation cursor follows the known candidates that were looked at.
 */
function advanceCheckpoint(
  previous: TicketSyncCheckpoint,
  candidates: readonly SyncCandidate[],
  results: readonly SyncCandidateResult[],
): TicketSyncCheckpoint {
  let { marker, markerNumber, cursor } = previous;
  let failure: TicketSyncCheckpoint["failure"] = null;
  let holding = false;
  let rotating = true;
  for (const [index, entry] of results.entries()) {
    if (entry.kind === "known") {
      if (rotating && entry.status !== "unprocessed") cursor = entry.number;
      else rotating = false;
      continue;
    }
    if (holding || entry.status === "unprocessed") {
      holding = true;
      continue;
    }
    if (entry.status === "failed") {
      const repeated = previous.failure?.number === entry.number &&
        previous.failure.code === entry.problem;
      const count = repeated ? previous.failure!.count + 1 : 1;
      if (count < (entry.transient ? SYNC_OUTAGE_LIMIT : SYNC_FAILURE_LIMIT)) {
        failure = { number: entry.number, code: entry.problem!, count };
        holding = true;
        continue;
      }
    }
    marker = candidates[index].providerUpdatedAt ?? marker;
    markerNumber = entry.number;
  }
  return {
    marker,
    markerNumber,
    cursor,
    notBefore: null,
    attemptedAt: previous.attemptedAt,
    failure,
  };
}
