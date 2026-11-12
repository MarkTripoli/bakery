import { z } from "zod";
import type { ContextItem } from "./context-budget.ts";

/**
 * Index-first context projections with exact citations
 * (docs/technical-design/17-context-and-handoffs.md, "Retrieve indexes, then
 * bounded evidence"). Pure: callers pass authorized version metadata and, for
 * text, an already bounded extraction window. Binary content never becomes
 * model text; it is projected as a reference only.
 */

/** Identity of the extractor that produced a projection; part of every citation. */
export const CONTEXT_EXTRACTOR_VERSION = "bakery.text-window@1";

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

export type ContextProjection = {
  kind: ProjectionKind;
  citation: ContextCitation;
  /** Bounded text for the model; null for every reference projection. */
  text: string | null;
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
  options: { required?: boolean; priority?: number } = {},
): ContextProjection {
  const kind = kindOf(entry.mediaType);
  return {
    kind: kind === "text_window" || kind === "log_window"
      ? "binary_reference"
      : kind,
    citation: ContextCitationSchema.parse({
      artifactId: entry.artifactId,
      versionId: entry.versionId,
      sha256: entry.sha256,
      mediaType: entry.mediaType,
      location: null,
      extractorVersion: null,
    }),
    text: null,
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
 * window, is a reference. A window over MAX_PROJECTION_BYTES is refused.
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
  return {
    kind,
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
    text: window.text,
    truncated: window.hasMore,
    item: {
      id: `text:${entry.versionId}:${window.startByte}`,
      count: { state: "estimated", tokens: estimateTextTokens(bytes) },
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
  citation: ContextCitation,
  current: { authorized: boolean; sha256: string | null },
): CitationCheck {
  // Authorization first, so an unauthorized caller learns nothing about the
  // version (not even whether it still exists).
  if (!current.authorized) return { valid: false, reason: "not_authorized" };
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

/** Cache key for a bounded immutable extract; holds no authorization. */
export function extractCacheKey(
  organizationId: string,
  citation: ContextCitation,
): string {
  const range = citation.location === null
    ? "ref"
    : `${citation.location.startByte}-${citation.location.endByteExclusive}`;
  return [
    organizationId,
    citation.versionId,
    citation.sha256,
    range,
    citation.extractorVersion ?? "none",
  ].join("|");
}
