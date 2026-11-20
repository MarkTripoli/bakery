/**
 * Recording what the sandboxed probe said about a blob, and reading it back
 * (chapter 25 section 17.6, #437 slice 2).
 *
 * The probe itself is in `probe.ts`; this module is the table it writes to. The
 * two decisions worth stating are the ones that are easy to get wrong:
 *
 * - **A refusal is stored.** "Too large to preview" is a property of the file
 *   and will still be true on the next open. Not storing it would mean paying
 *   ten seconds of sandbox time to learn the same thing every time a pane
 *   renders.
 * - **A probe that could not run is not stored.** When the launcher reports
 *   `sandbox-unavailable` — no user bus on this host, a launcher that failed to
 *   start — the answer we have is about the host, not the bytes. Recording it
 *   would tell every later reader that a perfectly good file is unreadable, so
 *   the write is skipped and the next read tries again.
 *
 * Everything else here is an upsert keyed on the blob, because the bytes of a
 * blob never change: the same digest is the same object, so the second answer
 * for it is the same answer.
 */
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  ArtifactProbeFailureCode,
  ArtifactProbeKind,
  ArtifactProbeResult,
} from "@bakery/contracts/artifact-probe";

/** A stored probe: its result, plus when the probe ran. */
export type StoredBlobProbe = Readonly<{
  result: ArtifactProbeResult;
  probedAt: Date;
}>;

type ProbeRow = Readonly<{
  status: string;
  kind: string | null;
  media_type: string | null;
  byte_length: string | number | null;
  width: number | null;
  height: number | null;
  duration_ms: string | number | null;
  line_count: string | number | null;
  utf8: boolean | null;
  failure_code: string | null;
  failure_limit: string | number | null;
  probed_at: Date;
}>;

function asNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Rebuilds the result from a row. The table's `shape_check` makes a described
 * row complete and a refused row minimal, so this cannot silently invent a
 * field the probe did not measure.
 */
export function probeFromRow(row: ProbeRow): StoredBlobProbe {
  if (row.status === "described") {
    return {
      probedAt: row.probed_at,
      result: {
        status: "described",
        kind: row.kind as ArtifactProbeKind,
        mediaType: row.media_type!,
        byteLength: asNumber(row.byte_length)!,
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
        ...(row.duration_ms === null
          ? {}
          : { durationMs: asNumber(row.duration_ms) }),
        ...(row.line_count === null
          ? {}
          : { lineCount: asNumber(row.line_count) }),
        ...(row.utf8 === null ? {} : { utf8: row.utf8 }),
      },
    };
  }
  const limit = asNumber(row.failure_limit);
  return {
    probedAt: row.probed_at,
    result: {
      status: "refused",
      code: row.failure_code as ArtifactProbeFailureCode,
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

/**
 * Whether this result says anything about the bytes.
 *
 * `sandbox-unavailable` says the host could not run the probe. It is a real
 * answer to "why is there no preview right now", and no answer at all to "what
 * is this file", so it is never written.
 */
export function isStorableProbe(result: ArtifactProbeResult): boolean {
  return !(result.status === "refused" &&
    result.code === "sandbox-unavailable");
}

/**
 * What a probe answer can be about.
 *
 * Three shapes and no fourth: bytes deduplicated as a blob, which every version
 * sharing them shares; one storage version's own inline bytes; or one artifact
 * version's own inline bytes. The two inline shapes exist because a write below
 * the inline limit puts the bytes in the version row, and an artifact's inline
 * bytes are not a storage entry. The database holds the same rule as a CHECK, so
 * a subject that carried two keys or none could not be constructed here and
 * stored there.
 */
export type ProbeSubject =
  | Readonly<{ blobId: string }>
  | Readonly<{ entryId: string; revision: number }>
  | Readonly<{ artifactVersionId: string }>;

function subjectClause(subject: ProbeSubject): {
  readonly match: string;
  readonly values: readonly unknown[];
} {
  if ("blobId" in subject) {
    return { match: "blob_id = $2", values: [subject.blobId] };
  }
  if ("artifactVersionId" in subject) {
    return {
      match: "artifact_version_id = $2",
      values: [subject.artifactVersionId],
    };
  }
  return {
    match: "entry_id = $2 and revision = $3",
    values: [subject.entryId, subject.revision],
  };
}

/** Reads the probe for one subject, or null when none has run. */
export async function readBlobProbe(
  // The narrow shape both a pool and a request's transaction client satisfy: a
  // read inside a transaction sees the row that same request just wrote.
  database: Pick<PgTransactionClient, "query">,
  input: { organizationId: string } & ProbeSubject,
): Promise<StoredBlobProbe | null> {
  const clause = subjectClause(input);
  const { rows } = await database.query<ProbeRow>(
    `select status, kind, media_type, byte_length, width, height,
            duration_ms, line_count, utf8, failure_code, failure_limit,
            probed_at
       from bakery.blob_probes
      where organization_id = $1 and ${clause.match}`,
    [input.organizationId, ...clause.values],
  );
  const row = rows[0];
  return row === undefined ? null : probeFromRow(row);
}

/**
 * Records the probe's answer for a subject.
 *
 * An update on conflict rather than an insert-if-absent: the same bytes give
 * the same answer, so a second write is a re-run of the same question, and
 * letting it replace the row keeps `probed_at` honest about when it was last
 * asked rather than claiming the first answer for ever.
 */
export async function writeBlobProbe(
  database: Pick<PgTransactionClient, "query">,
  input: {
    organizationId: string;
    result: ArtifactProbeResult;
  } & ProbeSubject,
): Promise<void> {
  if (!isStorableProbe(input.result)) return;
  const { organizationId, result } = input;
  const described = result.status === "described";
  // Each subject has its own partial unique, so each needs its own conflict
  // target and predicate; one statement cannot name three.
  const subject = "blobId" in input
    ? {
      insert: "organization_id, blob_id",
      values: [input.blobId],
      conflict:
        "on conflict (organization_id, blob_id) where blob_id is not null",
    }
    : "artifactVersionId" in input
    ? {
      insert: "organization_id, artifact_version_id",
      values: [input.artifactVersionId],
      conflict:
        "on conflict (organization_id, artifact_version_id) where artifact_version_id is not null",
    }
    : {
      insert: "organization_id, entry_id, revision",
      values: [input.entryId, input.revision],
      conflict:
        "on conflict (organization_id, entry_id, revision) where entry_id is not null",
    };
  const placeholders = subject.values.map((_, index) => `$${index + 2}`);
  const first = placeholders.length + 2;
  const columns = [
    "status",
    "kind",
    "media_type",
    "byte_length",
    "width",
    "height",
    "duration_ms",
    "line_count",
    "utf8",
    "failure_code",
    "failure_limit",
  ].join(", ");
  const numbers = columns.split(", ").map((_, index) => `$${first + index}`);
  await database.query(
    `insert into bakery.blob_probes (
       ${subject.insert}, ${columns}, probed_at
     ) values (
       $1, ${placeholders.join(", ")}, ${numbers.join(", ")}, now()
     )
     ${subject.conflict} do update set
       status = excluded.status,
       kind = excluded.kind,
       media_type = excluded.media_type,
       byte_length = excluded.byte_length,
       width = excluded.width,
       height = excluded.height,
       duration_ms = excluded.duration_ms,
       line_count = excluded.line_count,
       utf8 = excluded.utf8,
       failure_code = excluded.failure_code,
       failure_limit = excluded.failure_limit,
       probed_at = now()`,
    [
      organizationId,
      ...subject.values,
      result.status,
      described ? result.kind : null,
      described ? result.mediaType : null,
      described ? result.byteLength : null,
      described ? result.width ?? null : null,
      described ? result.height ?? null : null,
      described ? result.durationMs ?? null : null,
      described ? result.lineCount ?? null : null,
      described ? result.utf8 ?? null : null,
      described ? null : result.code,
      described ? null : result.limit ?? null,
    ],
  );
}
