import { z } from "zod";
import {
  allocateContext,
  ContextEnvelopeInputSchema,
  type ContextItem,
} from "./context-budget.ts";
import {
  type ArtifactVersionIndexEntry,
  type ContextProjection,
  estimateTextTokens,
  isTextProjection,
  projectArtifactVersion,
  type ProjectionLimit,
  referenceProjection,
} from "./context-projection.ts";
import {
  extractArtifactVersion,
  readArtifactVersionIdentity,
} from "./extraction.ts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import type { ActionContext } from "@bakery/contracts/action-registry";

/**
 * Building one bounded context pack (issue #14, chapter 17).
 *
 * The pack is a view over durable records, never a stored second transcript: it
 * is computed, returned, and forgotten. Admission, projection and citation
 * validation all belong to the modules that already own them
 * (`context-budget.ts`, `context-projection.ts`, `extraction.ts`); this file
 * chooses which of their outcomes become a pack item and records what was left
 * out.
 *
 * Two rules are load-bearing and are the reason this is not a thin wrapper:
 *
 * 1. **A candidate the caller cannot read is an omission, not a failure.** The
 *    pack describes what a step may see; refusing the whole build because one
 *    candidate is forbidden would hide the rest of the answer, and would also
 *    tell the caller nothing about which one it was.
 * 2. **The digest covers the selection, not the call.** A run pins the digest it
 *    was handed, so the same inputs must produce the same digest even when the
 *    clock, the request id or the row order differs.
 */

const uuid = z.string().uuid().describe("A version identifier.");

const TextCandidateSchema = z.strictObject({
  itemId: z.string().min(1).max(200).describe(
    "Caller's identifier for this candidate; the pack reports it back on the item or on the omission.",
  ),
  kind: z.literal("text").describe(
    "Marks this candidate as text the caller already holds.",
  ),
  text: z.string().min(1).max(65_536).describe(
    "The bounded text to consider; it is counted, not truncated, by the builder.",
  ),
  priority: z.number().int().min(0).max(1000).default(0).describe(
    "Admission priority; higher is kept first when the budget is tight.",
  ),
  required: z.boolean().default(false).describe(
    "Whether the pack is unusable without this item, which makes admission hand off rather than trim.",
  ),
}).describe("A caller-supplied bounded text candidate.");

const ArtifactCandidateSchema = z.strictObject({
  itemId: z.string().min(1).max(200).describe(
    "Caller's identifier for this candidate; the pack reports it back on the item or on the omission.",
  ),
  kind: z.literal("artifact").describe(
    "Marks this candidate as a durable artifact version to project.",
  ),
  artifactVersionId: uuid.describe(
    "The authorized artifact version to project into the pack.",
  ),
  startByte: z.number().int().min(0).max(10_485_760).default(0).describe(
    "Canonical UTF-8 byte offset where the window begins.",
  ),
  maxBytes: z.number().int().min(1).max(65_536).default(8_192).describe(
    "Maximum UTF-8 bytes of the window, counted on code point boundaries.",
  ),
  priority: z.number().int().min(0).max(1000).default(0).describe(
    "Admission priority; higher is kept first when the budget is tight.",
  ),
  required: z.boolean().default(false).describe(
    "Whether the pack is unusable without this item, which makes admission hand off rather than trim.",
  ),
}).describe("An authorized artifact version to project into the pack.");

export const ContextPackCandidateSchema = z.discriminatedUnion("kind", [
  TextCandidateSchema,
  ArtifactCandidateSchema,
]).describe(
  "One candidate for the pack: caller-held text, or a durable artifact version to window.",
);
export type ContextPackCandidate = z.infer<typeof ContextPackCandidateSchema>;

export const ContextPackBuildSchema = z.strictObject({
  envelope: ContextEnvelopeInputSchema,
  candidates: z.array(ContextPackCandidateSchema).min(1).max(100).describe(
    "Candidates in the caller's relevance order; the builder never re-sorts by size.",
  ),
  conversationCutoff: z.number().int().min(0).optional().describe(
    "Minimum conversation sequence the step must see, recorded in the pack.",
  ),
  repository: z.record(
    z.string().describe("Repository field name."),
    z.unknown().describe("JSON value of the field."),
  ).optional().describe(
    "Repository the step runs against: its commit and safe paths.",
  ),
}).describe("A pack build: the envelope, its candidates and optional scope.");

export type ContextPackBuild = z.output<typeof ContextPackBuildSchema>;
export type ContextPackBuildInput = z.input<typeof ContextPackBuildSchema>;

export type ContextPackOmissionReason =
  | "unbounded_unknown"
  | "over_budget"
  | "not_found";

type Planned = Readonly<{
  itemId: string;
  item: ContextItem;
  projection: ContextProjection | null;
  countState: "measured" | "estimated" | "unknown";
  tokens: number;
  /**
   * Digest of the caller's own text, which has no citation to pin it; null for
   * an artifact item, whose citation (version, digest, window) is its pin.
   */
  callerTextSha256: string | null;
}>;

function refusalCode(error: unknown): string | null {
  if (error instanceof StandardError) return error.code;
  return null;
}

/**
 * The item a candidate contributes, or the reason it contributes nothing.
 *
 * An artifact candidate is refused per candidate: a version that is not in the
 * caller's organization, does not exist or has had its content removed becomes
 * `not_found`. Who may build a pack at all is the action's permission
 * (`artifactVersion:read` in the organization); there is no narrower
 * per-version permission, so there is no separate "not authorized" outcome.
 * Anything else is a real failure and propagates, because guessing at it
 * would put an unverified item in a prompt.
 */
async function planCandidate(
  context: ActionContext,
  candidate: ContextPackCandidate,
): Promise<Planned | ContextPackOmissionReason> {
  if (candidate.kind === "text") {
    const bytes = new TextEncoder().encode(candidate.text).byteLength;
    const tokens = estimateTextTokens(bytes);
    return {
      itemId: candidate.itemId,
      item: {
        id: candidate.itemId,
        count: { state: "estimated", tokens },
        required: candidate.required,
        priority: candidate.priority,
      },
      // A caller-supplied text has no version to cite: it is not an artifact
      // excerpt, and pretending otherwise would make the pack unverifiable.
      projection: null,
      countState: "estimated",
      tokens,
      callerTextSha256: await sha256Hex(candidate.text),
    };
  }

  const work = requireWorkTransaction(context);
  let identity;
  try {
    identity = await readArtifactVersionIdentity(
      work.transaction,
      work.organizationId,
      candidate.artifactVersionId,
    );
  } catch (error) {
    const code = refusalCode(error);
    if (code === "RESOURCE_NOT_FOUND" || code === "ARTIFACT_CONTENT_EXPIRED") {
      return "not_found";
    }
    throw error;
  }

  const sizeBytes = Number(identity.size_bytes);
  const entry: ArtifactVersionIndexEntry = {
    artifactId: identity.artifact_id,
    versionId: identity.id,
    sha256: identity.sha256,
    mediaType: identity.media_type,
    sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
      ? sizeBytes
      : null,
  };

  // Only text-like versions carry a window. Everything else - images, PDFs,
  // binaries - is a reference with no bytes, which is what AC3 asks for: a
  // failed or impossible extraction supplies a safe pointer, never a blob.
  if (!isTextProjection(identity.media_type)) {
    const projection = referenceProjection(entry, {
      required: candidate.required,
      priority: candidate.priority,
    });
    return planned(projection, candidate.itemId);
  }

  try {
    // The extraction reads its version from the path (`/v1/artifact-versions/:id/extract`);
    // a pack is built by `POST /v1/context-packs`, which has no such id, so the
    // candidate's version is put where the extraction looks for it.
    const window = await extractArtifactVersion(
      {
        ...context,
        params: { ...context.params, id: candidate.artifactVersionId },
      } as ActionContext,
      { startByte: candidate.startByte, maxBytes: candidate.maxBytes },
    );
    const projection = projectArtifactVersion(entry, {
      startByte: window.startByte,
      endByteExclusive: window.endByteExclusive,
      text: window.text,
      hasMore: window.hasMore,
    }, { required: candidate.required, priority: candidate.priority });
    return planned(projection, candidate.itemId);
  } catch (error) {
    const code = refusalCode(error);
    if (code === "RESOURCE_NOT_FOUND" || code === "ARTIFACT_CONTENT_EXPIRED") {
      return "not_found";
    }
    // A window that cannot be produced (not text after all, a stale extract, an
    // unsupported range) falls back to a reference rather than dropping the
    // candidate: the step still learns the version exists and can ask again.
    if (code === "UNPROCESSABLE") {
      return planned(
        referenceProjection(entry, {
          required: candidate.required,
          priority: candidate.priority,
          limit: "extraction_failed",
        }),
        candidate.itemId,
      );
    }
    throw error;
  }
}

function planned(
  projection: ContextProjection,
  itemId: string,
): Planned {
  const count = projection.item.count;
  // A projection is bounded by its window or its fixed reference cost, so its
  // count is never unknown here. If one ever were, reporting it as 0 tokens
  // would be the bug AC1 exists to prevent, so it stops the build instead.
  if (count.state === "unknown") throw new Error("PACK_ITEM_COUNT_UNKNOWN");
  return {
    itemId,
    item: { ...projection.item, id: itemId },
    projection,
    countState: count.state,
    tokens: count.tokens,
    callerTextSha256: null,
  };
}

export type ContextPack = Readonly<{
  decision: string;
  envelope: {
    modelContextTokens: number;
    reservedTokens: number;
    countedInputTokens: number;
    availableTokens: number;
    maxInputTokens: number | null;
    decision: string;
  };
  items: readonly {
    itemId: string;
    kind: string;
    citation: unknown;
    text: string | null;
    truncated: boolean;
    limits: ProjectionLimit | null;
    redactions: number;
    tokens: number;
    countState: "measured" | "estimated" | "unknown";
  }[];
  omitted: readonly { itemId: string; reason: ContextPackOmissionReason }[];
  usedTokens: number;
  conversationCutoff?: number;
  repository?: Record<string, unknown>;
  packDigest: string | null;
}>;

/**
 * Builds the pack: plan every candidate, admit them against the envelope, and
 * report what the pack does not carry.
 */
export async function buildContextPack(
  context: ActionContext,
  raw: unknown,
): Promise<ContextPack> {
  // The door parses: defaults live in the schema, so a caller may omit priority
  // and required and still get the same pack as one that spells them out.
  // The transport carries the envelope and the candidates as bounded JSON (the
  // schema language has no unions of objects), so their nested rules are parsed
  // here. A bad one is a 422 that names the field, never an unhandled error.
  const parsed = ContextPackBuildSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw unprocessable(
      (issue?.path ?? []).slice(0, 8) as (string | number)[],
      issue?.code ?? "invalid_value",
      parsed.error,
    );
  }
  const input: ContextPackBuild = parsed.data;
  const seen = new Set<string>();
  for (const [index, candidate] of input.candidates.entries()) {
    if (seen.has(candidate.itemId)) {
      // A duplicate id would make an omission ambiguous: the reader could not
      // tell which of the two was left out.
      throw unprocessable(["candidates", index, "itemId"], "duplicate_item_id");
    }
    seen.add(candidate.itemId);
  }

  const planned: Planned[] = [];
  const refused: { itemId: string; reason: ContextPackOmissionReason }[] = [];
  for (const candidate of input.candidates) {
    const result = await planCandidate(context, candidate);
    if (typeof result === "string") {
      refused.push({ itemId: candidate.itemId, reason: result });
    } else {
      planned.push(result);
    }
  }

  // The allocator sees the caller's order and decides by priority and need; it
  // never silently counts an unknown as zero, and it reports what it omitted.
  const allocation = allocateContext({
    envelope: input.envelope,
    items: planned.map((entry) => entry.item),
  });

  // The allocator decides *which* items are admitted, in priority order; the
  // pack then reports them in the caller's relevance order, so a reader sees
  // the same sequence the caller asked for and the digest does not move when
  // two candidates share a priority.
  const admitted = new Set(allocation.selected);
  const items = planned.flatMap((entry) => {
    if (!admitted.has(entry.itemId)) return [];
    return [{
      itemId: entry.itemId,
      kind: entry.projection?.kind ?? "text",
      citation: entry.projection?.citation ?? null,
      text: entry.projection?.text ?? null,
      truncated: entry.projection?.truncated ?? false,
      limits: entry.projection?.limit ?? null,
      redactions: entry.projection?.redactions ?? 0,
      tokens: entry.tokens,
      countState: entry.countState,
    }];
  });

  const omitted = [
    ...allocation.omitted.map((entry) => ({
      itemId: entry.id,
      reason: entry.reason as ContextPackOmissionReason,
    })),
    ...refused,
  ];

  // The digest pins what a step was given. An artifact item is pinned by its
  // citation (version, digest, window); caller text has no citation, so its own
  // digest is hashed in, along with the cutoff and the repository the pack names.
  // Two packs that differ in any of them never share a digest.
  const callerText = new Map(
    planned.map((entry) => [entry.itemId, entry.callerTextSha256]),
  );
  const packDigest = items.length === 0 ? null : await sha256Hex(
    canonicalJson({
      decision: allocation.decision,
      items: items.map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        citation: item.citation,
        callerTextSha256: callerText.get(item.itemId) ?? null,
        truncated: item.truncated,
        limits: item.limits,
        redactions: item.redactions,
        tokens: item.tokens,
        countState: item.countState,
      })),
      omitted,
      usedTokens: allocation.selectedTokens,
      conversationCutoff: input.conversationCutoff ?? null,
      repository: input.repository ?? null,
    }),
  );

  return {
    decision: allocation.decision,
    envelope: {
      modelContextTokens: allocation.envelope.modelContextTokens,
      reservedTokens: allocation.envelope.reservedTokens,
      countedInputTokens: allocation.envelope.countedInputTokens,
      availableTokens: allocation.envelope.availableTokens,
      maxInputTokens: input.envelope.maxInputTokens ?? null,
      decision: allocation.envelope.decision,
    },
    items,
    omitted,
    usedTokens: allocation.selectedTokens,
    ...(input.conversationCutoff === undefined
      ? {}
      : { conversationCutoff: input.conversationCutoff }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    packDigest,
  };
}
