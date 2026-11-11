import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest bound to immutable prepared-operation input or output.",
);

export const SecretIdentityReadInputSchema = z.object({
  secretRef: z.string().uuid().describe(
    "Opaque project credential reference resolved only inside the server trust boundary.",
  ),
}).strict().describe(
  "Workflow-owned fixed identity input before the server adds frozen repository context.",
);

export const SealedCredentialOperationSchema = z.object({
  preparedOperationId: z.string().uuid().describe(
    "Opaque prepared server operation bound to one claimed attempt.",
  ),
  jobId: z.string().uuid().describe(
    "Job bound to the prepared operation.",
  ),
  attemptId: z.string().uuid().describe(
    "Attempt bound to the prepared operation.",
  ),
  inputDigest: sha256Schema.describe(
    "SHA-256 of the exact admitted identity input, including server-owned repository context.",
  ),
  expiresAt: z.string().datetime({ offset: true }).describe(
    "Server-authoritative expiry no more than 30 seconds after preparation.",
  ),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512) {
    context.addIssue({
      code: "custom",
      message: "sealed credential operation exceeds 512 bytes",
    });
  }
}).describe(
  "Daemon-only sealed operation reference; it carries no credential, ciphertext, key, bearer token or provider selector.",
);

export const SecretIdentityToolRequestSchema = z.object({
  preparedOperationId: z.string().uuid().describe(
    "Opaque prepared-operation identifier from the encrypted assignment replay.",
  ),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 128) {
    context.addIssue({
      code: "custom",
      message: "prepared identity request exceeds 128 bytes",
    });
  }
}).describe(
  "Bounded daemon-only request for the one server-selected fixed identity operation.",
);

export const SecretIdentityInvocationProofSchema = z.object({
  leaseToken: z.string().min(1).max(512).describe(
    "Opaque current attempt lease proof; never logged or persisted in plaintext.",
  ),
  fence: z.string().regex(/^(?:0|[1-9][0-9]*)$/).describe(
    "Current decimal attempt fence copied from the leased assignment.",
  ),
  workerSessionId: z.string().uuid().describe(
    "Authenticated worker process session bound to the prepared attempt.",
  ),
  workerSessionGeneration: z.string().regex(/^(?:0|[1-9][0-9]*)$/).describe(
    "Monotonic authenticated worker process-session generation.",
  ),
}).strict().describe(
  "Lease, fence and process-session proof for daemon-only prepared invocation.",
);

const completedResultSchema = z.object({
  status: z.literal("completed").describe(
    "Fixed provider identity read completed.",
  ),
  accountId: z.string().regex(/^[1-9][0-9]*$/).max(16).describe(
    "Bounded stored numeric provider account identifier.",
  ),
  login: z.string().min(1).max(39).describe(
    "Bounded safe provider login.",
  ),
}).strict().describe("Safe successful identity projection.");

export const SecretIdentityDenialCodeSchema = z.enum([
  "SECRET_REVOKED",
  "SECRET_GENERATION_STALE",
  "SECRET_POLICY_STALE",
  "SECRET_OPERATION_EXPIRED",
  "LEASE_FENCED",
  "SESSION_REBOUND",
  "INPUT_DIGEST_MISMATCH",
]).describe("Safe code for an authority denial before provider publication.");

const deniedResultSchema = z.object({
  status: z.literal("denied").describe(
    "Live authority rejected the operation before provider publication.",
  ),
  code: SecretIdentityDenialCodeSchema,
}).strict().describe("Safe denied identity projection.");

export const SecretIdentityUncertainCodeSchema = z.enum([
  "PROVIDER_OUTCOME_UNCERTAIN",
  "COMPLETION_AUTHORITY_LOST",
  "OPERATION_RECOVERY_UNCERTAIN",
]).describe(
  "Safe code for an outcome that must never be retried automatically.",
);

const uncertainResultSchema = z.object({
  status: z.literal("uncertain").describe(
    "Provider effect cannot be known and will never be retried automatically.",
  ),
  code: SecretIdentityUncertainCodeSchema,
}).strict().describe("Safe uncertain identity projection.");

export const SecretIdentityToolResultSchema = z.discriminatedUnion("status", [
  completedResultSchema,
  deniedResultSchema,
  uncertainResultSchema,
]).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024) {
    context.addIssue({
      code: "custom",
      message: "safe identity result exceeds 1024 bytes",
    });
  }
}).describe(
  "Bounded terminal result for the code-owned identity action; no credential, ciphertext, key, bearer token, lease token or raw provider body.",
);

export type SecretIdentityReadInput = z.output<
  typeof SecretIdentityReadInputSchema
>;
export type SealedCredentialOperation = z.output<
  typeof SealedCredentialOperationSchema
>;
export type SecretIdentityToolRequest = z.output<
  typeof SecretIdentityToolRequestSchema
>;
export type SecretIdentityInvocationProof = z.output<
  typeof SecretIdentityInvocationProofSchema
>;
export type SecretIdentityToolResult = z.output<
  typeof SecretIdentityToolResultSchema
>;
