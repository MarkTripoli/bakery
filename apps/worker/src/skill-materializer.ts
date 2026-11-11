import type { WorkerApiClient, WorkerResponse } from "./client.ts";
import { SkillCache, type SkillCacheReconciler } from "./skill-cache.ts";
import type {
  PreparedSkillContext,
  PreparedSkillRoot,
  SkillCacheIdentity,
  SkillFileManifestEntry,
  SkillMaterializationOwner,
  SkillMaterializationRequest,
  WorkerSkillFileRequest,
  WorkerSkillFileResponse,
  WorkerSkillVersionRequest,
  WorkerSkillVersionResponse,
} from "./types.ts";

export type WorkerSkillClient = Pick<
  WorkerApiClient,
  "getSkillVersion" | "getSkillFile"
>;

export class SkillMaterializationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillMaterializationError";
  }
}

function fail(code: string): never {
  throw new SkillMaterializationError(code);
}

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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function ownerFromRequest(
  request: SkillMaterializationRequest,
): SkillMaterializationOwner {
  const { assignment } = request;
  if (
    assignment.workerSessionId !== request.workerSessionId ||
    assignment.workerSessionGeneration !== request.workerSessionGeneration
  ) fail("SKILL_MATERIALIZATION_SESSION_MISMATCH");
  return Object.freeze({
    workerHostId: assignment.workerHostId,
    workerSessionId: request.workerSessionId,
    workerSessionGeneration: request.workerSessionGeneration,
    jobId: assignment.jobId,
    attemptId: assignment.attemptId,
    fence: assignment.fence,
  });
}

function assignmentSnapshot(request: SkillMaterializationRequest): string {
  return canonicalJson({
    owner: ownerFromRequest(request),
    leaseToken: request.assignment.leaseToken,
    skillRefs: request.assignment.skillRefs,
  });
}

function versionRequest(
  request: SkillMaterializationRequest,
  versionId: string,
  digest: string,
): WorkerSkillVersionRequest {
  const { assignment } = request;
  return Object.freeze({
    workerHostId: assignment.workerHostId,
    attemptId: assignment.attemptId,
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    workerSessionId: request.workerSessionId,
    workerSessionGeneration: request.workerSessionGeneration,
    versionId,
    digest,
  });
}

function sameAuthority(
  initial: WorkerSkillVersionResponse,
  current: WorkerSkillVersionResponse,
): boolean {
  return initial.organizationId === current.organizationId &&
    initial.attemptId === current.attemptId &&
    initial.workerHostId === current.workerHostId &&
    initial.workerSessionId === current.workerSessionId &&
    initial.workerSessionGeneration === current.workerSessionGeneration &&
    initial.fence === current.fence &&
    initial.version.id === current.version.id &&
    initial.version.digest === current.version.digest &&
    initial.version.entryPath === current.version.entryPath &&
    canonicalJson(initial.version.manifest) ===
      canonicalJson(current.version.manifest) &&
    canonicalJson(initial.files) === canonicalJson(current.files);
}

function requireVersion(
  response: WorkerResponse<WorkerSkillVersionResponse>,
  request: WorkerSkillVersionRequest,
): WorkerSkillVersionResponse {
  const value = response.value;
  if (
    value.attemptId !== request.attemptId ||
    value.workerHostId !== request.workerHostId ||
    value.workerSessionId !== request.workerSessionId ||
    value.workerSessionGeneration !== request.workerSessionGeneration ||
    value.fence !== request.fence || value.version.id !== request.versionId ||
    value.version.digest !== request.digest
  ) fail("SKILL_MATERIALIZATION_AUTHORITY_MISMATCH");
  return value;
}

function requireFile(
  response: WorkerResponse<WorkerSkillFileResponse>,
  request: WorkerSkillFileRequest,
): Uint8Array {
  const value = response.value;
  if (
    value.organizationId !== request.organizationId ||
    value.attemptId !== request.attemptId ||
    value.workerHostId !== request.workerHostId ||
    value.workerSessionId !== request.workerSessionId ||
    value.workerSessionGeneration !== request.workerSessionGeneration ||
    value.fence !== request.fence || value.versionId !== request.versionId ||
    value.versionDigest !== request.digest ||
    value.path !== request.file.path ||
    value.mediaType !== request.file.mediaType ||
    value.sizeBytes !== request.file.sizeBytes ||
    value.sha256 !== request.file.sha256 ||
    value.isExecutable !== request.file.isExecutable
  ) fail("SKILL_MATERIALIZATION_FILE_MISMATCH");
  return value.content;
}

async function releaseAll(
  cache: SkillCache,
  roots: readonly PreparedSkillRoot[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const root of [...roots].reverse()) {
    try {
      await cache.releasePrepared(root);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "SKILL_MATERIALIZATION_RELEASE_FAILED");
  }
}

/**
 * Materializes exact server-authorized pins into independent private trees.
 * Native children remain trusted same-UID processes; these paths are not an
 * operating-system sandbox.
 */
export class SkillMaterializer {
  constructor(
    readonly cache: SkillCache,
    readonly client: WorkerSkillClient,
  ) {}

  async initialize(): Promise<void> {
    await this.cache.initialize();
  }

  async recover(
    reconcile: SkillCacheReconciler,
    signal: AbortSignal,
  ): Promise<void> {
    await this.cache.recover(reconcile, signal);
  }

  async prepare(
    request: SkillMaterializationRequest,
    signal: AbortSignal,
  ): Promise<PreparedSkillContext> {
    await this.initialize();
    throwIfAborted(signal);
    const owner = ownerFromRequest(request);
    const snapshot = assignmentSnapshot(request);
    const refs = [...request.assignment.skillRefs];
    const unique = new Set(refs.map((ref) => `${ref.versionId}:${ref.digest}`));
    if (unique.size !== refs.length) {
      fail("SKILL_MATERIALIZATION_DUPLICATE_PIN");
    }
    if (refs.length === 0) {
      return Object.freeze({
        owner,
        roots: Object.freeze([]),
        release: () => Promise.resolve(),
      });
    }

    const prepared: PreparedSkillRoot[] = [];
    const authorized = new Map<string, WorkerSkillVersionResponse>();
    const requests = new Map<string, WorkerSkillVersionRequest>();
    try {
      for (const ref of refs) {
        throwIfAborted(signal);
        const key = `${ref.versionId}:${ref.digest}`;
        const readRequest = versionRequest(
          request,
          ref.versionId,
          ref.digest,
        );
        requests.set(key, readRequest);
        const initial = requireVersion(
          await this.client.getSkillVersion(readRequest, signal),
          readRequest,
        );
        authorized.set(key, initial);
        const identity: SkillCacheIdentity = Object.freeze({
          organizationId: initial.organizationId,
          versionId: ref.versionId,
          digest: ref.digest,
        });
        const entry = await this.cache.acquire(
          identity,
          owner,
          initial,
          signal,
          async (file: SkillFileManifestEntry) => {
            const fileRequest: WorkerSkillFileRequest = Object.freeze({
              ...readRequest,
              organizationId: identity.organizationId,
              file,
            });
            return requireFile(
              await this.client.getSkillFile(fileRequest, signal),
              fileRequest,
            );
          },
          async () => {
            const current = requireVersion(
              await this.client.getSkillVersion(readRequest, signal),
              readRequest,
            );
            if (!sameAuthority(initial, current)) {
              fail("SKILL_MATERIALIZATION_AUTHORITY_CHANGED");
            }
            return current;
          },
        );
        prepared.push(
          await this.cache.prepareAttempt(entry, owner, initial, signal),
        );
      }

      // Every private copy exists and has been verified before this final,
      // complete server authority pass. No object-file endpoint is used here.
      for (const ref of refs) {
        const key = `${ref.versionId}:${ref.digest}`;
        const readRequest = requests.get(key)!;
        const current = requireVersion(
          await this.client.getSkillVersion(readRequest, signal),
          readRequest,
        );
        if (!sameAuthority(authorized.get(key)!, current)) {
          fail("SKILL_MATERIALIZATION_AUTHORITY_CHANGED");
        }
      }
      throwIfAborted(signal);
      if (assignmentSnapshot(request) !== snapshot) {
        fail("SKILL_MATERIALIZATION_ASSIGNMENT_CHANGED");
      }

      let releasePromise: Promise<void> | null = null;
      const roots = Object.freeze([...prepared]);
      return Object.freeze({
        owner,
        roots,
        release: () => releasePromise ??= releaseAll(this.cache, roots),
      });
    } catch (error) {
      try {
        await releaseAll(this.cache, prepared);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "SKILL_MATERIALIZATION_PREPARE_AND_RELEASE_FAILED",
        );
      }
      throw error;
    }
  }
}
