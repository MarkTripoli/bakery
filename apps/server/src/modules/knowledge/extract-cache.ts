import type { PgTransactionClient } from "../../platform/database.ts";
import type { WorkTransaction } from "../work/work-transaction.ts";
import {
  CONTEXT_EXTRACTOR_VERSION,
  type ContextCitation,
  ContextCitationSchema,
  extractCacheKey,
  verifyCitation,
} from "./context-projection.ts";

/**
 * Durable cache for bounded immutable extracts (issue #14, chapter 17;
 * migrations/bakery/0192_artifact_extracts.sql).
 *
 * An extract is a pure function of the artifact version, its digest, the byte
 * range and the extractor version, so it can be reused without re-reading the
 * version's content. What it can never do is outlive the authorization under
 * which it was produced, so two things happen on every reuse:
 *
 * 1. The caller's access is re-established by reading the version row under the
 *    caller's own transaction and organization (the same join the extraction
 *    path uses). A cache row answers no authorization question by itself.
 * 2. The stored citation is re-validated against the version's current digest
 *    with `verifyCitation`, which also pins the extractor version. A changed
 *    digest or a changed extractor misses the cache instead of serving text
 *    that no longer matches the citation it came with.
 *
 * The authorization scope is part of the cache key. A different principal, or a
 * narrower access scope, therefore misses rather than reusing another caller's
 * row: the hit rate is lower, and no read ever crosses a grant.
 */

/** The scope an extract was produced under: who, and how far their access reached. */
export function extractScope(
  transaction: Pick<WorkTransaction, "principalId" | "accessScope">,
): string {
  const accessScope = transaction.accessScope;
  const scope = accessScope === undefined
    ? "org"
    : typeof accessScope === "string"
    ? accessScope
    : JSON.stringify(accessScope);
  return `${transaction.principalId}|${scope}`;
}

/** One cached extract, with the citation whose key addressed it. */
export type CachedExtract = Readonly<{
  citation: ContextCitation;
  text: string;
  hasMore: boolean;
}>;

type CachedExtractRow = {
  start_byte: number | string | null;
  end_byte_exclusive: number | string | null;
  text: string;
  has_more: boolean;
  media_type: string;
  digest: string;
  extractor_version: string;
};
type CachedExtractIdentityRow = CachedExtractRow & { artifact_id: string };

function integerOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Rebuilds the citation a cache row was keyed by, or null when it is malformed. */
function citationOf(
  row: CachedExtractIdentityRow,
  versionId: string,
): ContextCitation | null {
  const startByte = integerOrNull(row.start_byte);
  const endByteExclusive = integerOrNull(row.end_byte_exclusive);
  const location = startByte === null || endByteExclusive === null
    ? null
    : { startByte, endByteExclusive };
  const parsed = ContextCitationSchema.safeParse({
    artifactId: row.artifact_id,
    versionId,
    sha256: row.digest,
    mediaType: row.media_type,
    location,
    extractorVersion: location === null ? null : row.extractor_version,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A cached extract for exactly this request, or null.
 *
 * `startByte`/`maxBytes` are part of the lookup rather than the citation: the
 * end of the window is only known once the content is read, so a caller asking
 * for a window it has not read yet cannot name the range it will get back. Both
 * are stored, so the same request finds its row and a different one does not.
 */
export async function findCachedExtract(
  transaction: PgTransactionClient,
  query: Readonly<{
    organizationId: string;
    versionId: string;
    sha256: string;
    startByte: number;
    maxBytes: number;
    scope: string;
  }>,
): Promise<CachedExtract | null> {
  const result = await transaction.query<CachedExtractIdentityRow>(
    `select v.artifact_id,e.start_byte,e.end_byte_exclusive,e.text,e.has_more,e.media_type,
            e.digest,e.extractor_version
       from bakery.artifact_extracts e
       join bakery.artifact_versions v
         on v.organization_id=e.organization_id
        and v.id=e.artifact_version_id
      where e.organization_id=$1
        and e.artifact_version_id=$2
        and e.digest=$3
        and e.start_byte=$4
        and e.max_bytes=$5
        and e.extractor_version=$6
        and e.scope=$7`,
    [
      query.organizationId,
      query.versionId,
      query.sha256,
      query.startByte,
      query.maxBytes,
      CONTEXT_EXTRACTOR_VERSION,
      query.scope,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  const citation = citationOf(row, query.versionId);
  if (citation === null) return null;
  return { citation, text: row.text, hasMore: row.has_more === true };
}

/**
 * Whether a cached extract may be served to this caller now.
 *
 * `authorized` is the caller's live access to the version, established by the
 * read that produced `currentSha256`; a cache row never supplies it.
 */
export function reusableCachedExtract(
  cached: CachedExtract,
  current: Readonly<{ authorized: boolean; currentSha256: string | null }>,
): boolean {
  const check = verifyCitation(cached.citation, {
    authorized: current.authorized,
    sha256: current.currentSha256,
  });
  return check.valid;
}

/**
 * Records an extract. A concurrent writer that stored the same key first wins:
 * both rows hold the same text, because the extract is a pure function of the
 * key's inputs.
 */
export async function storeCachedExtract(
  transaction: PgTransactionClient,
  stored: Readonly<{
    organizationId: string;
    scope: string;
    citation: ContextCitation;
    text: string;
    hasMore: boolean;
    maxBytes: number;
  }>,
): Promise<void> {
  await transaction.query(
    `insert into bakery.artifact_extracts
       (organization_id,artifact_version_id,digest,start_byte,end_byte_exclusive,scope,
        extractor_version,media_type,text,text_bytes,max_bytes,has_more,cache_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict do nothing`,
    [
      stored.organizationId,
      stored.citation.versionId,
      stored.citation.sha256,
      stored.citation.location?.startByte ?? null,
      stored.citation.location?.endByteExclusive ?? null,
      stored.scope,
      CONTEXT_EXTRACTOR_VERSION,
      stored.citation.mediaType,
      stored.text,
      new TextEncoder().encode(stored.text).byteLength,
      stored.maxBytes,
      stored.hasMore,
      extractCacheKey(stored.organizationId, stored.citation),
    ],
  );
}
