import { z } from "zod";
import { contractSchemas } from "./contracts.ts";

export const WORKER_SKILL_READ_HEADERS = Object.freeze(
  {
    attemptId: "X-Bakery-Attempt-Id",
    leaseToken: "X-Bakery-Lease-Token",
    fence: "X-Bakery-Fence",
    workerSessionId: "X-Worker-Session-Id",
    workerSessionGeneration: "X-Worker-Session-Generation",
  } as const,
);

export const WORKER_SKILL_RESPONSE_HEADERS = Object.freeze(
  {
    organizationId: "X-Bakery-Organization-Id",
    attemptId: "X-Bakery-Attempt-Id",
    workerHostId: "X-Bakery-Worker-Host-Id",
    workerSessionId: "X-Bakery-Worker-Session-Id",
    workerSessionGeneration: "X-Bakery-Worker-Session-Generation",
    fence: "X-Bakery-Fence",
    versionId: "X-Bakery-Skill-Version-Id",
    versionDigest: "X-Bakery-Skill-Version-Digest",
    filePath: "X-Bakery-Skill-File-Path",
    fileSha256: "X-Bakery-Skill-File-Sha256",
    fileExecutable: "X-Bakery-Skill-File-Executable",
  } as const,
);

const uuid = z.string().uuid().describe(
  "Canonical UUID carried by a worker skill read.",
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest carried by a worker skill read.",
);
const decimal = z.string().regex(/^[1-9][0-9]{0,19}$/).describe(
  "Positive decimal lease fence or worker session generation.",
);
const relativePath = z.string().min(1).max(500).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  !value.includes("\0") && !value.endsWith("/") &&
  !value.includes("//") && value.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".."
  )
).describe("Validated relative path for one immutable skill file.");

export const WorkerSkillReadAuthoritySchema = z.object({
  attemptId: uuid.describe("Exact job attempt requesting the pinned skill."),
  leaseToken: z.string().min(1).max(512).describe(
    "Current secret lease token for the exact requesting attempt.",
  ),
  fence: decimal.describe("Current job and attempt fence for the read."),
  workerSessionId: uuid.describe("Current worker process session UUID."),
  workerSessionGeneration: decimal.describe(
    "Current worker process session generation.",
  ),
}).strict().describe(
  "Complete attempt, lease, fence, and process-session authority sent on every worker skill read.",
);

export const WorkerSkillVersionRouteSchema = z.object({
  versionId: uuid.describe(
    "Exact persisted skill version UUID requested by the worker.",
  ),
}).strict().describe("Canonical worker skill-version route parameters.");

export const WorkerSkillFileRouteSchema = z.object({
  versionId: uuid.describe(
    "Exact persisted skill version UUID containing the file.",
  ),
  path: relativePath.describe(
    "Exact manifest path requested from the pinned version.",
  ),
}).strict().describe("Canonical worker skill-file route parameters.");

export const WorkerSkillVersionResponseSchema = z.object({
  organizationId: uuid.describe(
    "Trusted organization namespace derived from the authenticated worker host.",
  ),
  attemptId: uuid.describe("Exact authorized job attempt UUID."),
  workerHostId: uuid.describe("Authenticated worker host UUID."),
  workerSessionId: uuid.describe("Authorized worker process session UUID."),
  workerSessionGeneration: decimal.describe(
    "Authorized worker process session generation.",
  ),
  fence: decimal.describe("Authorized current job and attempt fence."),
  version: contractSchemas.SkillVersion.describe(
    "Canonical published skill version authorized by the exact persisted job pin.",
  ),
  files: z.array(contractSchemas.SkillFileManifestEntry).max(256).describe(
    "Verified canonical file inventory from the immutable skill manifest.",
  ),
}).strict().describe(
  "Lease-authorized immutable skill manifest metadata with trusted cache namespace and attempt identity.",
);

export const WorkerSkillFileResponseMetadataSchema = z.object({
  organizationId: uuid.describe(
    "Trusted organization namespace repeated on the binary response.",
  ),
  attemptId: uuid.describe("Exact authorized job attempt UUID."),
  workerHostId: uuid.describe("Authenticated worker host UUID."),
  workerSessionId: uuid.describe("Authorized worker process session UUID."),
  workerSessionGeneration: decimal.describe(
    "Authorized worker process session generation.",
  ),
  fence: decimal.describe("Authorized current job and attempt fence."),
  versionId: uuid.describe("Exact immutable skill version UUID."),
  versionDigest: sha256.describe("Exact immutable skill manifest digest."),
  path: relativePath.describe(
    "Exact manifest path represented by the response bytes.",
  ),
  mediaType: z.string().min(1).max(255).describe(
    "Manifest media type represented by the Content-Type header.",
  ),
  sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024).describe(
    "Verified response byte length represented by Content-Length.",
  ),
  sha256: sha256.describe("Verified response byte digest."),
  isExecutable: z.boolean().describe(
    "Executable permission projection declared by the immutable manifest.",
  ),
}).strict().describe(
  "Identity, content, type, and permission metadata authenticated alongside one binary skill file response.",
);

export type WorkerSkillReadAuthority = z.output<
  typeof WorkerSkillReadAuthoritySchema
>;
export type WorkerSkillVersionResponse = z.output<
  typeof WorkerSkillVersionResponseSchema
>;
export type WorkerSkillFileResponseMetadata = z.output<
  typeof WorkerSkillFileResponseMetadataSchema
>;
export type WorkerSkillFileResponse = WorkerSkillFileResponseMetadata & {
  readonly content: Uint8Array;
};
