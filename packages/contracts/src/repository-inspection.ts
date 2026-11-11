import { z } from "zod";
import { PinnedRepositoryRulesSchema } from "./repository-rules.ts";
import {
  RepositoryFixedPolicySchema,
  RepositoryProfileConfigSchema,
} from "./repository-profile-config.ts";

const uuid = z.uuid().describe("Exact immutable resource identity.");
const digest = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 canonical digest.",
);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).describe(
  "Exact pinned Git commit object identity.",
);
const decimal = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).describe(
  "Lossless nonnegative authority generation or fence.",
);
const timestamp = z.iso.datetime().describe(
  "UTC authority or observation timestamp.",
);
export const RepositoryInspectionPathSchema = z.string().min(1).max(512).refine(
  (value) =>
    new TextEncoder().encode(value).length <= 512 &&
    value.split("/").length <= 16 &&
    value.split("/").every((part) =>
      /^[A-Za-z0-9_.@+-]+$/.test(part) && part !== "." && part !== ".." &&
      part.toLowerCase() !== ".git"
    ) && !value.startsWith("-"),
  "Noncanonical or unsafe source path.",
).describe(
  "Canonical bounded relative regular-file path, excluding Git metadata.",
);
export const RepositoryInspectionToolSchema = z.enum(["git", "deno", "node"])
  .describe("Finite operator-provisioned tool; never downloaded.");
export const RepositoryInspectionCheckSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/).describe(
    "Unique server-owned check identity.",
  ),
  template: z.enum([
    "source.integrity.v1",
    "tool.version.v1",
    "node.syntax.v1",
    "deno.check.v1",
    "unsupported.v1",
  ]).describe("Code-owned fixed argv template, not a repository command."),
  tool: z.union([
    RepositoryInspectionToolSchema,
    z.null().describe(
      "No executable is admitted for this source-only or unsupported check.",
    ),
  ]).describe("Tool required by this check, or no executable."),
  paths: z.array(RepositoryInspectionPathSchema).max(64).describe(
    "Exact manifest-derived file arguments admitted by the finite template.",
  ),
  required: z.boolean().describe(
    "Server-owned blocking requirement; the worker cannot downgrade it.",
  ),
}).strict().describe("One finite inspection check definition.");
export const RepositoryInspectionCheckPolicySchema = z.object({
  schemaVersion: z.literal(1).describe(
    "Finite inspection policy format version.",
  ),
  platform: z.literal("linux").describe(
    "Required native cgroup execution platform.",
  ),
  tools: z.array(
    z.object({
      tool: RepositoryInspectionToolSchema,
      required: z.boolean().describe("Whether absence blocks readiness."),
    }).strict().describe("Server-required tool inventory entry."),
  ).min(1).max(3).describe("Unique actual tool inventory."),
  checks: z.array(RepositoryInspectionCheckSchema).min(1).max(64).describe(
    "Unique required and optional checks derived from pinned manifests.",
  ),
}).strict().describe(
  "Server-derived finite policy; contains no command or executable.",
);
export const RepositoryObservedProfileConfigSchema =
  RepositoryProfileConfigSchema
    .omit({ schemaVersion: true, fixedPolicy: true }).extend({
      schemaVersion: z.literal(2).describe(
        "Server-published observed profile version.",
      ),
      checkPolicy: RepositoryInspectionCheckPolicySchema,
      fixedPolicy: RepositoryFixedPolicySchema.optional().describe(
        "Effective fixed policy bound to this observation's trusted checker configuration.",
      ),
    }).strict().describe(
      "Observed v2 profile preserving baseline workflow, branches, worktree, and fixed-policy context.",
    );
export const RepositoryVersionedProfileConfigSchema = z.union([
  RepositoryProfileConfigSchema,
  RepositoryObservedProfileConfigSchema,
]).describe(
  "Strict legacy v1 or server-observed v2 read parser; never used for Admin create.",
);

export const RepositoryExecutionContextSchema = z.object({
  organizationId: uuid,
  applicationId: uuid,
  repositoryId: uuid,
  id: uuid,
  revision: z.number().int().positive().describe(
    "Frozen immutable profile revision.",
  ),
  digest,
  config: RepositoryVersionedProfileConfigSchema,
  observationId: z.union([
    uuid,
    z.null().describe("Strict-v1 execution has no observed publication."),
  ]).describe("Exact eligible observed-v2 publication, or null for strict-v1."),
  observationDigest: z.union([
    digest,
    z.null().describe(
      "Strict-v1 execution has no immutable observation digest.",
    ),
  ]).describe("Canonical immutable observation digest, or null for strict-v1."),
  baseSha: z.union([
    sha,
    z.null().describe("Strict-v1 execution has no inspected source commit."),
  ]).describe("Exact inspected source commit, or null for strict-v1."),
  fixedPolicyDigest: digest.optional().describe(
    "Canonical digest of the effective fixed policy when one governs this execution.",
  ),
  trustedCheckerConfigDigest: digest.optional().describe(
    "Pinned trusted checker configuration digest when fixed policy governs this execution.",
  ),
  repositoryRules: PinnedRepositoryRulesSchema.optional().describe(
    "Effective repository rules frozen at run admission; absent only on snapshots admitted before rule pinning.",
  ),
}).strict().refine((context) =>
  context.config.schemaVersion === 1
    ? context.observationId === null && context.observationDigest === null &&
      context.baseSha === null
    : context.observationId !== null && context.observationDigest !== null &&
      context.baseSha !== null
).refine((context) =>
  context.config.fixedPolicy === undefined
    ? context.fixedPolicyDigest === undefined &&
      context.trustedCheckerConfigDigest === undefined
    : context.config.schemaVersion === 2 &&
      context.fixedPolicyDigest !== undefined &&
      context.trustedCheckerConfigDigest ===
        context.config.fixedPolicy.trustedChecker.configDigest
).refine((context) =>
  context.repositoryRules === undefined ||
  (context.repositoryRules.profileId === context.id &&
    context.repositoryRules.profileRevision === context.revision)
).describe(
  "Authorized frozen repository/profile/observation context; never supplied by a caller.",
);

export const RepositoryExecutionRequirementsSchema = z.object({
  capabilities: z.array(
    z.string().min(1).max(100).describe(
      "One enrolled action or actual required tool capability.",
    ),
  )
    .max(100).describe(
      "Unique finite intersection with persisted authenticated host capabilities.",
    ),
  platform: z.string().min(1).max(100).describe(
    "Persisted native execution OS gate; observed-v2 must require Linux.",
  )
    .optional().describe(
      "Observed Linux gate or an existing explicit stricter platform requirement.",
    ),
}).catchall(
  z.json().describe(
    "Existing JSON requirement metadata retained without weakening capability/platform gates.",
  ),
)
  .describe(
    "Server-derived action/tool/platform gates, retaining existing stricter capability and metadata requirements.",
  );
export type RepositoryExecutionRequirements = z.infer<
  typeof RepositoryExecutionRequirementsSchema
>;
export const RepositoryInspectionSourceIdentitySchema = z.object({
  mappingRevision: z.string().min(1).max(128).refine((value) =>
    new TextEncoder().encode(value).length <= 128 &&
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ).describe("Exact trusted operator mapping revision."),
  mappingDigest: digest,
  baseSha: sha,
  manifestDigest: digest,
}).strict().describe(
  "Exact trusted mapping, commit and regular-file manifest identity.",
);
export const RepositoryInspectionJobInputSchema = z.object({
  inspectionId: uuid,
  jobId: uuid,
  organizationId: uuid,
  applicationId: uuid,
  repositoryId: uuid,
  baseline: z.object({
    profileId: uuid,
    revision: z.number().int().positive().describe(
      "Locked active baseline revision.",
    ),
    digest,
    repositoryVersion: z.number().int().positive().describe(
      "Locked repository optimistic version.",
    ),
    defaultBranch: z.string().min(1).max(255).describe(
      "Locked repository default branch.",
    ),
  }).strict().describe("Publication must still match this exact baseline."),
  profile: z.object({
    id: uuid,
    revision: z.number().int().positive().describe(
      "Reserved new immutable profile revision.",
    ),
    digest,
    config: RepositoryObservedProfileConfigSchema,
  }).strict().describe(
    "Server-proposed observed profile, independently canonical-hashed.",
  ),
  source: RepositoryInspectionSourceIdentitySchema.extend({
    envelopeDigest: digest,
    envelopeBytes: z.number().int().positive().max(8 * 1024 * 1024).describe(
      "Exact encoded canonical envelope bytes.",
    ),
    decodedBytes: z.number().int().nonnegative().max(4 * 1024 * 1024).describe(
      "Exact aggregate decoded regular-file bytes.",
    ),
    entryCount: z.number().int().nonnegative().max(1024).describe(
      "Exact regular-file count.",
    ),
  }).strict().describe(
    "Pinned source identity and independently bounded transfer size.",
  ),
}).strict().describe(
  "Bounded server-owned inspection input; no source bytes, paths or credentials.",
);
export const RepositoryInspectionSourceEnvelopeSchema = z.object({
  organizationId: uuid,
  applicationId: uuid,
  repositoryId: uuid,
  source: RepositoryInspectionSourceIdentitySchema,
  entries: z.array(
    z.object({
      path: RepositoryInspectionPathSchema,
      mode: z.enum(["100644", "100755"]).describe(
        "Git regular-file mode; links and submodules prohibited.",
      ),
      sha256: digest,
      contentBase64: z.string().max(1398104).regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ).describe("Canonical base64 of at most one MiB regular-file bytes."),
    }).strict().describe(
      "One exact manifest file and independently verified content.",
    ),
  ).max(1024).describe("Lexically sorted unique safe regular files."),
}).strict().describe(
  "Canonical bounded source envelope; envelope digest hashes this entire value.",
);
export const RepositoryInspectionReceiptSchema = z.object({
  inspectionId: uuid,
  jobId: uuid,
  organizationId: uuid,
  applicationId: uuid,
  repositoryId: uuid,
  inputDigest: digest,
  source: RepositoryInspectionJobInputSchema.shape.source,
  attemptId: uuid,
  fence: decimal,
  workerHostId: uuid,
  workerSessionId: uuid,
  workerSessionGeneration: decimal,
  expiresAt: timestamp,
}).strict().describe(
  "Source-specific exact attempt receipt; fixed attempt-created deadline, no lease secret.",
);
export const RepositoryInspectionSourceChunkSchema = z.object({
  receipt: RepositoryInspectionReceiptSchema,
  offset: z.number().int().nonnegative().max(8 * 1024 * 1024).describe(
    "Exact contiguous decoded envelope byte offset.",
  ),
  totalBytes: z.number().int().positive().max(8 * 1024 * 1024).describe(
    "Stable exact canonical envelope transfer length.",
  ),
  chunkDigest: digest,
  bytesBase64: z.string().max(43692).regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  ).describe("Canonical base64 of at most 32 KiB transfer bytes."),
  done: z.boolean().describe(
    "True only when this chunk reaches the exact final byte.",
  ),
}).strict().describe(
  "One bounded authenticated source chunk with unchanged receipt.",
);
export const RepositoryInspectionHostSchema = z.object({
  workerHostId: uuid,
  os: z.enum(["linux", "macos", "windows"]).describe(
    "Actual execution host OS.",
  ),
  architecture: z.enum(["x64", "arm64"]).describe(
    "Actual execution CPU in the existing enrolled worker architecture vocabulary.",
  ),
  tools: z.array(
    z.object({
      tool: RepositoryInspectionToolSchema,
      status: z.enum(["available", "missing"]).describe(
        "Actual bounded version-command availability.",
      ),
      version: z.union([
        z.string().min(1).max(256).refine((value) =>
          [...value].every((character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          )
        ).describe("Sanitized actual version line."),
        z.null().describe("No usable bounded tool version was observed."),
      ]).describe("Sanitized actual version line; null when absent."),
      outputDigest: z.union([
        digest,
        z.null().describe(
          "No usable tool-version output evidence was recorded.",
        ),
      ]).describe(
        "Hash of actual bounded version command output, or null when unavailable.",
      ),
    }).strict().describe("Actual native host tool evidence."),
  ).min(1).max(3).describe("One actual result for each policy tool."),
}).strict().describe(
  "Actual enrolled worker host evidence, never API-host discovery.",
);
export const RepositoryInspectionCheckResultSchema = z.object({
  id: RepositoryInspectionCheckSchema.shape.id,
  template: RepositoryInspectionCheckSchema.shape.template,
  required: z.boolean().describe("Unmodified server policy requirement."),
  status: z.enum(["passed", "failed", "missing", "unsupported"]).describe(
    "Actual result; missing and unsupported required checks block readiness.",
  ),
  reason: z.enum([
    "verified",
    "exit_nonzero",
    "tool_missing",
    "unsupported_command",
    "deadline",
    "output_limit",
    "platform_mismatch",
    "source_invalid",
  ]).describe("Redacted finite outcome reason; no raw output or path."),
  exitCode: z.union([
    z.number().int().min(0).max(255).describe(
      "Actual process exit status from 0 through 255.",
    ),
    z.null().describe("No normal process exit status was observed."),
  ]).describe(
    "Actual process exit status, or null when no exit status was observed.",
  ),
  outputDigest: z.union([
    digest,
    z.null().describe(
      "No command output evidence was recorded for this check.",
    ),
  ]).describe("Actual bounded command output digest; never raw stdout."),
  durationMs: z.number().int().nonnegative().max(60000).describe(
    "Measured bounded execution duration.",
  ),
}).strict().describe("One coherent result for exactly one server-owned check.");
export const RepositoryInspectionReportSchema = z.object({
  input: RepositoryInspectionJobInputSchema,
  receipt: RepositoryInspectionReceiptSchema,
  host: RepositoryInspectionHostSchema,
  checks: z.array(RepositoryInspectionCheckResultSchema).min(1).max(64)
    .describe(
      "Exactly one result per policy check; verified independently on publication.",
    ),
  startedAt: timestamp,
  completedAt: timestamp,
}).strict().describe(
  "Exact native worker inspection evidence bounded to 64 KiB; readiness is server-derived.",
);
export const RepositoryProfileObservationPayloadSchema = z.object({
  schemaVersion: z.literal(1).describe("Immutable observation payload format."),
  inspectionId: uuid,
  jobId: uuid,
  organizationId: uuid,
  applicationId: uuid,
  repositoryId: uuid,
  profileId: uuid,
  profileRevision: z.number().int().positive().describe(
    "Exact new observed profile revision.",
  ),
  profileDigest: digest,
  source: RepositoryInspectionJobInputSchema.shape.source,
  receipt: RepositoryInspectionReceiptSchema,
  host: RepositoryInspectionHostSchema,
  checks: RepositoryInspectionReportSchema.shape.checks,
  readiness: z.enum(["eligible", "blocked"]).describe(
    "Server-derived required-check and platform readiness, not worker authority.",
  ),
  observedAt: timestamp,
}).strict().describe(
  "Immutable exact profile/source/host observation without source paths, raw command output or lease credentials.",
);

export type RepositoryObservedProfileConfig = z.output<
  typeof RepositoryObservedProfileConfigSchema
>;
export type RepositoryVersionedProfileConfig = z.output<
  typeof RepositoryVersionedProfileConfigSchema
>;
export type RepositoryInspectionJobInput = z.output<
  typeof RepositoryInspectionJobInputSchema
>;
export type RepositoryInspectionSourceEnvelope = z.output<
  typeof RepositoryInspectionSourceEnvelopeSchema
>;
export type RepositoryInspectionReceipt = z.output<
  typeof RepositoryInspectionReceiptSchema
>;
export type RepositoryInspectionSourceChunk = z.output<
  typeof RepositoryInspectionSourceChunkSchema
>;
export type RepositoryInspectionReport = z.output<
  typeof RepositoryInspectionReportSchema
>;
export type RepositoryProfileObservationPayload = z.output<
  typeof RepositoryProfileObservationPayloadSchema
>;
export type RepositoryInspectionCheckPolicy = z.output<
  typeof RepositoryInspectionCheckPolicySchema
>;
export type RepositoryInspectionCheck = z.output<
  typeof RepositoryInspectionCheckSchema
>;
export type RepositoryInspectionCheckResult = z.output<
  typeof RepositoryInspectionCheckResultSchema
>;
export type RepositoryInspectionHost = z.output<
  typeof RepositoryInspectionHostSchema
>;
