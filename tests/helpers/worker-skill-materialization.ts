import type { WorkerResponse } from "../../apps/worker/src/client.ts";
import type { WorkerSkillClient } from "../../apps/worker/src/skill-materializer.ts";
import type {
  JobAssignment,
  SkillMaterializationRequest,
  WorkerSkillFileRequest,
  WorkerSkillFileResponse,
  WorkerSkillVersionRequest,
  WorkerSkillVersionResponse,
} from "../../apps/worker/src/types.ts";
import { localAssignment } from "./worker-execution/recovery-support.ts";

export type FakeSkillClientHooks = Readonly<{
  beforeManifest?: (call: number) => void | Promise<void>;
  beforeFile?: (
    call: number,
    request: WorkerSkillFileRequest,
  ) => void | Promise<void>;
}>;

export type FakeSkillFixture = Readonly<{
  client: WorkerSkillClient;
  request: SkillMaterializationRequest;
  version: WorkerSkillVersionResponse;
  contents: ReadonlyMap<string, Uint8Array>;
  events: string[];
  counts: Readonly<{ manifests: () => number; files: () => number }>;
}>;

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return JSON.stringify(canonical(value));
}

export async function testSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createFakeSkillFixture(
  hooks: FakeSkillClientHooks = {},
): Promise<FakeSkillFixture> {
  const contents = new Map<string, Uint8Array>([
    ["SKILL.md", new TextEncoder().encode("# exact worker skill\n")],
    ["bin/run.sh", new TextEncoder().encode("#!/bin/sh\nexit 0\n")],
  ]);
  const files = await Promise.all(
    [...contents].map(async ([path, content]) => ({
      path,
      mediaType: path.endsWith(".sh") ? "application/x-sh" : "text/markdown",
      sizeBytes: content.byteLength,
      sha256: await testSha256(content),
      isExecutable: path.endsWith(".sh"),
    })),
  );
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files,
  };
  const digest = await testSha256(
    new TextEncoder().encode(canonicalJson(manifest)),
  );
  const base = localAssignment();
  const assignment = {
    ...base,
    skillRefs: [{
      versionId: "50000000-0000-8000-8000-000000000005",
      digest,
    }],
  } as JobAssignment;
  const request: SkillMaterializationRequest = Object.freeze({
    assignment,
    workerSessionId: assignment.workerSessionId!,
    workerSessionGeneration: assignment.workerSessionGeneration!,
  });
  const version: WorkerSkillVersionResponse = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    attemptId: assignment.attemptId,
    workerHostId: assignment.workerHostId,
    workerSessionId: request.workerSessionId,
    workerSessionGeneration: request.workerSessionGeneration,
    fence: assignment.fence,
    version: {
      id: assignment.skillRefs[0].versionId,
      skillId: "60000000-0000-4000-8000-000000000006",
      revision: 1,
      sourceRevision: "test-source-revision",
      digest,
      entryPath: "SKILL.md",
      manifest,
      status: "published",
      createdBy: "70000000-0000-4000-8000-000000000007",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    },
    files,
  };
  const events: string[] = [];
  let manifestCalls = 0;
  let fileCalls = 0;

  const assertVersionRequest = (read: WorkerSkillVersionRequest): void => {
    if (
      read.leaseToken.length === 0 || read.versionId !== version.version.id ||
      read.digest !== digest
    ) throw new Error("FAKE_SKILL_REQUEST_MISMATCH");
  };

  const client: WorkerSkillClient = {
    async getSkillVersion(
      read: WorkerSkillVersionRequest,
    ): Promise<WorkerResponse<WorkerSkillVersionResponse>> {
      assertVersionRequest(read);
      manifestCalls += 1;
      events.push(`manifest:${manifestCalls}`);
      await hooks.beforeManifest?.(manifestCalls);
      return {
        value: {
          ...structuredClone(version),
          attemptId: read.attemptId,
          workerHostId: read.workerHostId,
          workerSessionId: read.workerSessionId,
          workerSessionGeneration: read.workerSessionGeneration,
          fence: read.fence,
        },
        replayed: false,
      };
    },
    async getSkillFile(
      read: WorkerSkillFileRequest,
    ): Promise<WorkerResponse<WorkerSkillFileResponse>> {
      assertVersionRequest(read);
      if (read.organizationId !== version.organizationId) {
        throw new Error("FAKE_SKILL_ORGANIZATION_MISMATCH");
      }
      fileCalls += 1;
      events.push(`file:${read.file.path}`);
      await hooks.beforeFile?.(fileCalls, read);
      const content = contents.get(read.file.path);
      if (!content) throw new Error("FAKE_SKILL_FILE_MISSING");
      return {
        replayed: false,
        value: {
          organizationId: version.organizationId,
          attemptId: read.attemptId,
          workerHostId: read.workerHostId,
          workerSessionId: read.workerSessionId,
          workerSessionGeneration: read.workerSessionGeneration,
          fence: read.fence,
          versionId: version.version.id,
          versionDigest: digest,
          ...read.file,
          content: new Uint8Array(content),
        },
      };
    },
  };

  return Object.freeze({
    client,
    request,
    version,
    contents,
    events,
    counts: Object.freeze({
      manifests: () => manifestCalls,
      files: () => fileCalls,
    }),
  });
}
