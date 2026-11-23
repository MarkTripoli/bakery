/**
 * The probe runner (#437 slice 4).
 *
 * Slice 2 built the probe, slice 3 built the two readers, and until now nothing
 * ever ran one: every answer a reader could see was either a row a test wrote or
 * "nobody has asked". This is the thing that asks.
 *
 * ## Two halves, one tick
 *
 * 1. **Backfill.** One bounded keyset page over versions that have neither an
 *    answer nor a request, oldest id first, so a workspace that predates the
 *    probe collects facts without anyone touching it. The page restarts from the
 *    beginning on every tick: there is nowhere to keep a cursor without a table
 *    of its own, and a restart is safe only because a subject that cannot be
 *    answered leaves a terminal request behind (below). Without that, a page of
 *    permanently failing subjects would be selected for ever and the versions
 *    behind them would never be reached.
 * 2. **Drain.** Claim queued requests in age order, run the probe, and store the
 *    answer.
 *
 * The request row is the record of what happened to a subject: it is deleted when
 * an answer is stored, and kept with `attempts = PROBE_MAX_ATTEMPTS` when the
 * subject is finished with and has no answer. That terminal row is what keeps the
 * backfill from asking again -- a deleted request would be re-queued by the next
 * tick, with its attempts reset, which is a retry ceiling that never bites.
 *
 * ## Why a queue and a periodic task, not an event
 *
 * The probe needs a local systemd user bus and a spool directory on this host,
 * so it has to run where the server runs, as a process that can start a unit.
 * An Inngest function runs wherever the worker runs, so an event would be the
 * wrong transport for a local sandbox. A queue table plus an owner-privileged
 * periodic task is the same async shape on infrastructure that already exists
 * (`storage-purges`), and it keeps the sandbox local.
 *
 * ## What this never does
 *
 * A host-side refusal is not stored. `probeArtifactAttempt` says whether an
 * answer is about the file or about the host (`ProbeAttempt.about`), and a
 * `sandbox-unavailable` answer is dropped rather than recorded: one bad minute
 * must not become a permanent verdict on a healthy file. The request stays queued
 * with its attempt counted, and the next tick tries again.
 */
import type { PgDatabase, PgTransactionClient } from "@bakery/persistence";
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import {
  type ProbeSubject,
  readBlobProbe,
  writeBlobProbe,
} from "./blob-probes.ts";
import { assertStoredBytes } from "./stored-bytes.ts";
import { withPgTransaction } from "@bakery/persistence";
import {
  hasStagedVersions,
  PROBE_ABANDONED_REASON,
  refuseStagedVersions,
  settlesStagedVersion,
  settleStagedVersions,
} from "./staged-versions.ts";
import {
  type ArtifactProbeOptions,
  probeArtifactAttempt,
  sandboxHoldsFilesystem,
  sandboxHoldsNetwork,
} from "./probe.ts";

/** One tick's budget: enough to be useful, small enough to bound a run. */
export const PROBE_TICK_LIMIT = 25;

/** A request that has failed this many times stops being retried. */
export const PROBE_MAX_ATTEMPTS = 5;

type RequestRow = Readonly<{
  id: string;
  organization_id: string;
  blob_id: string | null;
  entry_id: string | null;
  revision: number | null;
  artifact_version_id: string | null;
  attempts: number;
}>;

export type ProbeRunnerDeps = Readonly<{
  /**
   * Bytes of a blob, verified by the caller's own store. `"unavailable"` is the
   * server having no store, which is not the same answer as `null`: the bytes may
   * be perfectly present, and the request must be left alone rather than dropped.
   */
  readBlobBytes: (
    organizationId: string,
    blobId: string,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number } | null | "unavailable">;
  /** Inline bytes of one storage version. */
  readInlineBytes: (
    organizationId: string,
    entryId: string,
    revision: number,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number } | null>;
  /** Inline bytes of one artifact version. */
  readArtifactVersionBytes: (
    organizationId: string,
    artifactVersionId: string,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number } | null>;
  probeOptions?: ArtifactProbeOptions;
  /** Where a discarded failure's class is reported; stderr in the task. */
  log?: (line: string) => void;
}>;

export type ProbeRunnerResult = Readonly<{
  /** Requests taken this tick. */
  claimed: number;
  /** Answers actually stored. */
  answered: number;
  /** Real failures of an attempt, counted against the request's ceiling. */
  deferred: number;
  /** Requests given up on after repeated failures. */
  abandoned: number;
  /** Subjects the backfill found and queued. */
  queued: number;
  /**
   * True when the host could not run the sandbox, so this tick claimed nothing
   * and left every request exactly as it found it. Not a failure: the next tick
   * on a healthy host picks the same rows up again.
   */
  sandboxUnavailable: boolean;
  /**
   * True when the runner was given no spool directory, so it can never answer a
   * bytes-fed subject: the probe hands the sandbox a path, so there has to be
   * somewhere to put one. Reported as a precondition of the tick rather than
   * discovered per request, because a runner with nowhere to spool would
   * otherwise claim every request, be told the host is unavailable, and answer
   * nothing for ever.
   */
  spoolDirMissing: boolean;
  /**
   * True when this server has no object store, so a blob-backed subject cannot be
   * read at all. That is a deployment fact, not a fact about the file: nothing is
   * counted and the request is left exactly as it was found.
   */
  storeUnavailable: boolean;
}>;

/** Queues one subject. Writing the same subject twice queues it once. */
export async function enqueueProbeSubject(
  // The transaction signature, which a pool also satisfies: a write site queues
  // inside its own transaction so a version cannot exist unqueued.
  database: Pick<PgTransactionClient, "query">,
  input:
    & { organizationId: string }
    & (
      | { blobId: string }
      | { entryId: string; revision: number }
      | { artifactVersionId: string }
    ),
  options: {
    /**
     * Ask again even when a terminal request is on record. A staged version
     * (O29) waits on an answer, so a subject the runner gave up on before it
     * was staged has to be retried rather than left undecided for ever.
     */
    readonly reopen?: boolean;
  } = {},
): Promise<void> {
  const onConflict = options.reopen === true
    ? "do update set attempts = 0, last_error = null"
    : "do nothing";
  if ("blobId" in input) {
    await database.query(
      `insert into bakery.probe_requests (organization_id, blob_id)
       values ($1, $2)
       on conflict (organization_id, blob_id) where blob_id is not null
       ${onConflict}`,
      [input.organizationId, input.blobId],
    );
    return;
  }
  if ("artifactVersionId" in input) {
    await database.query(
      `insert into bakery.probe_requests (organization_id, artifact_version_id)
       values ($1, $2)
       on conflict (organization_id, artifact_version_id)
         where artifact_version_id is not null
       ${onConflict}`,
      [input.organizationId, input.artifactVersionId],
    );
    return;
  }
  await database.query(
    `insert into bakery.probe_requests (organization_id, entry_id, revision)
     values ($1, $2, $3)
     on conflict (organization_id, entry_id, revision)
       where entry_id is not null
     do nothing`,
    [input.organizationId, input.entryId, input.revision],
  );
}

/**
 * Queues one bounded page of subjects that have no answer yet.
 *
 * Keyset, not offset: the cursor is the last id this page saw, so a subject that
 * gets answered before the next page does not shift the window. The three
 * sources are separate rather than unioned because each needs its own key: a
 * blob is asked about once however many versions share it, and an inline version
 * is its own subject.
 */
export async function enqueueUnprobedPage(
  database: Pick<PgDatabase, "query">,
  input: { afterId: string | null; limit: number },
): Promise<{ queued: number; nextCursor: string | null }> {
  const { rows } = await database.query<{
    entry_id: string | null;
    revision: number | null;
    blob_id: string | null;
    artifact_version_id: string | null;
    organization_id: string;
    id: string;
  }>(
    `select id, organization_id, blob_id, entry_id, revision,
            artifact_version_id from (
       select v.id, v.organization_id, v.blob_id,
              null::uuid as entry_id, null::int as revision,
              null::uuid as artifact_version_id
         from bakery.artifact_versions v
        where v.blob_id is not null and v.purged_at is null
          and not exists (
            select 1 from bakery.blob_probes p
             where p.organization_id = v.organization_id
               and p.blob_id = v.blob_id)
          -- A queued or terminal request is the record that this subject has been
          -- asked about, or given up on; either way the backfill must not ask again.
          and not exists (
            select 1 from bakery.probe_requests r
             where r.organization_id = v.organization_id
               and r.blob_id = v.blob_id)
          and ($1::uuid is null or v.id > $1)
        union all
       select v.id, v.organization_id, v.blob_id,
              case when v.blob_id is null then v.entry_id end,
              case when v.blob_id is null then v.revision end,
              null::uuid as artifact_version_id
         from bakery.storage_file_versions v
         -- Purge state lives on the entry, not the version: 0249 adds purged_at
         -- to storage_entries only, so a version is live exactly while its entry
         -- is. A join rather than a subquery because the entry is also what the
         -- visibility rule would need later.
         join bakery.storage_entries e
           on e.organization_id = v.organization_id and e.id = v.entry_id
        where e.purged_at is null
          and (v.blob_id is not null or v.content is not null)
          and not exists (
            select 1 from bakery.blob_probes p
             where p.organization_id = v.organization_id
               and ((v.blob_id is not null and p.blob_id = v.blob_id)
                 or (v.blob_id is null and p.entry_id = v.entry_id
                     and p.revision = v.revision)))
          and not exists (
            select 1 from bakery.probe_requests r
             where r.organization_id = v.organization_id
               and ((v.blob_id is not null and r.blob_id = v.blob_id)
                 or (v.blob_id is null and r.entry_id = v.entry_id
                     and r.revision = v.revision)))
          and ($1::uuid is null or v.id > $1)
        union all
       select v.id, v.organization_id, null::uuid as blob_id,
              null::uuid as entry_id, null::int as revision, v.id
         from bakery.artifact_versions v
        where v.blob_id is null and v.content is not null
          and v.purged_at is null
          and not exists (
            select 1 from bakery.blob_probes p
             where p.organization_id = v.organization_id
               and p.artifact_version_id = v.id)
          and not exists (
            select 1 from bakery.probe_requests r
             where r.organization_id = v.organization_id
               and r.artifact_version_id = v.id)
          and ($1::uuid is null or v.id > $1)
     ) page
     order by id
     limit $2`,
    [input.afterId, input.limit],
  );
  for (const row of rows) {
    await enqueueProbeSubject(
      database,
      row.blob_id !== null
        ? { organizationId: row.organization_id, blobId: row.blob_id }
        : row.artifact_version_id !== null
        ? {
          organizationId: row.organization_id,
          artifactVersionId: row.artifact_version_id,
        }
        : {
          organizationId: row.organization_id,
          entryId: row.entry_id as string,
          revision: Number(row.revision),
        },
    );
  }
  const last = rows.at(-1);
  return {
    queued: rows.length,
    nextCursor: rows.length < input.limit ? null : last?.id ?? null,
  };
}

/**
 * Takes up to `limit` requests that still need an answer, oldest first.
 *
 * Nothing is locked and nothing is owned: the read runs outside a transaction, so
 * a second runner on the same database may pick the same rows in the same tick.
 * That is tolerable because an answer is an upsert and `probeOne` re-reads the
 * store before spending a sandbox unit, and it is why the claim makes no
 * exclusivity promise. A row at the attempt ceiling is a terminal record, not
 * work, so it is never claimed.
 */
export async function claimProbeRequests(
  database: PgDatabase,
  limit: number,
): Promise<readonly RequestRow[]> {
  const { rows } = await database.query<RequestRow>(
    `select id, organization_id, blob_id, entry_id, revision,
            artifact_version_id, attempts
       from bakery.probe_requests
      where attempts < $2
      order by requested_at, id
      limit $1`,
    [limit, PROBE_MAX_ATTEMPTS],
  );
  return rows;
}

/** Deletes a request whose answer is stored, or that nobody can answer. */
export async function completeProbeRequest(
  database: Pick<PgTransactionClient, "query">,
  id: string,
): Promise<void> {
  await database.query("delete from bakery.probe_requests where id = $1", [id]);
}

/**
 * Records a host-side failure and gives up after `PROBE_MAX_ATTEMPTS`.
 *
 * Backoff is by attempts rather than by clock: the tick interval is the clock,
 * and a check-then-write race over a timestamp would buy nothing here.
 *
 * Giving up leaves the row in place at the ceiling rather than deleting it. A
 * deleted request is indistinguishable from one that was never asked, so the next
 * tick's backfill would queue the same subject again with `attempts = 0` and the
 * ceiling would never be reached; the terminal row is what makes the ceiling
 * real.
 */
export async function failProbeRequest(
  database: Pick<PgTransactionClient, "query">,
  input: { id: string; attempts: number; error: string },
): Promise<"retry" | "abandoned"> {
  if (input.attempts + 1 >= PROBE_MAX_ATTEMPTS) {
    await database.query(
      `update bakery.probe_requests
          set attempts = $2, last_error = $3
        where id = $1`,
      [input.id, PROBE_MAX_ATTEMPTS, input.error.slice(0, 500)],
    );
    return "abandoned";
  }
  await database.query(
    "update bakery.probe_requests set attempts = attempts + 1, last_error = $2 where id = $1",
    [input.id, input.error.slice(0, 500)],
  );
  return "retry";
}

/**
 * Gives up on a subject that has nothing left to ask about.
 *
 * The bytes are gone -- the version or blob was purged, or it never carried any --
 * so there is no answer to store and never will be. The request stays, at the
 * ceiling, so the backfill does not queue it again on the next tick: `requested_at`
 * means "queued once", not "queued now", and the row is the record that this
 * subject is finished.
 */
export async function giveUpProbeRequest(
  database: Pick<PgDatabase, "query">,
  id: string,
): Promise<void> {
  await database.query(
    `update bakery.probe_requests
        set attempts = $2, last_error = 'subject-gone'
      where id = $1`,
    [id, PROBE_MAX_ATTEMPTS],
  );
}

/** Runs one tick: a backfill page, then as many requests as the budget allows. */
export async function runProbeTick(
  database: PgDatabase,
  deps: ProbeRunnerDeps,
  options: {
    readonly limit?: number;
    readonly backfillAfter?: string | null;
  } = {},
): Promise<ProbeRunnerResult> {
  const limit = options.limit ?? PROBE_TICK_LIMIT;
  // A bytes-fed subject needs somewhere to be spooled, and the probe refuses
  // before reading when there is not. That refusal is indistinguishable from a
  // dead sandbox if it is only discovered per request, so it is a precondition of
  // the tick: with no spool directory the runner claims nothing and says so.
  if (deps.probeOptions?.spoolDir === undefined) {
    return {
      claimed: 0,
      answered: 0,
      deferred: 0,
      abandoned: 0,
      queued: 0,
      sandboxUnavailable: false,
      spoolDirMissing: true,
      storeUnavailable: false,
    };
  }
  // The host is asked once, before anything is claimed. A host that cannot build
  // the sandbox is not going to build it twenty-five times in a row, and a tick
  // that claimed anyway would spend five attempts per request and then abandon a
  // whole workspace -- which is a fact about today's host recorded as a fact
  // about every file in it. So: nothing claimed, nothing counted, requests
  // untouched, and a later tick on a healthy host simply picks them up.
  const sandbox = await sandboxAvailable(deps.probeOptions);
  if (!sandbox) {
    return {
      claimed: 0,
      answered: 0,
      deferred: 0,
      abandoned: 0,
      queued: 0,
      sandboxUnavailable: true,
      spoolDirMissing: false,
      storeUnavailable: false,
    };
  }
  const page = await enqueueUnprobedPage(database, {
    afterId: options.backfillAfter ?? null,
    limit,
  });
  const claimed = await claimProbeRequests(database, limit);
  let answered = 0;
  let deferred = 0;
  let abandoned = 0;
  let storeUnavailable = false;
  for (const request of claimed) {
    let stored: Awaited<ReturnType<typeof probeOne>>;
    try {
      stored = await probeOne(database, request, deps);
    } catch (error) {
      // A real failure of this attempt, not a verdict on the file: count it, and
      // the ceiling eventually stops a request that cannot be answered at all.
      //
      // The class goes to stderr because the row keeps only `probe-failed`, and a
      // deferred subject whose reason is discarded cannot be diagnosed anywhere --
      // not by an operator reading the table, and not by the person who reported it.
      const outcome = await failAndSettleAbandoned(database, request);
      deps.log?.(
        `bakery: probe request ${request.id} failed (${
          error instanceof Error ? error.constructor.name : typeof error
        }) attempts=${outcome} trace=${request.id}`,
      );
      if (outcome === "abandoned") abandoned++;
      else deferred++;
      continue;
    }
    if (stored === "cleared") {
      // Stored, settled and deleted in one transaction (storeSettleAndClear).
      answered++;
    } else if (stored === "gone") {
      // The bytes are gone: there is nothing to ask about and never will be. The
      // row stays, terminal, so the backfill does not queue it again.
      await giveUpProbeRequest(database, request.id);
    } else if (stored === "unavailable") {
      // No store on this server, so a blob-backed subject cannot be read at all.
      // Leaving that row untouched is the only honest answer: the file is fine,
      // this deployment is not. The tick carries on, because an inline subject --
      // a storage version's own bytes, or a store-less artifact version -- needs no
      // store and would otherwise starve behind the first blob in the page.
      storeUnavailable = true;
      continue;
    } else {
      // The sandbox stopped answering partway through the tick. That is the same
      // host fact as an unbuildable sandbox, so it stops the tick rather than
      // spending attempts: this request is left exactly as it was found.
      return {
        claimed: claimed.length,
        answered,
        deferred,
        abandoned,
        queued: page.queued,
        sandboxUnavailable: true,
        spoolDirMissing: false,
        storeUnavailable: false,
      };
    }
  }
  return {
    claimed: claimed.length,
    answered,
    deferred,
    abandoned,
    queued: page.queued,
    sandboxUnavailable: false,
    spoolDirMissing: false,
    storeUnavailable,
  };
}

/**
 * Counts a failed attempt, and when that reaches the ceiling refuses every
 * version still staged on the subject as `probe-abandoned`, in one transaction
 * under the request's row lock. A terminal request is never claimed again, so
 * a version left staged then would wait for an answer nothing will ever give.
 */
async function failAndSettleAbandoned(
  database: PgDatabase,
  request: RequestRow,
): Promise<"retry" | "abandoned"> {
  return await withPgTransaction(database, async (transaction) => {
    await transaction.query(
      "select id from bakery.probe_requests where id = $1 for update",
      [request.id],
    );
    const outcome = await failProbeRequest(transaction, {
      id: request.id,
      attempts: request.attempts,
      error: "probe-failed",
    });
    if (outcome === "abandoned") {
      await refuseStagedVersions(transaction, {
        organizationId: request.organization_id,
        subject: subjectOf(request),
        reason: PROBE_ABANDONED_REASON,
      });
    }
    return outcome;
  });
}

/** Both seals, for the same reason the probe asks both before touching bytes. */
async function sandboxAvailable(
  options: ArtifactProbeOptions | undefined,
): Promise<boolean> {
  if (!(await sandboxHoldsNetwork(options ?? {}))) return false;
  return await sandboxHoldsFilesystem(options ?? {});
}

/**
 * Probes one request and stores the answer, or says why it did not.
 *
 * A blob subject reads its bytes through the caller's store and is stored under
 * the blob, so every version sharing those bytes gets the answer. An inline
 * subject is stored under its own version -- a storage version or an artifact
 * version -- because nothing else has those bytes.
 */
async function probeOne(
  database: PgDatabase,
  request: RequestRow,
  deps: ProbeRunnerDeps,
): Promise<"cleared" | "host-gone" | "gone" | "unavailable"> {
  const subject = subjectOf(request);
  const bytes = "blobId" in subject
    ? await deps.readBlobBytes(request.organization_id, subject.blobId)
    : "artifactVersionId" in subject
    ? await deps.readArtifactVersionBytes(
      request.organization_id,
      subject.artifactVersionId,
    )
    : await deps.readInlineBytes(
      request.organization_id,
      subject.entryId,
      subject.revision,
    );
  if (bytes === "unavailable") return "unavailable";
  if (bytes === null) return "gone";
  // A row recorded between this tick's claim and now is the same answer; asking
  // again would spend a sandbox unit to learn what is already written.
  const existing = await readBlobProbe(database, {
    organizationId: request.organization_id,
    ...subject,
  });
  if (existing !== null) {
    // The answer is already on record -- the bytes were probed for an earlier
    // version that shares them -- so a version staged since is settled on it.
    //
    // Unless that answer is a host limit (timeout, memory) stored while nothing
    // waited: it cannot settle a version, and clearing the request on it would
    // leave the version staged for ever. Then the stored row is ignored and the
    // bytes are probed again, below.
    const cleared = await storeSettleAndClear(database, request, subject, {
      result: existing.result,
      store: false,
      hostLimit: false,
      onlyIfSettled: true,
    });
    if (cleared) return "cleared";
  }
  const attempt = await probeArtifactAttempt({
    readBytes: () => Promise.resolve(bytes.bytes),
    sizeBytes: bytes.sizeBytes,
  }, deps.probeOptions);
  // The only unstorable answer is a refusal about the host: the sandbox is not
  // there. That is not this request's fault and must not count against it.
  if (!isStorable(attempt.result)) return "host-gone";
  await storeSettleAndClear(database, request, subject, {
    result: attempt.result,
    store: true,
    // A host-side answer (a launcher that failed, a timeout) or a memory cap is
    // a limit of this host's probe, not a verdict on the file.
    hostLimit: attempt.about === "host" ||
      !settlesStagedVersion(attempt.result),
  });
  return "cleared";
}

/**
 * Stores the answer, settles the staged versions it decides and deletes the
 * request, in one transaction that first locks the request row.
 *
 * The lock is what closes the race with a publisher staging a version on the
 * same subject: the publisher's enqueue (an upsert on this row) either commits
 * first, so this transaction sees the staged version and settles it, or waits
 * until this one has deleted the row and then queues a fresh request, which the
 * next tick settles on the stored answer. Without it, a version staged between
 * the settle and the delete would lose its request and stay staged for ever.
 *
 * While a staged version waits, a host limit stores nothing: stored, it would
 * clear the request and leave the version undecided. The attempt counts against
 * the request's ceiling instead.
 *
 * Answers true when the request was cleared, false when `onlyIfSettled` left it.
 */
async function storeSettleAndClear(
  database: PgDatabase,
  request: RequestRow,
  subject: ProbeSubject,
  input: {
    readonly result: ArtifactProbeResult;
    readonly store: boolean;
    readonly hostLimit: boolean;
    /**
     * Leave everything untouched and answer false when a staged version waits
     * and this result cannot settle it, so the caller can probe again.
     */
    readonly onlyIfSettled?: boolean;
  },
): Promise<boolean> {
  return await withPgTransaction(database, async (transaction) => {
    await transaction.query(
      "select id from bakery.probe_requests where id = $1 for update",
      [request.id],
    );
    const waiting = await hasStagedVersions(
      transaction,
      request.organization_id,
      subject,
    );
    if (waiting && input.hostLimit) throw new ProbeHostFault(input.result);
    // Checked under the row lock, so a version staged a moment ago is seen.
    if (
      waiting && input.onlyIfSettled === true &&
      !settlesStagedVersion(input.result)
    ) return false;
    if (input.store) {
      await writeBlobProbe(transaction, {
        organizationId: request.organization_id,
        ...subject,
        result: input.result,
      });
    }
    if (waiting) {
      await settleStagedVersions(transaction, {
        organizationId: request.organization_id,
        subject,
        result: input.result,
      });
    }
    await completeProbeRequest(transaction, request.id);
    return true;
  });
}

/**
 * The request's subject, or the closest thing to one for a row the CHECKs should
 * have made impossible. A request naming a storage version without a revision
 * resolves to a subject the store cannot match, so it is answered as "gone"
 * rather than keyed on an arbitrary revision.
 */
function subjectOf(request: RequestRow): ProbeSubject {
  if (request.blob_id !== null) return { blobId: request.blob_id };
  // Normalised rather than compared: a row that never carried the column must
  // not read as an artifact subject, which would key the answer on undefined.
  const artifactVersionId = request.artifact_version_id ?? null;
  if (artifactVersionId !== null) return { artifactVersionId };
  return {
    entryId: request.entry_id as string,
    revision: Number(request.revision),
  };
}

/** A host limit hit while a staged version waits: retried, never stored. */
class ProbeHostFault extends Error {
  constructor(result: ArtifactProbeResult) {
    super(
      result.status === "refused" ? `probe-${result.code}` : "probe-host",
    );
  }
}

/** A result about the host is not an answer, and `about` is what says so. */
function isStorable(result: ArtifactProbeResult): boolean {
  return !(result.status === "refused" &&
    result.code === "sandbox-unavailable");
}

/**
 * A blob subject's bytes, verified against the row that names them.
 *
 * The store is keyed by digest, so the bytes come back for the digest the blob
 * row claims; `assertStoredBytes` then checks the store answered with what was
 * asked for. A missing row (the bytes were purged between queueing and running)
 * is null, not an error: there is nothing to ask about.
 */
export async function readBlobProbeSubjectBytes(
  database: Pick<PgDatabase, "query">,
  // Only the one method this needs: both the raw store and the per-organization
  // adapter satisfy it, and the runner has no business writing bytes.
  store: Pick<OrganizationBlobStore, "read"> | undefined,
  organizationId: string,
  blobId: string,
): Promise<{ bytes: Uint8Array; sizeBytes: number } | null | "unavailable"> {
  const { rows } = await database.query<
    { sha256: string; size_bytes: string }
  >(
    "select sha256, size_bytes::text from bakery.blobs where organization_id = $1 and id = $2",
    [organizationId, blobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  // A server with no store cannot read a blob-backed subject at all, which is a
  // deployment fact, not a fact about the file. Saying `null` here would be read
  // as "the bytes are gone" and the subject given up on; this is its own answer.
  if (store === undefined) return "unavailable";
  const sizeBytes = Number(row.size_bytes);
  const bytes = await store.read(organizationId, row.sha256, sizeBytes);
  await assertStoredBytes(
    { sha256: row.sha256, size_bytes: sizeBytes },
    bytes,
    { mismatch: "content-mismatch" },
  );
  return { bytes, sizeBytes };
}

/** One storage version's inline bytes, or null when they are gone. */
export async function readInlineProbeSubjectBytes(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  entryId: string,
  revision: number,
): Promise<{ bytes: Uint8Array; sizeBytes: number } | null> {
  const { rows } = await database.query<{ content: Uint8Array | null }>(
    `select v.content from bakery.storage_file_versions v
       join bakery.storage_entries e
         on e.organization_id = v.organization_id and e.id = v.entry_id
      where v.organization_id = $1 and v.entry_id = $2 and v.revision = $3
        and e.purged_at is null and v.content is not null`,
    [organizationId, entryId, revision],
  );
  const content = rows[0]?.content;
  if (content === undefined || content === null) return null;
  return { bytes: content, sizeBytes: content.byteLength };
}

/**
 * One artifact version's inline bytes, or null when they are gone.
 *
 * An artifact version written with an object store configured names a blob and is
 * answered under that blob; only the store-less case has bytes of its own here.
 */
export async function readArtifactVersionProbeSubjectBytes(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  artifactVersionId: string,
): Promise<{ bytes: Uint8Array; sizeBytes: number } | null> {
  const { rows } = await database.query<{ content: Uint8Array | null }>(
    `select content from bakery.artifact_versions
      where organization_id = $1 and id = $2
        and purged_at is null and content is not null`,
    [organizationId, artifactVersionId],
  );
  const content = rows[0]?.content;
  if (content === undefined || content === null) return null;
  return { bytes: content, sizeBytes: content.byteLength };
}
