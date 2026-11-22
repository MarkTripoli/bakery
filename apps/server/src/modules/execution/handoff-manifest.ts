import { z } from "zod";

/**
 * The bounded handoff manifest (chapter 17, "Worker handoff manifest"; #33).
 *
 * A manifest is a record, never the authority: on any conflict the server's
 * durable run-step, attempt/fence, artifact, conversation and effect rows win.
 * It carries references and short summaries only, so it can never hold a raw
 * transcript, a secret, a lease token or hidden reasoning. Every field has a
 * description so generated metadata cannot lose what it is for.
 */

/** Largest manifest the server stores inline; anything bigger moves to artifacts. */
export const HANDOFF_MANIFEST_MAX_BYTES = 32_768;

const uuid = z.string().uuid().describe("UUID identifier.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest.",
);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/).describe(
  "Lowercase 40-character git commit SHA.",
);

/** A canonical decimal sequence bounded to a signed Postgres bigint. */
export const HandoffSequenceSchema = z.string().max(19).regex(
  /^(0|[1-9][0-9]*)$/,
).refine((value) => value.length < 19 || value <= "9223372036854775807")
  .describe(
    "Canonical nonnegative decimal sequence bounded to a signed Postgres bigint.",
  );

export const HandoffArtifactRefSchema = z.strictObject({
  artifactId: uuid.describe("Stable task-owned artifact identity."),
  versionId: uuid.describe(
    "Immutable artifact version pinned for this handoff.",
  ),
  sha256: sha256.describe(
    "Server-computed digest of the canonical artifact bytes.",
  ),
}).describe(
  "Authorized immutable artifact reference; it never embeds artifact bytes.",
);
export type HandoffArtifactRef = z.output<typeof HandoffArtifactRefSchema>;

export const HandoffModeSchema = z.enum([
  "fresh_session",
  "exact_harness_resume",
])
  .describe(
    "Whether the receiving side starts a new process or resumes a matching adapter session.",
  );

export const HandoffManifestSchema = z.strictObject({
  manifestVersion: z.literal(1).describe(
    "Version of this bounded handoff format.",
  ),
  mode: HandoffModeSchema,
  taskId: uuid.describe("Tenant-scoped task being continued."),
  runId: uuid.describe("Durable workflow run being continued."),
  runStepId: uuid.describe(
    "Durable workflow step whose checkpoint produced this manifest.",
  ),
  sourceSessionId: uuid.describe("Session that created the manifest."),
  agentVersionId: uuid.describe(
    "Pinned agent instructions and tool policy identity.",
  ),
  workflowVersionId: uuid.describe(
    "Pinned workflow definition identity for this run.",
  ),
  harness: z.enum(["pi", "claude_code", "codex"]).describe(
    "Harness adapter expected by the source session.",
  ),
  harnessVersion: z.string().min(1).max(200).describe(
    "Pinned harness or adapter version required for exact resume.",
  ),
  repository: z.strictObject({
    repositoryId: uuid.describe(
      "Repository identity authorized for this task.",
    ),
    commitSha: gitSha.describe(
      "Exact source commit represented by the checkpoint.",
    ),
    baseSha: gitSha.describe(
      "Base commit used for diff and evidence comparison.",
    ),
    worktreeId: z.string().min(1).max(200).describe(
      "Disposable worker worktree identity; a path is not ownership proof.",
    ),
    workspaceManifest: HandoffArtifactRefSchema.describe(
      "Immutable manifest of tracked, untracked and binary workspace changes.",
    ),
    uncommittedPatch: HandoffArtifactRefSchema.nullable().describe(
      "Immutable patch artifact, or null when the worktree is clean.",
    ),
    binaryChanges: z.array(HandoffArtifactRefSchema).max(100).describe(
      "Immutable artifact references for binary changes a text patch cannot capture.",
    ),
    captureStatus: z.enum(["complete", "paused"]).describe(
      "Whether workspace capture completed or continuation is paused to preserve changes.",
    ),
  }).describe("Repository and workspace state required to resume safely."),
  goal: z.string().min(1).max(4000).describe(
    "Bounded next-step goal written for the receiving session.",
  ),
  decisions: z.array(
    z.string().min(1).max(1000).describe(
      "One bounded accepted decision that constrains continuation.",
    ),
  ).max(32).describe("Bounded accepted decisions that constrain continuation."),
  context: z.strictObject({
    conversationId: uuid.describe(
      "Server-owned conversation whose generation is cut off below.",
    ),
    throughConversationSequence: HandoffSequenceSchema.describe(
      "Public decimal-string conversation sequence included by the context cutoff.",
    ),
    artifactRefs: z.array(HandoffArtifactRefSchema).max(100).describe(
      "Exact artifact versions available to retrieve as context.",
    ),
    packDigest: sha256.describe(
      "Digest of the bounded context pack selection.",
    ),
  }).describe("Reproducible context selection; it is not a raw transcript."),
  tests: z.array(
    z.strictObject({
      command: z.string().min(1).max(1000).describe(
        "Redacted command used for the recorded check.",
      ),
      result: z.enum(["passed", "failed", "skipped", "unknown"]).describe(
        "Observed result of that check.",
      ),
      evidenceVersionId: uuid.nullable().describe(
        "Exact artifact version containing check evidence, or null if none was published.",
      ),
    }).describe("One bounded test result with provenance."),
  ).max(64).describe(
    "Recent checks relevant to the next action.",
  ),
  pendingEffects: z.array(
    z.strictObject({
      effectId: uuid.describe(
        "Existing external effect identity used for reconciliation.",
      ),
      state: z.enum([
        "prepared",
        "submitted",
        "uncertain",
        "confirmed",
        "failed",
      ]).describe(
        "Wire effect state; uncertain outcomes require reconciliation before work continues.",
      ),
    }).describe(
      "One effect ledger reference requiring policy-aware reconciliation.",
    ),
  ).max(64)
    .describe("External effects that must be reconciled before retry."),
  nextAction: z.string().min(1).max(2000).describe(
    "Single bounded action after handoff validation.",
  ),
  checkpoint: z.strictObject({
    sequence: HandoffSequenceSchema.describe(
      "Public decimal-string last contiguous durable event sequence.",
    ),
    digest: sha256.describe(
      "Digest of checkpoint state and referenced inputs.",
    ),
    safeBoundary: z.boolean().describe(
      "A candidate boundary the source reports; the server ignores it and stores its own computation.",
    ),
  }).describe(
    "Durable continuation point, not an assertion that a process survived.",
  ),
  grants: z.strictObject({
    scopeDigest: sha256.describe(
      "Digest of the source scope snapshot, for comparison only.",
    ),
    recheckOnResume: z.literal(true).describe(
      "Requires fresh authorization before reads, tools or effects.",
    ),
  }).describe("Non-authoritative grant comparison metadata."),
}).describe(
  "Bounded, versioned handoff manifest with exact evidence and safe-resume conditions.",
);
export type HandoffManifest = z.output<typeof HandoffManifestSchema>;

/** Every artifact reference in a manifest, for existence and digest checks. */
export function manifestArtifactRefs(
  manifest: HandoffManifest,
): HandoffArtifactRef[] {
  const refs: HandoffArtifactRef[] = [
    manifest.repository.workspaceManifest,
    ...manifest.repository.binaryChanges,
    ...manifest.context.artifactRefs,
  ];
  if (manifest.repository.uncommittedPatch !== null) {
    refs.push(manifest.repository.uncommittedPatch);
  }
  return refs;
}

/** Effect states whose outcome is not yet known or not yet submitted. */
export const NON_REPLAY_SAFE_EFFECT_STATES = [
  "prepared",
  "submitted",
  "uncertain",
] as const;
