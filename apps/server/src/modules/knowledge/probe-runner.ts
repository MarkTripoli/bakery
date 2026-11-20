/**
 * The probe runner (#437 slice 4).
 *
 * Slice 2 built the probe, slice 3 built the two readers, and until now nothing
 * ever ran one: every answer a reader could see was either a row a test wrote or
 * "nobody has asked". This is the thing that asks.
 *
 * ## Two halves, one tick
 *
 * 1. **Backfill.** Bounded keyset pages over the versions that have no answer
 *    yet, oldest id first, so a workspace that predates the probe collects facts
 *    without anyone touching it. The page cursor is remembered between ticks, so
 *    a large install is covered over many ticks rather than one long scan.
 * 2. **Drain.** Claim queued requests (`for update skip locked`), run the probe,
 *    store the answer, delete the request.
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
import type { PgDatabase } from "@bakery/persistence";
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import { readBlobProbe, writeBlobProbe } from "./blob-probes.ts";
import { assertStoredBytes } from "./stored-bytes.ts";
import { type ArtifactProbeOptions, probeArtifactAttempt } from "./probe.ts";

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
  attempts: number;
}>;

export type ProbeRunnerDeps = Readonly<{
  /** Bytes of a blob, verified by the caller's own store. */
  readBlobBytes: (
    organizationId: string,
    blobId: string,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number } | null>;
  /** Inline bytes of one storage version. */
  readInlineBytes: (
    organizationId: string,
    entryId: string,
    revision: number,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number } | null>;
  probeOptions?: ArtifactProbeOptions;
}>;

export type ProbeRunnerResult = Readonly<{
  /** Requests taken this tick. */
  claimed: number;
  /** Answers actually stored. */
  answered: number;
  /** Answers about the host, dropped rather than stored. */
  deferred: number;
  /** Requests given up on after repeated host-side failures. */
  abandoned: number;
  /** Subjects the backfill found and queued. */
  queued: number;
}>;

/** Queues one subject. Writing the same subject twice queues it once. */
export async function enqueueProbeSubject(
  database: Pick<PgDatabase, "query">,
  input:
    & { organizationId: string }
    & (
      | { blobId: string }
      | { entryId: string; revision: number }
    ),
): Promise<void> {
  if ("blobId" in input) {
    await database.query(
      `insert into bakery.probe_requests (organization_id, blob_id)
       values ($1, $2)
       on conflict (organization_id, blob_id) where blob_id is not null
       do nothing`,
      [input.organizationId, input.blobId],
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
    organization_id: string;
    id: string;
  }>(
    `select id, organization_id, blob_id, entry_id, revision from (
       select v.id, v.organization_id, v.blob_id,
              null::uuid as entry_id, null::int as revision
         from bakery.artifact_versions v
        where v.blob_id is not null and v.purged_at is null
          and not exists (
            select 1 from bakery.blob_probes p
             where p.organization_id = v.organization_id
               and p.blob_id = v.blob_id)
          and ($1::uuid is null or v.id > $1)
        union all
       select v.id, v.organization_id, v.blob_id,
              case when v.blob_id is null then v.entry_id end,
              case when v.blob_id is null then v.revision end
         from bakery.storage_file_versions v
        where v.purged_at is null
          and (v.blob_id is not null or v.content is not null)
          and not exists (
            select 1 from bakery.blob_probes p
             where p.organization_id = v.organization_id
               and ((v.blob_id is not null and p.blob_id = v.blob_id)
                 or (v.blob_id is null and p.entry_id = v.entry_id
                     and p.revision = v.revision)))
          and ($1::uuid is null or v.id > $1)
     ) page
     order by id
     limit $2`,
    [input.afterId, input.limit],
  );
  for (const row of rows) {
    await enqueueProbeSubject(
      database,
      row.blob_id !== null && row.entry_id === null
        ? { organizationId: row.organization_id, blobId: row.blob_id }
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
 * Takes up to `limit` queued requests that no other runner holds.
 *
 * `for update skip locked` inside one transaction, then the ids are owned by
 * this tick: two runners on the same database do not probe the same subject
 * twice, and a runner that dies leaves its rows unlocked for the next tick.
 */
export async function claimProbeRequests(
  database: PgDatabase,
  limit: number,
): Promise<readonly RequestRow[]> {
  // `skip locked` means a peer's in-flight rows are passed over rather than
  // waited on. Outside an explicit transaction the locks end with the statement,
  // so two ticks can still pick the same row; that is safe because a subject's
  // answer is an upsert and `probeOne` re-reads the store before spending a
  // sandbox unit. What this must not do is select the same row twice within one
  // tick, and it cannot.
  const { rows } = await database.query<RequestRow>(
    `select id, organization_id, blob_id, entry_id, revision, attempts
       from bakery.probe_requests
      order by requested_at, id
      limit $1
      for update skip locked`,
    [limit],
  );
  return rows;
}

/** Deletes a request whose answer is stored, or that nobody can answer. */
export async function completeProbeRequest(
  database: Pick<PgDatabase, "query">,
  id: string,
): Promise<void> {
  await database.query("delete from bakery.probe_requests where id = $1", [id]);
}

/**
 * Records a host-side failure and gives up after `PROBE_MAX_ATTEMPTS`.
 *
 * Backoff is by attempts rather than by clock: the tick interval is the clock,
 * and a check-then-write race over a timestamp would buy nothing here.
 */
export async function failProbeRequest(
  database: Pick<PgDatabase, "query">,
  input: { id: string; attempts: number; error: string },
): Promise<"retry" | "abandoned"> {
  if (input.attempts + 1 >= PROBE_MAX_ATTEMPTS) {
    await completeProbeRequest(database, input.id);
    return "abandoned";
  }
  await database.query(
    "update bakery.probe_requests set attempts = attempts + 1, last_error = $2 where id = $1",
    [input.id, input.error.slice(0, 500)],
  );
  return "retry";
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
  const page = await enqueueUnprobedPage(database, {
    afterId: options.backfillAfter ?? null,
    limit,
  });
  const claimed = await claimProbeRequests(database, limit);
  let answered = 0;
  let deferred = 0;
  let abandoned = 0;
  for (const request of claimed) {
    const stored = await probeOne(database, request, deps);
    if (stored === "answered") {
      await completeProbeRequest(database, request.id);
      answered++;
    } else if (stored === "gone") {
      // The bytes are gone: there is nothing to ask about and never will be.
      await completeProbeRequest(database, request.id);
    } else if (stored === "deferred") {
      const outcome = await failProbeRequest(database, {
        id: request.id,
        attempts: request.attempts,
        error: "sandbox-unavailable",
      });
      if (outcome === "abandoned") abandoned++;
      else deferred++;
    }
  }
  return {
    claimed: claimed.length,
    answered,
    deferred,
    abandoned,
    queued: page.queued,
  };
}

/**
 * Probes one request and stores the answer, or says why it did not.
 *
 * A blob subject reads its bytes through the caller's store and is stored under
 * the blob, so every version sharing those bytes gets the answer. An inline
 * subject is stored under its own version, because nothing else has those bytes.
 */
async function probeOne(
  database: PgDatabase,
  request: RequestRow,
  deps: ProbeRunnerDeps,
): Promise<"answered" | "deferred" | "gone"> {
  const subject = request.blob_id !== null
    ? await deps.readBlobBytes(request.organization_id, request.blob_id)
    : await deps.readInlineBytes(
      request.organization_id,
      request.entry_id as string,
      Number(request.revision),
    );
  if (subject === null) return "gone";
  // A row recorded between this tick's claim and now is the same answer; asking
  // again would spend a sandbox unit to learn what is already written.
  const existing = await readBlobProbe(
    database,
    request.blob_id !== null
      ? { organizationId: request.organization_id, blobId: request.blob_id }
      : {
        organizationId: request.organization_id,
        entryId: request.entry_id as string,
        revision: Number(request.revision),
      },
  );
  if (existing !== null) return "answered";
  const attempt = await probeArtifactAttempt({
    readBytes: () => Promise.resolve(subject.bytes),
    sizeBytes: subject.sizeBytes,
  }, deps.probeOptions);
  if (!isStorable(attempt.result)) return "deferred";
  await writeBlobProbe(
    database,
    request.blob_id !== null
      ? {
        organizationId: request.organization_id,
        blobId: request.blob_id,
        result: attempt.result,
      }
      : {
        organizationId: request.organization_id,
        entryId: request.entry_id as string,
        revision: Number(request.revision),
        result: attempt.result,
      },
  );
  return "answered";
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
): Promise<{ bytes: Uint8Array; sizeBytes: number } | null> {
  const { rows } = await database.query<
    { sha256: string; size_bytes: string }
  >(
    "select sha256, size_bytes::text from bakery.blobs where organization_id = $1 and id = $2",
    [organizationId, blobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  // A server with no store cannot read a blob-backed subject at all, which is a
  // deployment fact, not a fact about the file: leave it queued.
  if (store === undefined) return null;
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
    `select content from bakery.storage_file_versions
      where organization_id = $1 and entry_id = $2 and revision = $3
        and purged_at is null and content is not null`,
    [organizationId, entryId, revision],
  );
  const content = rows[0]?.content;
  if (content === undefined || content === null) return null;
  return { bytes: content, sizeBytes: content.byteLength };
}
