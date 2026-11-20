/**
 * What a sandboxed probe may say about one stored blob (chapter 25 §17.6).
 *
 * The probe never runs in the server process and never in the page: it reads
 * bytes in a sandboxed subprocess with a memory cap, a wall-clock cap and a
 * closed network namespace, and it reports only what a reader needs to decide
 * whether the bytes can be shown. Everything here is a claim about *bytes*, not
 * about the artifact: the artifact's declared media type and its digest match
 * are the server's business, and a probe that disagreed with them would be
 * second-guessing the publisher rather than describing the file.
 *
 * Every failure is a code with a reason, never a parser message: a reader can
 * act on "this file is larger than the preview limit", and cannot act on what a
 * library wrote to stderr.
 */
import { z } from "zod";

/** Bytes a probe will read. Beyond this the file is described, not parsed. */
export const ARTIFACT_PROBE_MAX_BYTES = 64 * 1024 * 1024;

/** Wall clock a probe subprocess may take before it is killed. */
export const ARTIFACT_PROBE_TIMEOUT_MS = 10_000;

/** Memory a probe subprocess may take before it is killed. */
export const ARTIFACT_PROBE_MEMORY_MAX_BYTES = 512 * 1024 * 1024;

/**
 * What kind of thing the bytes are, as distinct from how the file is labelled.
 * `unknown` is an honest answer: a file whose bytes are recognised as nothing
 * is not the same as one that failed to parse.
 */
export const ArtifactProbeKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "pdf",
  "text",
  "archive",
  "unknown",
]).describe("What the bytes are, as distinct from what the file is called.");

export type ArtifactProbeKind = z.infer<typeof ArtifactProbeKindSchema>;

/**
 * Why a probe produced no description. Each one names something a person can
 * do or accept, and `too-large` / `timeout` are limits of this probe rather
 * than defects in the file.
 */
export const ArtifactProbeFailureCodeSchema = z.enum([
  "too-large",
  "timeout",
  "memory",
  "unreadable",
  "malformed",
  "sandbox-unavailable",
]).describe(
  "Why a probe produced no description, in words a reader can act on.",
);

export type ArtifactProbeFailureCode = z.infer<
  typeof ArtifactProbeFailureCodeSchema
>;

const byteCount = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
).describe("A count of bytes, milliseconds or lines.");

/**
 * A successful probe. Fields not measured for this kind are absent rather than
 * zero: "no duration" and "a duration of zero" are different claims, and only
 * one of them is true of a PNG.
 */
export const ArtifactProbeReportSchema = z.object({
  status: z.literal("described").describe("The bytes were read and described."),
  kind: ArtifactProbeKindSchema,
  mediaType: z.string().min(1).max(255).describe(
    "The media type the bytes themselves support, from signature and content.",
  ),
  byteLength: byteCount,
  width: z.number().int().positive().optional().describe(
    "Image width in pixels, when this probe knows how to read the format.",
  ),
  height: z.number().int().positive().optional().describe(
    "Image height in pixels, when this probe knows how to read the format.",
  ),
  durationMs: byteCount.optional().describe(
    "Audio and video length in whole milliseconds, when the container states it.",
  ),
  lineCount: byteCount.optional().describe("Lines in a text file."),
  utf8: z.boolean().optional().describe(
    "Whether a text file decodes as strict UTF-8.",
  ),
}).strict().describe("What the probe learned about one blob's bytes.");

export type ArtifactProbeReport = z.infer<typeof ArtifactProbeReportSchema>;

export const ArtifactProbeResultSchema = z.discriminatedUnion("status", [
  ArtifactProbeReportSchema,
  z.object({
    status: z.literal("refused").describe("Nothing was described."),
    code: ArtifactProbeFailureCodeSchema,
    limit: byteCount.optional().describe(
      "The limit that was hit, when the code names one.",
    ),
  }).strict().describe("A probe that could not describe the bytes."),
]).describe("A probe's answer: a description, or a named refusal.");

export type ArtifactProbeResult = z.infer<typeof ArtifactProbeResultSchema>;

/**
 * The bytes a sandboxed subprocess writes back. The worker frames its answer
 * this way so the parent can tell "the probe refused the file" from "the
 * subprocess died": a killed child writes nothing at all, and a child that
 * writes malformed JSON is a defect in this code, not a property of the file.
 */
export const ArtifactProbeFrameSchema = z.object({
  result: ArtifactProbeResultSchema,
}).strict().describe("The single frame the probe subprocess writes to stdout.");

export type ArtifactProbeFrame = z.infer<typeof ArtifactProbeFrameSchema>;

/**
 * The address the sandbox self-test tries to reach, and must not.
 *
 * A public resolver: reachable from anywhere with a route, so a connect that
 * succeeds means the network is open, not that the target happened to be up. If
 * this address is unreachable the answer is "the sandbox holds", which is the
 * answer the server wants, and an unreachable target can only ever cause the
 * server to be more careful, never less.
 */
export const ARTIFACT_PROBE_SELF_TEST_HOST = "1.1.1.1";
export const ARTIFACT_PROBE_SELF_TEST_PORT = 443;

/**
 * What the sandbox self-test asks: can a worker inside the unit reach the
 * network at all?
 *
 * This exists because a declared property is not an enforced one. A user
 * manager that cannot create a network namespace accepts `PrivateNetwork=yes`
 * and logs "proceeding without", and the unit then runs with the host's own
 * network. Nothing in the unit's configuration can tell the server that, so the
 * server asks the only question that has an answer: did a connect succeed?
 */
export const ArtifactProbeSelfTestSchema = z.enum(["network", "filesystem"])
  .describe("Which seal the sandbox is asked about.");

export const ArtifactProbeSelfTestRequestSchema = z.object({
  selfTest: ArtifactProbeSelfTestSchema.describe(
    "Ask whether the sandbox is sealed against the network or against writes.",
  ),
}).strict().describe(
  "The frame the server sends to run the sandbox self-test.",
);

export const ArtifactProbeSelfTestFrameSchema = z.discriminatedUnion(
  "selfTest",
  [
    z.object({
      selfTest: z.literal("network").describe(
        "The question that was answered.",
      ),
      reachable: z.boolean().describe(
        "True when a connection succeeded, which means the sandbox is not sealed.",
      ),
      detail: z.string().optional().describe(
        "The error name the worker saw, or a short note.",
      ),
    }).strict().describe("The answer about the network seal."),
    z.object({
      selfTest: z.literal("filesystem").describe(
        "The question that was answered.",
      ),
      writable: z.boolean().describe(
        "True when a canary file could be created, which means the sandbox is not read-only.",
      ),
      detail: z.string().optional().describe(
        "The error name the worker saw, or a short note.",
      ),
    }).strict().describe("The answer about the filesystem seal."),
  ],
).describe("What the sandbox self-test answers.");

export type ArtifactProbeSelfTestFrame = z.infer<
  typeof ArtifactProbeSelfTestFrameSchema
>;

/**
 * The canary the filesystem self-test tries to create, in the unit's own
 * working directory.
 *
 * That directory is the repository root, which `ProtectSystem=strict` makes
 * read-only -- when the host can apply it. The name is fixed rather than random
 * because the worker deletes it: a test that leaves canaries behind would
 * itself become the thing it is checking for.
 */
export const ARTIFACT_PROBE_SELF_TEST_CANARY =
  ".bakery-probe-filesystem-self-test";

/**
 * Whether anything can be shown for these bytes at all, and what. The artifact
 * view asks this, not the probe result directly, so the rule for showing a
 * file lives in one place.
 */
export function artifactPreviewOf(
  result: ArtifactProbeResult,
): { previewable: true; kind: ArtifactProbeKind } | {
  previewable: false;
  code: ArtifactProbeFailureCode | "not-previewable";
} {
  if (result.status === "refused") {
    return { previewable: false, code: result.code };
  }
  if (result.kind === "image" || result.kind === "text") {
    return { previewable: true, kind: result.kind };
  }
  return { previewable: false, code: "not-previewable" };
}
