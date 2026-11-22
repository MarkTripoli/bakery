import { z } from "zod";
import { DEPLOYMENT_ENVIRONMENTS } from "./deployment-states.ts";

/**
 * The delivery adapter contract (#43, B10.06; design 06, "delivery adapter
 * contract"): the five calls a deployment target answers, in provider-neutral
 * terms. A target never receives a command from workflow data; it receives a
 * release it already verified and an effect key, and answers with a status.
 *
 * Two rules every target keeps:
 * - A call with an effect key that was already used answers with what the
 *   first call did. It never runs the mutation a second time.
 * - `status` answers `failed` only when it can prove the mutation did not
 *   happen; otherwise it answers `unknown`, and nothing else is changed until
 *   a later read says what really happened.
 */

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/).describe(
  "Full lowercase git commit SHA of the merged revision.",
);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/).describe(
  "Content digest of the built release artifact, as sha256:<64 hex digits>.",
);
const EffectKeySchema = z.string().min(1).max(200).describe(
  "Stable key of one deploy or rollback request. The same key never runs the mutation twice.",
);
const TargetIdSchema = z.string().min(1).max(200).describe(
  "Identifier the target gave to a release, a deployment or an effect. Opaque to Bakery.",
);

export const PrepareReleaseInputSchema = z.strictObject({
  repositoryId: z.string().min(1).max(200).describe(
    "Repository whose merged revision is being released.",
  ),
  headSha: CommitShaSchema,
  profileRevision: z.number().int().positive().describe(
    "Revision of the repository profile that decided how the artifact is built.",
  ),
  expectedDigest: DigestSchema.optional().describe(
    "Digest the caller verified earlier. A built artifact with another digest is refused.",
  ),
}).describe(
  "What prepare is asked to stage: one verified artifact of one revision.",
);
export type PrepareReleaseInput = z.infer<typeof PrepareReleaseInputSchema>;

export const PreparedReleaseSchema = z.strictObject({
  releaseId: TargetIdSchema,
  artifactDigest: DigestSchema,
  environment: z.enum(DEPLOYMENT_ENVIRONMENTS).describe(
    "Environment this release was staged for.",
  ),
  status: z.literal("prepared").describe(
    "A prepared release serves nothing yet.",
  ),
}).describe("An immutable release staged by the target, ready to be deployed.");
export type PreparedRelease = z.infer<typeof PreparedReleaseSchema>;

export const DeployReleaseInputSchema = z.strictObject({
  releaseId: TargetIdSchema,
  effectKey: EffectKeySchema,
}).describe("Which prepared release to make live, under which effect key.");
export type DeployReleaseInput = z.infer<typeof DeployReleaseInputSchema>;

export const DeployReleaseResultSchema = z.strictObject({
  deploymentId: TargetIdSchema,
  commitSha: CommitShaSchema,
  effectId: TargetIdSchema,
  status: z.enum(["queued", "deploying", "unknown", "failed"]).describe(
    "What the target accepted. Only a deploying release is verified next.",
  ),
}).describe("The target's answer to a deploy request.");
export type DeployReleaseResult = z.infer<typeof DeployReleaseResultSchema>;

/**
 * What a read can say about an effect. A deploy effect answers queued,
 * deploying, healthy, degraded, failed or unknown; a rollback effect answers
 * rolling_back, rolled_back, failed or unknown.
 */
export const OBSERVED_STATUSES = [
  "queued",
  "deploying",
  "healthy",
  "degraded",
  "failed",
  "rolling_back",
  "rolled_back",
  "unknown",
] as const;

export const ReadEffectInputSchema = z.strictObject({
  effectKey: EffectKeySchema,
  deploymentId: TargetIdSchema.optional().describe(
    "The target's deployment id when the caller has it. A lost answer leaves it unknown, so the effect key alone must be enough.",
  ),
}).describe("Which effect to read back.");
export type ReadEffectInput = z.infer<typeof ReadEffectInputSchema>;

export const ObservedEffectSchema = z.strictObject({
  deploymentId: TargetIdSchema.nullable().describe(
    "The deployment the effect belongs to, or null when the target never saw the key.",
  ),
  effectId: TargetIdSchema.nullable().describe(
    "The effect the target recorded for the key, or null when it never saw it.",
  ),
  status: z.enum(OBSERVED_STATUSES).describe("What the target observed."),
  observedCommitSha: CommitShaSchema.optional().describe(
    "The commit the environment serves now, when the target can read it.",
  ),
}).describe("What reading an effect back found.");
export type ObservedEffect = z.infer<typeof ObservedEffectSchema>;

export const HealthInputSchema = z.strictObject({
  deploymentId: TargetIdSchema,
}).describe("Which accepted deployment to check.");
export type HealthInput = z.infer<typeof HealthInputSchema>;

export const HealthResultSchema = z.strictObject({
  deploymentId: TargetIdSchema,
  status: z.enum(["healthy", "degraded", "failed"]).describe(
    "Only healthy is a success: the running release reported the exact revision and an ok state.",
  ),
  checkedAt: z.iso.datetime().describe(
    "When the target read the release's health.",
  ),
  evidenceArtifactId: z.uuid().describe(
    "Artifact version that holds what the target observed.",
  ),
}).describe("A health check of one deployment, with its evidence.");
export type HealthResult = z.infer<typeof HealthResultSchema>;

export const RollbackInputSchema = z.strictObject({
  deploymentId: TargetIdSchema,
  effectKey: EffectKeySchema,
}).describe("Which deployment to roll back, under which effect key.");
export type RollbackInput = z.infer<typeof RollbackInputSchema>;

export const RollbackResultSchema = z.strictObject({
  deploymentId: TargetIdSchema,
  restoredCommitSha: CommitShaSchema,
  effectId: TargetIdSchema,
  status: z.enum(["rolling_back", "rolled_back", "unknown", "failed"]).describe(
    "Only rolled_back means the previous release serves again.",
  ),
}).describe("The target's answer to a rollback request.");
export type RollbackResult = z.infer<typeof RollbackResultSchema>;

export type ReleaseAdapter = Readonly<{
  prepare(input: PrepareReleaseInput): Promise<PreparedRelease>;
  deploy(input: DeployReleaseInput): Promise<DeployReleaseResult>;
  status(input: ReadEffectInput): Promise<ObservedEffect>;
  health(input: HealthInput): Promise<HealthResult>;
  rollback(input: RollbackInput): Promise<RollbackResult>;
}>;

export const RELEASE_REFUSALS = [
  "invalid_request",
  "artifact_missing",
  "digest_mismatch",
  "release_changed",
  "no_such_release",
  "no_such_deployment",
  "no_previous_release",
  "effect_key_reused",
] as const;
export type ReleaseRefusal = (typeof RELEASE_REFUSALS)[number];

/**
 * A refusal made before anything in the environment changed. The caller may
 * settle on `failed` at once. Any other error from `deploy` or `rollback` is
 * an answer that may have been lost: the outcome is `unknown`.
 */
export class ReleaseRefused extends Error {
  readonly refusal: ReleaseRefusal;
  constructor(refusal: ReleaseRefusal, detail?: string) {
    super(detail === undefined ? refusal : `${refusal}: ${detail}`);
    this.name = "ReleaseRefused";
    this.refusal = refusal;
  }
}

/** Effect key of the one deploy of a deployment record. */
export function deployEffectKey(deploymentId: string): string {
  return `deploy:${deploymentId}`;
}

/** Effect key of one rollback attempt; `version` is the record's version when it entered rolling_back. */
export function rollbackEffectKey(
  deploymentId: string,
  version: number,
): string {
  return `rollback:${deploymentId}:${version}`;
}
