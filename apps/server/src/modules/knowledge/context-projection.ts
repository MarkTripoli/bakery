import { z } from "zod";
import type { ContextItem } from "./context-budget.ts";
import { redactContextText } from "./context-redaction.ts";

/**
 * Index-first context projections with exact citations
 * (docs/technical-design/17-context-and-handoffs.md, "Retrieve indexes, then
 * bounded evidence"). Pure: callers pass authorized version metadata and, for
 * text, an already bounded extraction window. Binary content never becomes
 * model text; it is projected as a reference only.
 */

/**
 * Identity of the extractor that produced a projection; part of every citation.
 * @2: every window is credential-redacted (context-redaction.ts) before it is
 * returned, so an extract or citation made by @1 is never reused.
 */
export const CONTEXT_EXTRACTOR_VERSION = "bakery.text-window@2";

/** Largest text window one projection may carry, in UTF-8 bytes. */
export const MAX_PROJECTION_BYTES = 65_536;

/**
 * Conservative token estimate for UTF-8 text: one token per byte. It is an
 * upper bound for every tokenizer Bakery supports, never an undercount.
 */
export function estimateTextTokens(bytes: number): number {
  return Math.max(0, Math.ceil(bytes));
}

/** Fixed cost of a reference-only projection (ids, digest, media type, size). */
export const REFERENCE_TOKENS = 64;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest of the complete artifact version.",
);
const uuid = z.string().uuid().describe("UUID identifier.");

export const ContextCitationSchema = z.object({
  artifactId: uuid.describe("Artifact the cited version belongs to."),
  versionId: uuid.describe("Exact immutable artifact version cited."),
  sha256: sha256.describe(
    "Digest of the complete version the excerpt was read from.",
  ),
  mediaType: z.string().min(1).max(255).describe(
    "Media type of the cited version.",
  ),
  location: z.object({
    startByte: z.number().int().nonnegative().describe(
      "UTF-8 byte offset where the excerpt starts.",
    ),
    endByteExclusive: z.number().int().nonnegative().describe(
      "UTF-8 byte offset just past the excerpt.",
    ),
  }).strict().nullable().describe(
    "Byte range of the excerpt, or null for a reference to the whole version.",
  ),
  extractorVersion: z.string().min(1).max(100).nullable().describe(
    "Extractor that produced the excerpt, or null for a reference without content.",
  ),
}).strict().refine(
  (citation) =>
    (citation.location === null) === (citation.extractorVersion === null),
  {
    message:
      "A ranged excerpt names its extractor; a whole-version reference names none.",
    path: ["extractorVersion"],
  },
).refine(
  (citation) =>
    citation.location === null ||
    citation.location.endByteExclusive >= citation.location.startByte,
  { message: "An excerpt cannot end before it starts.", path: ["location"] },
).describe(
  "Reproducible citation: version, digest, media type, location and extractor.",
);
export type ContextCitation = z.infer<typeof ContextCitationSchema>;

/** Authorized metadata of one artifact version, as the index returns it. */
export type ArtifactVersionIndexEntry = {
  artifactId: string;
  versionId: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number | null;
  summary?: string;
};

export type ProjectionKind =
  | "text_window"
  | "log_window"
  | "image_reference"
  | "pdf_reference"
  | "binary_reference";

/**
 * Why a projection carries no content, so a reader is told the limit instead of
 * guessing from an empty item:
 * - binary_media: images, audio, video and unknown binaries never enter a prompt
 *   as text, only as a reference;
 * - no_text_extractor: a PDF is held as a reference because Bakery has no PDF
 *   text extractor yet, not because the file is empty;
 * - extraction_failed: a text window was asked for and could not be produced.
 */
export type ProjectionLimit =
  | "binary_media"
  | "no_text_extractor"
  | "extraction_failed";

export type ContextProjection = {
  kind: ProjectionKind;
  /** Why there is no content, or null when the projection carries a window. */
  limit: ProjectionLimit | null;
  citation: ContextCitation;
  /** Bounded, credential-redacted text for the model; null for every reference projection. */
  text: string | null;
  /** Credentials replaced in the window; 0 for every reference projection. */
  redactions: number;
  /** True when the window ends before the version does. */
  truncated: boolean;
  item: ContextItem;
};

function baseType(mediaType: string): string {
  return mediaType.split(";", 1)[0]!.trim().toLowerCase();
}

/** Media types whose content may enter context as a bounded text window. */
export function isTextProjection(mediaType: string): boolean {
  const base = baseType(mediaType);
  return base.startsWith("text/") || base === "application/json" ||
    base === "application/xml" || base === "application/x-ndjson";
}

function kindOf(mediaType: string): ProjectionKind {
  const base = baseType(mediaType);
  if (base === "text/x-log" || base === "application/x-ndjson") {
    return "log_window";
  }
  if (isTextProjection(base)) return "text_window";
  if (base.startsWith("image/")) return "image_reference";
  if (base === "application/pdf") return "pdf_reference";
  return "binary_reference";
}

/**
 * A reference-only projection: no content bytes, a citation without a
 * location, and a fixed small cost. Used for images, PDFs and unknown or
 * binary content, and as the fallback when a text window is unavailable.
 */
export function referenceProjection(
  entry: ArtifactVersionIndexEntry,
  options: {
    required?: boolean;
    priority?: number;
    /** Overrides the limit the media type implies, e.g. a failed text window. */
    limit?: ProjectionLimit;
  } = {},
): ContextProjection {
  const kind = kindOf(entry.mediaType);
  const textual = kind === "text_window" || kind === "log_window";
  return {
    kind: textual ? "binary_reference" : kind,
    limit: options.limit ??
      (textual
        ? "extraction_failed"
        : kind === "pdf_reference"
        ? "no_text_extractor"
        : "binary_media"),
    citation: ContextCitationSchema.parse({
      artifactId: entry.artifactId,
      versionId: entry.versionId,
      sha256: entry.sha256,
      mediaType: entry.mediaType,
      location: null,
      extractorVersion: null,
    }),
    text: null,
    redactions: 0,
    truncated: false,
    item: {
      id: `ref:${entry.versionId}`,
      count: { state: "estimated", tokens: REFERENCE_TOKENS },
      required: options.required ?? false,
      priority: options.priority ?? 0,
    },
  };
}

/**
 * Projects one version into context. Text and logs carry the given bounded
 * window with an exact byte-range citation; anything else, or text with no
 * window, is a reference. A window over MAX_PROJECTION_BYTES is refused. The
 * citation's range is the raw bytes the window was read from; the text the model
 * sees has recognised credentials replaced, and its token estimate is the larger
 * of the raw and redacted sizes so a replacement never undercounts.
 */
export function projectArtifactVersion(
  entry: ArtifactVersionIndexEntry,
  window: {
    startByte: number;
    endByteExclusive: number;
    text: string;
    hasMore: boolean;
  } | null,
  options: { required?: boolean; priority?: number } = {},
): ContextProjection {
  const kind = kindOf(entry.mediaType);
  if ((kind !== "text_window" && kind !== "log_window") || window === null) {
    return referenceProjection(entry, options);
  }
  const bytes = new TextEncoder().encode(window.text).byteLength;
  if (
    bytes > MAX_PROJECTION_BYTES ||
    window.endByteExclusive - window.startByte !== bytes ||
    window.startByte < 0
  ) {
    throw new RangeError("PROJECTION_WINDOW_INVALID");
  }
  const redacted = redactContextText(window.text);
  const redactedBytes = new TextEncoder().encode(redacted.text).byteLength;
  return {
    kind,
    limit: null,
    citation: ContextCitationSchema.parse({
      artifactId: entry.artifactId,
      versionId: entry.versionId,
      sha256: entry.sha256,
      mediaType: entry.mediaType,
      location: {
        startByte: window.startByte,
        endByteExclusive: window.endByteExclusive,
      },
      extractorVersion: CONTEXT_EXTRACTOR_VERSION,
    }),
    text: redacted.text,
    redactions: redacted.count,
    truncated: window.hasMore,
    item: {
      id: `text:${entry.versionId}:${window.startByte}`,
      count: {
        state: "estimated",
        tokens: estimateTextTokens(Math.max(bytes, redactedBytes)),
      },
      required: options.required ?? false,
      priority: options.priority ?? 0,
    },
  };
}

/**
 * Context item for content whose size is not yet bounded (for example a
 * version not yet indexed). It is an unknown, unbounded count, so the
 * allocator omits or blocks it instead of counting it as zero.
 */
export function unboundedItem(
  id: string,
  options: { required?: boolean; priority?: number } = {},
): ContextItem {
  return {
    id,
    count: { state: "unknown", tokens: null, boundTokens: null },
    required: options.required ?? false,
    priority: options.priority ?? 0,
  };
}

export type CitationCheck =
  | { valid: true }
  | {
    valid: false;
    reason:
      | "not_authorized"
      | "version_missing"
      | "digest_mismatch"
      | "extractor_changed";
  };

/**
 * Checks a stored citation or cached extract before reuse. The caller passes
 * the version's current state as read now under live authorization; a cache
 * entry never carries an authorization decision of its own.
 */
export function verifyCitation(
  input: unknown,
  current: { authorized: boolean; sha256: string | null },
): CitationCheck {
  // Authorization first, so an unauthorized caller learns nothing about the
  // version (not even whether it still exists).
  if (current.authorized !== true) {
    return { valid: false, reason: "not_authorized" };
  }
  // Stored or cached citations are untrusted input: anything the schema
  // rejects (bad offsets, wrong shapes, a missing location) is not reused.
  const parsed = ContextCitationSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: "extractor_changed" };
  const citation = parsed.data;
  if (current.sha256 === null) {
    return { valid: false, reason: "version_missing" };
  }
  if (current.sha256 !== citation.sha256) {
    return { valid: false, reason: "digest_mismatch" };
  }
  // The inferred type does not tie location to extractor, so check the pair
  // here too: an excerpt without a known extractor has unverified provenance.
  if (
    citation.location !== null &&
    (citation.extractorVersion !== CONTEXT_EXTRACTOR_VERSION ||
      citation.location.endByteExclusive < citation.location.startByte)
  ) return { valid: false, reason: "extractor_changed" };
  if (citation.location === null && citation.extractorVersion !== null) {
    return { valid: false, reason: "extractor_changed" };
  }
  return { valid: true };
}

/**
 * Largest window one artifact version may have cached, and the stride rows are
 * keyed at.
 *
 * An extract is a pure function of its window, so the cache would otherwise be
 * bounded only by the number of byte offsets a reader cares to ask for: 10 MiB
 * of start offsets times 64 KiB of text is an unbounded write through a read
 * endpoint. Two bounds fix that, and both live here so the key computation and
 * the storage agree on them:
 *
 * - the window is keyed as the 64 KiB chunk that holds it, so offsets inside one
 *   chunk share a row; and
 * - a version keeps at most 256 rows, shared across every authorization scope
 *   (not 256 per scope), oldest evicted first. A request may name a start
 *   offset up to 10 MiB, which is 160 chunks.
 */
export const EXTRACT_CACHE_CHUNK_BYTES = 65_536;
export const EXTRACT_CACHE_ROWS_PER_VERSION = 256;

/**
 * The storage window an extraction request is cached under.
 *
 * A request for the middle of a file shares its chunk's row rather than minting
 * one of its own, and the row covers the whole chunk, so any window inside it is
 * answered from the one stored text.
 */
export function cachedExtractWindow(
  startByte: number,
): Readonly<{ startByte: number; maxBytes: number }> {
  const chunkStart = Math.floor(startByte / EXTRACT_CACHE_CHUNK_BYTES) *
    EXTRACT_CACHE_CHUNK_BYTES;
  // A caller's smaller window is widened to the whole chunk: the chunk is the
  // unit the cache stores, and text beyond what the caller asked for is never
  // returned from it.
  return {
    startByte: chunkStart,
    maxBytes: EXTRACT_CACHE_CHUNK_BYTES,
  };
}

/**
 * Cache key for a bounded immutable extract. It carries no authorization
 * decision: the scope is hashed into it only so another scope cannot find the
 * row. Whether a caller may read the version is decided by the live read before
 * any lookup.
 */
export async function extractCacheKey(
  organizationId: string,
  citation: ContextCitation,
  /** The authorization scope the extract was produced under. */
  scope?: string,
): Promise<string> {
  const range = citation.location === null
    ? "ref"
    : `${citation.location.startByte}-${citation.location.endByteExclusive}`;
  return [
    organizationId,
    citation.versionId,
    citation.sha256,
    range,
    citation.extractorVersion ?? "none",
    ...(scope === undefined ? [] : [`scope-${await sha256Text(scope)}`]),
  ].join("|");
}

/**
 * The scope as a fixed-width, delimiter-free digest (see below).
 *
 * Two reasons it is a digest and not the scope itself. The key is the primary
 * key, so a scope whose text happens to contain the separator could otherwise
 * spell another scope's key; and a caller who controls their own scope string
 * could mint a row per request, which is exactly the unbounded write the chunked
 * window is there to prevent. A digest is 64 hex characters whatever the scope
 * says, so the row count stays a function of the window alone.
 */
async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
