import { type Context } from "hono";
import { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  WORKER_SKILL_READ_HEADERS,
  WORKER_SKILL_RESPONSE_HEADERS,
  type WorkerSkillFileResponseMetadata,
  WorkerSkillFileRouteSchema,
  type WorkerSkillReadAuthority,
  WorkerSkillReadAuthoritySchema,
  type WorkerSkillVersionResponse,
  WorkerSkillVersionResponseSchema,
  WorkerSkillVersionRouteSchema,
} from "@bakery/contracts/worker-skill-read";
import { canonicalJson } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { assertActiveLease, lockAttempt } from "../execution/events.ts";
import {
  assertAttemptMutationSession,
  type ExecutionRouteOptions,
  sha256Hex,
  type WorkerIdentity,
  workerTransaction,
} from "../execution/shared.ts";
import { type SkillVersionRow, toSkillVersion } from "./publication.ts";
import {
  SkillFileStoreError,
  type SkillFileStoreOperations,
} from "./storage.ts";

const READ_TIMEOUT_MILLISECONDS = 10_000;
const CACHE_CONTROL = "no-store";
const pinnedSkillRefsSchema = z.array(contractSchemas.PinnedSkillRef).max(256)
  .describe("Exact immutable skill version pins persisted on one worker job.");

type SkillFileRow = {
  path: string;
  media_type: string;
  object_key: string;
  size_bytes: number;
  sha256: string;
  is_executable: boolean;
};

type AuthorizedSkillRead = Readonly<{
  organizationId: string;
  attemptId: string;
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  fence: string;
  version: z.output<typeof contractSchemas.SkillVersion>;
  files: readonly z.output<typeof contractSchemas.SkillFileManifestEntry>[];
  file?: Readonly<SkillFileRow>;
}>;

export type WorkerSkillReadRouteOptions = ExecutionRouteOptions & {
  skillFileStore?: SkillFileStoreOperations;
};

function malformed(): never {
  throw new StandardError({ code: "MALFORMED_REQUEST" });
}

function contentIntegrity(): never {
  throw new StandardError({ code: "SKILL_CONTENT_INTEGRITY_FAILED" });
}

function parseAuthority(headers: Headers): WorkerSkillReadAuthority {
  const parsed = WorkerSkillReadAuthoritySchema.safeParse({
    attemptId: headers.get(WORKER_SKILL_READ_HEADERS.attemptId),
    leaseToken: headers.get(WORKER_SKILL_READ_HEADERS.leaseToken),
    fence: headers.get(WORKER_SKILL_READ_HEADERS.fence),
    workerSessionId: headers.get(WORKER_SKILL_READ_HEADERS.workerSessionId),
    workerSessionGeneration: headers.get(
      WORKER_SKILL_READ_HEADERS.workerSessionGeneration,
    ),
  });
  if (!parsed.success) malformed();
  return parsed.data;
}

function parseVersionId(context: Context): string {
  const parsed = WorkerSkillVersionRouteSchema.safeParse({
    versionId: context.req.param("id")?.toLowerCase(),
  });
  if (!parsed.success) malformed();
  return parsed.data.versionId;
}

function parseFileRoute(context: Context): { versionId: string; path: string } {
  const parsed = WorkerSkillFileRouteSchema.safeParse({
    versionId: context.req.param("id")?.toLowerCase(),
    path: context.req.param("path"),
  });
  if (!parsed.success) malformed();
  return parsed.data;
}

function fileMetadata(row: SkillFileRow) {
  return {
    path: row.path,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    isExecutable: row.is_executable,
  };
}

async function verifyVersionMetadata(
  row: SkillVersionRow,
  fileRows: readonly SkillFileRow[],
): Promise<{
  version: z.output<typeof contractSchemas.SkillVersion>;
  files: readonly z.output<typeof contractSchemas.SkillFileManifestEntry>[];
}> {
  const parsedVersion = contractSchemas.SkillVersion.safeParse(
    toSkillVersion(row),
  );
  if (!parsedVersion.success) contentIntegrity();
  const manifest = parsedVersion.data.manifest;
  if (
    manifest === null || typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) contentIntegrity();
  const manifestRecord = manifest as Record<string, unknown>;
  const parsedFiles = z.array(contractSchemas.SkillFileManifestEntry).max(256)
    .safeParse(manifestRecord.files);
  if (
    !parsedFiles.success || manifestRecord.entryPath !== row.entry_path ||
    !parsedFiles.data.some((file) => file.path === row.entry_path) ||
    await sha256Hex(canonicalJson(manifestRecord)) !== row.digest
  ) contentIntegrity();
  const byPath = (left: { path: string }, right: { path: string }) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  const persistedFiles = fileRows.map(fileMetadata).sort(byPath);
  const manifestFiles = [...parsedFiles.data].sort(byPath);
  if (canonicalJson(persistedFiles) !== canonicalJson(manifestFiles)) {
    contentIntegrity();
  }
  return { version: parsedVersion.data, files: parsedFiles.data };
}

async function authorizeSkillRead(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  authority: WorkerSkillReadAuthority,
  versionId: string,
  expectedDigest: string | undefined,
  path?: string,
): Promise<AuthorizedSkillRead> {
  const attempt = await lockAttempt(transaction, identity, authority.attemptId);
  assertAttemptMutationSession(
    identity.host,
    attempt,
    authority.workerSessionId,
    authority.workerSessionGeneration,
  );
  const tokenHash = await sha256Hex(authority.leaseToken);
  assertActiveLease(attempt, identity, tokenHash, authority.fence);

  const jobResult = await transaction.query<{
    status: string;
    cancel_requested_at: Date | null;
    current_fence: string | number;
    skill_refs: unknown;
  }>(
    `select status, cancel_requested_at, current_fence, skill_refs
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [attempt.organization_id, attempt.job_id],
  );
  const job = jobResult.rows[0];
  if (!job) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    job.cancel_requested_at !== null ||
    !["leased", "running"].includes(job.status)
  ) throw new StandardError({ code: "CANCEL_REQUESTED" });
  if (BigInt(job.current_fence) !== BigInt(authority.fence)) {
    throw new StandardError({ code: "LEASE_FENCED" });
  }
  const pins = pinnedSkillRefsSchema.safeParse(job.skill_refs);
  if (!pins.success) contentIntegrity();
  const pin = pins.data.find((entry) => entry.versionId === versionId);
  if (!pin || (expectedDigest !== undefined && pin.digest !== expectedDigest)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }

  const versionResult = await transaction.query<
    SkillVersionRow & {
      organization_id: string;
      skill_enabled: boolean;
      source_enabled: boolean;
    }
  >(
    `select version.organization_id,
            version.id, version.skill_id, version.revision,
            version.source_revision, version.digest, version.entry_path,
            version.manifest, version.status, version.created_by,
            version.created_at, version.updated_at, version.version,
            skill.enabled as skill_enabled,
            source.enabled as source_enabled
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
       join bakery.skill_sources as source
         on source.organization_id = skill.organization_id
        and source.id = skill.source_id
      where version.organization_id = $1 and version.id = $2
      for update of version, skill, source`,
    [identity.host.organization_id, versionId],
  );
  const versionRow = versionResult.rows[0];
  if (!versionRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    !versionRow.source_enabled || !versionRow.skill_enabled ||
    versionRow.status !== "published" ||
    versionRow.digest !== pin.digest
  ) throw new StandardError({ code: "AUTH_FORBIDDEN" });

  const fileResult = await transaction.query<SkillFileRow>(
    `select path, media_type, object_key, size_bytes, sha256, is_executable
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2
      order by path`,
    [identity.host.organization_id, versionId],
  );
  const verified = await verifyVersionMetadata(versionRow, fileResult.rows);
  const file = path === undefined
    ? undefined
    : fileResult.rows.find((candidate) => candidate.path === path);
  if (path !== undefined && !file) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return Object.freeze({
    organizationId: identity.host.organization_id,
    attemptId: authority.attemptId,
    workerHostId: identity.host.id,
    workerSessionId: authority.workerSessionId,
    workerSessionGeneration: authority.workerSessionGeneration,
    fence: authority.fence,
    version: verified.version,
    files: verified.files,
    ...(file ? { file: Object.freeze(file) } : {}),
  });
}

function publicMetadata(read: AuthorizedSkillRead): WorkerSkillVersionResponse {
  return WorkerSkillVersionResponseSchema.parse({
    organizationId: read.organizationId,
    attemptId: read.attemptId,
    workerHostId: read.workerHostId,
    workerSessionId: read.workerSessionId,
    workerSessionGeneration: read.workerSessionGeneration,
    fence: read.fence,
    version: read.version,
    files: read.files,
  });
}

function sameAuthorization(
  before: AuthorizedSkillRead,
  after: AuthorizedSkillRead,
): boolean {
  return canonicalJson(before) === canonicalJson(after);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function boundedStoreRead(
  store: SkillFileStoreOperations,
  file: SkillFileRow,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    throw new StandardError({ code: "DEPENDENCY_TIMEOUT" });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new StandardError({ code: "DEPENDENCY_TIMEOUT" }));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject(new StandardError({ code: "DEPENDENCY_TIMEOUT" })),
      READ_TIMEOUT_MILLISECONDS,
    );
  });
  try {
    return await Promise.race([
      store.read(file.object_key, file.sha256, file.size_bytes),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof StandardError) throw error;
    if (error instanceof SkillFileStoreError) {
      if (error.code === "SKILL_CONTENT_INTEGRITY_FAILED") contentIntegrity();
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function noStoreJson(value: unknown): Response {
  return Response.json(value, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

export async function workerSkillVersionRoute(
  context: Context,
  options: WorkerSkillReadRouteOptions,
): Promise<Response> {
  const authority = parseAuthority(context.req.raw.headers);
  const versionId = parseVersionId(context);
  const authorized = await workerTransaction(
    options.database,
    context.req.raw.headers,
    (transaction, identity) =>
      authorizeSkillRead(
        transaction,
        identity,
        authority,
        versionId,
        undefined,
      ),
  );
  return noStoreJson(publicMetadata(authorized));
}

export async function workerSkillFileRoute(
  context: Context,
  options: WorkerSkillReadRouteOptions,
): Promise<Response> {
  if (!options.skillFileStore) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const authority = parseAuthority(context.req.raw.headers);
  const route = parseFileRoute(context);
  const staged = await workerTransaction(
    options.database,
    context.req.raw.headers,
    (transaction, identity) =>
      authorizeSkillRead(
        transaction,
        identity,
        authority,
        route.versionId,
        undefined,
        route.path,
      ),
  );
  const file = staged.file;
  if (!file) contentIntegrity();
  const bytes = await boundedStoreRead(
    options.skillFileStore,
    file,
    context.req.raw.signal,
  );
  if (
    bytes.byteLength !== file.size_bytes ||
    await sha256Bytes(bytes) !== file.sha256
  ) contentIntegrity();
  const current = await workerTransaction(
    options.database,
    context.req.raw.headers,
    (transaction, identity) =>
      authorizeSkillRead(
        transaction,
        identity,
        authority,
        route.versionId,
        staged.version.digest,
        route.path,
      ),
  );
  if (!sameAuthorization(staged, current)) contentIntegrity();

  const metadata: WorkerSkillFileResponseMetadata = {
    organizationId: current.organizationId,
    attemptId: current.attemptId,
    workerHostId: current.workerHostId,
    workerSessionId: current.workerSessionId,
    workerSessionGeneration: current.workerSessionGeneration,
    fence: current.fence,
    versionId: current.version.id,
    versionDigest: current.version.digest,
    path: file.path,
    mediaType: file.media_type,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    isExecutable: file.is_executable,
  };
  const headers = new Headers({
    "Cache-Control": CACHE_CONTROL,
    "Content-Type": metadata.mediaType,
    "Content-Length": String(metadata.sizeBytes),
    "ETag": `"${metadata.sha256}"`,
    "Content-Disposition": `attachment; filename*=UTF-8''${
      encodeURIComponent(metadata.path.split("/").at(-1)!)
    }`,
    "X-Content-Type-Options": "nosniff",
    [WORKER_SKILL_RESPONSE_HEADERS.organizationId]: metadata.organizationId,
    [WORKER_SKILL_RESPONSE_HEADERS.attemptId]: metadata.attemptId,
    [WORKER_SKILL_RESPONSE_HEADERS.workerHostId]: metadata.workerHostId,
    [WORKER_SKILL_RESPONSE_HEADERS.workerSessionId]: metadata.workerSessionId,
    [WORKER_SKILL_RESPONSE_HEADERS.workerSessionGeneration]:
      metadata.workerSessionGeneration,
    [WORKER_SKILL_RESPONSE_HEADERS.fence]: metadata.fence,
    [WORKER_SKILL_RESPONSE_HEADERS.versionId]: metadata.versionId,
    [WORKER_SKILL_RESPONSE_HEADERS.versionDigest]: metadata.versionDigest,
    [WORKER_SKILL_RESPONSE_HEADERS.filePath]: encodeURIComponent(metadata.path),
    [WORKER_SKILL_RESPONSE_HEADERS.fileSha256]: metadata.sha256,
    [WORKER_SKILL_RESPONSE_HEADERS.fileExecutable]: String(
      metadata.isExecutable,
    ),
  });
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    status: 200,
    headers,
  });
}
