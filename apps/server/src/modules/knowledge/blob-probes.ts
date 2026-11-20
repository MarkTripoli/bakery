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

/** Reads the probe for one blob, or null when none has run. */
export async function readBlobProbe(
  // The narrow shape both a pool and a request's transaction client satisfy: a
  // read inside a transaction sees the row that same request just wrote.
  database: Pick<PgTransactionClient, "query">,
  input: { organizationId: string; blobId: string },
): Promise<StoredBlobProbe | null> {
  const { rows } = await database.query<ProbeRow>(
    `select status, kind, media_type, byte_length, width, height,
            duration_ms, line_count, utf8, failure_code, failure_limit,
            probed_at
       from bakery.blob_probes
      where organization_id = $1 and blob_id = $2`,
    [input.organizationId, input.blobId],
  );
  const row = rows[0];
  return row === undefined ? null : probeFromRow(row);
}

/**
 * Records the probe's answer for a blob.
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
    blobId: string;
    result: ArtifactProbeResult;
  },
): Promise<void> {
  if (!isStorableProbe(input.result)) return;
  const { organizationId, blobId, result } = input;
  const described = result.status === "described";
  await database.query(
    `insert into bakery.blob_probes (
       organization_id, blob_id, status, kind, media_type, byte_length,
       width, height, duration_ms, line_count, utf8, failure_code,
       failure_limit, probed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     on conflict (organization_id, blob_id) do update set
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
      blobId,
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
