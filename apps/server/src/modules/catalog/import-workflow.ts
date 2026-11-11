import {
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { Inngest, NonRetriableError } from "inngest";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { authorize } from "../auth/application/authorize.ts";
import {
  completeSkillImportExecution,
  failSkillImportExecution,
  loadSkillImportExecution,
  rearmStaleSkillImports,
  recordSkillImportReservation,
  recordSkillImportResolvedProof,
  recordSkillImportStored,
  type SkillImportCheckpointRow,
  startSkillImportExecution,
} from "./import-persistence.ts";
import {
  finalizeSkillVersionPublication,
  prepareSkillVersionPublication,
  reserveSkillVersionPublication,
  type SkillVersionPublicationPreparation,
  storeSkillVersionPublication,
} from "./publication.ts";
import {
  type SkillSourceAdapter,
  type SkillSourceProof,
  validatePinnedSkillSource,
} from "./source-adapters.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import type { ValidatedSkillVersion } from "./validation.ts";

const IMPORT_FUNCTION_ID = "bakery-skill-import";
const IMPORT_RECOVERY_FUNCTION_ID = "bakery-skill-import-recovery";
const IMPORT_EVENT = "bakery/skill.import.requested.v1";
const IMPORT_RECOVERY_EVENT = "bakery/skill-import.reconcile.v1";

type SourceRow = {
  id: string;
  source_type: "git" | "url" | "local_bundle";
  locator: string;
  license: string | null;
  enabled: boolean;
};

type SkillIdentity = Readonly<{ skillId: string; ordinal: number }>;

export type SkillImportExecutionResult = Readonly<{
  runId: string;
  state: "completed" | "failed";
  skillVersionId?: string;
}>;

export type SkillImportCheckpointBoundary =
  | "resolved"
  | "reserved"
  | "stored"
  | "pre_ack";

export type SkillImportProcessHooks = Readonly<{
  afterCheckpoint?: (
    boundary: SkillImportCheckpointBoundary,
    runId: string,
  ) => void | Promise<void>;
}>;

export type SkillImportExecutorOptions = Readonly<{
  database: PgDatabase;
  sourceAdapter: SkillSourceAdapter;
  skillFileStore: SkillFileStoreOperations;
  processHooks?: SkillImportProcessHooks;
}>;

function terminalCode(error: unknown): string {
  const raw = error instanceof StandardError
    ? error.code
    : error instanceof Error
    ? error.message.split(":", 1)[0]
    : "SKILL_IMPORT_FAILED";
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 128);
  return /^[A-Z]/.test(code) ? code : "SKILL_IMPORT_FAILED";
}

const nonRetriableImportCodes = new Set([
  "AUTH_FORBIDDEN",
  "PRECONDITION_FAILED",
  "RESOURCE_NOT_FOUND",
  "SOURCE_INVALID",
  "SOURCE_LIMIT_EXCEEDED",
  "SOURCE_ORIGIN_REJECTED",
  "SOURCE_REVISION_MISMATCH",
  "STATE_CONFLICT",
  "UNPROCESSABLE",
]);

function assertProof(
  checkpoint: SkillImportCheckpointRow,
  proof: SkillSourceProof,
): void {
  if (
    proof.sourceType !== checkpoint.registered_source_type ||
    proof.normalizedLocator !== checkpoint.registered_locator ||
    proof.requestedRevision !== checkpoint.requested_revision ||
    proof.normalizedPath !== checkpoint.source_path ||
    checkpoint.resolved_revision !== null &&
      checkpoint.resolved_revision !== proof.sourceRevision ||
    checkpoint.source_proof_digest !== null &&
      checkpoint.source_proof_digest !== proof.sourceProofDigest
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_import_source_proof_mismatch" },
    });
  }
}

async function requireCurrentAuthorityAndSource(
  transaction: PgTransactionClient,
  checkpoint: SkillImportCheckpointRow,
  principalId: string,
): Promise<SourceRow> {
  const actor = await resolveOrganizationActor(
    transaction,
    toPrincipalId(principalId),
    toOrganizationId(checkpoint.organization_id),
  );
  authorize(actor, "skill:manage", { action: "skills.import" });
  const result = await transaction.query<SourceRow>(
    `select id, source_type, locator, license, enabled
       from bakery.skill_sources
      where organization_id = $1 and id = $2
      for update`,
    [checkpoint.organization_id, checkpoint.source_id],
  );
  const source = result.rows[0];
  if (!source) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    !source.enabled || source.source_type === "local_bundle" ||
    source.source_type !== checkpoint.registered_source_type ||
    source.locator !== checkpoint.registered_locator ||
    source.license !== checkpoint.registered_license
  ) {
    throw new StandardError({
      code: "PRECONDITION_FAILED",
      params: { reason: "skill_import_source_changed" },
    });
  }
  return source;
}

async function ensureSkillIdentity(
  transaction: PgTransactionClient,
  checkpoint: SkillImportCheckpointRow,
  principalId: string,
): Promise<SkillIdentity> {
  await requireCurrentAuthorityAndSource(transaction, checkpoint, principalId);
  if (checkpoint.skill_id !== null && checkpoint.ordinal !== null) {
    return Object.freeze({
      skillId: checkpoint.skill_id,
      ordinal: checkpoint.ordinal,
    });
  }
  const existing = await transaction.query<{ id: string }>(
    `select id from bakery.skills
      where organization_id = $1 and source_id = $2 and source_path = $3
      for update`,
    [checkpoint.organization_id, checkpoint.source_id, checkpoint.source_path],
  );
  let skillId = existing.rows[0]?.id;
  if (!skillId) {
    skillId = crypto.randomUUID();
    const suffix = `${checkpoint.source_id.slice(0, 8)}-${
      checkpoint.id.slice(0, 8)
    }`;
    const pathName = checkpoint.source_path.split("/").at(-1)?.trim() ||
      "imported-skill";
    await transaction.query(
      `insert into bakery.skills (
         id, organization_id, source_id, source_path, slug, name,
         active_version_id, enabled
       ) values ($1, $2, $3, $4, $5, $6, null, true)`,
      [
        skillId,
        checkpoint.organization_id,
        checkpoint.source_id,
        checkpoint.source_path,
        `remote-${suffix}`,
        pathName.slice(0, 200),
      ],
    );
  }
  const latest = await transaction.query<{ revision: number }>(
    `select revision from bakery.skill_versions
      where organization_id = $1 and skill_id = $2
      order by revision desc limit 1`,
    [checkpoint.organization_id, skillId],
  );
  return Object.freeze({
    skillId,
    ordinal: (latest.rows[0]?.revision ?? 0) + 1,
  });
}

function reservationInventory(preparation: SkillVersionPublicationPreparation) {
  return preparation.validated.files.map((file, index) => ({
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    isExecutable: file.isExecutable,
    objectKey: preparation.identity.objectKeys[index],
  }));
}

async function readStoredProof(
  preparation: SkillVersionPublicationPreparation,
  store: SkillFileStoreOperations,
) {
  const objects = new Map<string, {
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }>();
  for (const file of reservationInventory(preparation)) {
    if (objects.has(file.objectKey)) continue;
    await store.read(file.objectKey, file.sha256, file.sizeBytes);
    objects.set(
      file.objectKey,
      Object.freeze({
        objectKey: file.objectKey,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      }),
    );
  }
  return Object.freeze({ objects: Object.freeze([...objects.values()]) });
}

async function prepareAndReserve(
  transaction: PgTransactionClient,
  checkpoint: SkillImportCheckpointRow,
  principalId: string,
  validated: ValidatedSkillVersion,
  sourceRevision: string,
  identity: SkillIdentity,
): Promise<SkillVersionPublicationPreparation> {
  await requireCurrentAuthorityAndSource(transaction, checkpoint, principalId);
  const locked = await transaction.query<{ id: string }>(
    `select id from bakery.skills
      where organization_id = $1 and id = $2 and source_id = $3
        and source_path = $4 and enabled = true
      for update`,
    [
      checkpoint.organization_id,
      identity.skillId,
      checkpoint.source_id,
      checkpoint.source_path,
    ],
  );
  if (!locked.rows[0]) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const preparation = await prepareSkillVersionPublication({
    transaction,
    organizationId: checkpoint.organization_id,
    principalId,
    validated,
    sourceRevision,
    sourceType: checkpoint.registered_source_type,
    requireEnabled: true,
  });
  await reserveSkillVersionPublication(transaction, preparation);
  await recordSkillImportReservation(transaction, {
    organizationId: checkpoint.organization_id,
    runId: checkpoint.run_id,
    skillId: identity.skillId,
    ordinal: identity.ordinal,
    skillVersionId: preparation.identity.versionId,
    manifestDigest: preparation.validated.digest,
    entryPath: preparation.validated.entryPath,
    fileInventory: reservationInventory(preparation),
  });
  return preparation;
}

async function prepareForReplay(
  transaction: PgTransactionClient,
  checkpoint: SkillImportCheckpointRow,
  principalId: string,
  validated: ValidatedSkillVersion,
  sourceRevision: string,
): Promise<SkillVersionPublicationPreparation> {
  if (
    checkpoint.skill_id === null || checkpoint.ordinal === null ||
    checkpoint.skill_version_id === null
  ) throw new StandardError({ code: "STATE_CONFLICT" });
  return await prepareAndReserve(
    transaction,
    checkpoint,
    principalId,
    validated,
    sourceRevision,
    { skillId: checkpoint.skill_id, ordinal: checkpoint.ordinal },
  );
}

export async function executeSkillImport(
  runId: string,
  options: SkillImportExecutorOptions,
): Promise<SkillImportExecutionResult> {
  let execution = await withPgTransaction(
    options.database,
    (transaction) => startSkillImportExecution(transaction, runId),
  );
  if (execution.state === "completed") {
    return Object.freeze({
      runId,
      state: "completed",
      skillVersionId: execution.skill_version_id ?? undefined,
    });
  }
  if (execution.state === "failed") {
    return Object.freeze({ runId, state: "failed" });
  }

  const fetchProof = (checkpoint: SkillImportCheckpointRow) =>
    options.sourceAdapter.fetchPinnedSource({
      sourceType: checkpoint.registered_source_type,
      locator: checkpoint.registered_locator,
      requestedRevision: checkpoint.requested_revision,
      path: checkpoint.source_path || undefined,
      expectedSourceRevision: checkpoint.resolved_revision ?? undefined,
    });

  let proof = await fetchProof(execution);
  assertProof(execution, proof);
  execution = await withPgTransaction(
    options.database,
    (transaction) =>
      recordSkillImportResolvedProof(transaction, {
        organizationId: execution.organization_id,
        runId,
        resolvedRevision: proof.sourceRevision,
        sourceProofDigest: proof.sourceProofDigest,
      }).then(() => loadSkillImportExecution(transaction, runId)),
  );
  await options.processHooks?.afterCheckpoint?.("resolved", runId);

  const identity = await withPgTransaction(
    options.database,
    (transaction) =>
      ensureSkillIdentity(
        transaction,
        execution,
        execution.requested_by,
      ),
  );
  let validated = await validatePinnedSkillSource({
    proof,
    skillId: identity.skillId,
    revision: identity.ordinal,
    registeredLicense: execution.registered_license,
  });
  let preparation = await withPgTransaction(
    options.database,
    (transaction) =>
      prepareAndReserve(
        transaction,
        execution,
        execution.requested_by,
        validated.version,
        proof.sourceRevision,
        identity,
      ),
  );
  execution = await withPgTransaction(
    options.database,
    (transaction) => loadSkillImportExecution(transaction, runId),
  );
  await options.processHooks?.afterCheckpoint?.("reserved", runId);

  if (execution.state === "reserved") {
    const stored = await storeSkillVersionPublication(
      preparation,
      options.skillFileStore,
    );
    await withPgTransaction(
      options.database,
      (transaction) =>
        recordSkillImportStored(transaction, {
          organizationId: execution.organization_id,
          runId,
          objects: stored.objects,
        }),
    );
  }

  execution = await withPgTransaction(
    options.database,
    (transaction) => loadSkillImportExecution(transaction, runId),
  );
  await options.processHooks?.afterCheckpoint?.("stored", runId);
  proof = await fetchProof(execution);
  assertProof(execution, proof);
  if (execution.skill_id === null || execution.ordinal === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  validated = await validatePinnedSkillSource({
    proof,
    skillId: execution.skill_id,
    revision: execution.ordinal,
    registeredLicense: execution.registered_license,
  });
  preparation = await withPgTransaction(
    options.database,
    (transaction) =>
      prepareForReplay(
        transaction,
        execution,
        execution.requested_by,
        validated.version,
        proof.sourceRevision,
      ),
  );
  const objectProof = await readStoredProof(
    preparation,
    options.skillFileStore,
  );
  const published = await withPgTransaction(
    options.database,
    async (transaction) => {
      const current = await loadSkillImportExecution(transaction, runId, true);
      const finalPreparation = await prepareForReplay(
        transaction,
        current,
        current.requested_by,
        validated.version,
        proof.sourceRevision,
      );
      const version = await finalizeSkillVersionPublication({
        transaction,
        preparation: finalPreparation,
        proof: objectProof,
        allowReservedDraft: true,
        operation: "skills.import",
        requestId: runId,
        traceId: runId,
      });
      await completeSkillImportExecution(transaction, {
        organizationId: current.organization_id,
        runId,
        skillVersionId: version.id,
      });
      return version;
    },
  );
  await options.processHooks?.afterCheckpoint?.("pre_ack", runId);
  return Object.freeze({
    runId,
    state: "completed",
    skillVersionId: published.id,
  });
}

function eventRunId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const payload = (data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

export function createSkillImportWorkflow(options: {
  client: Inngest;
  database: PgDatabase;
  sourceAdapter: SkillSourceAdapter;
  skillFileStore: SkillFileStoreOperations;
  processHooks?: SkillImportProcessHooks;
  execute?: typeof executeSkillImport;
}) {
  const execute = options.execute ?? executeSkillImport;
  return options.client.createFunction(
    {
      id: IMPORT_FUNCTION_ID,
      retries: 3,
      concurrency: [{ key: "event.data.payload.runId", limit: 1 }],
      triggers: [{ event: IMPORT_EVENT }],
      onFailure: async ({ event, error, step }) => {
        const original = event && typeof event === "object"
          ? (event as { data?: { event?: unknown } }).data?.event
          : undefined;
        const runId = eventRunId(original);
        if (!runId) return;
        await step.run(
          `fail-skill-import-${runId}`,
          () =>
            withPgTransaction(
              options.database,
              (transaction) =>
                failSkillImportExecution(
                  transaction,
                  runId,
                  terminalCode(error),
                ),
            ),
        );
      },
    },
    async ({ event, step }) => {
      const runId = eventRunId(event);
      if (!runId) throw new Error("SKILL_IMPORT_EVENT_INVALID");
      return await step.run(
        `execute-skill-import-${runId}`,
        async () => {
          try {
            return await execute(runId, options);
          } catch (error) {
            const code = terminalCode(error);
            if (nonRetriableImportCodes.has(code)) {
              throw new NonRetriableError(code, { cause: error });
            }
            throw error;
          }
        },
      );
    },
  );
}

export function createSkillImportRecovery(options: {
  client: Inngest;
  database: PgDatabase;
  limit?: number;
  staleMs?: number;
  rearm?: typeof rearmStaleSkillImports;
  loadCandidates?: () => Promise<
    Awaited<ReturnType<typeof rearmStaleSkillImports>>
  >;
}) {
  const limit = options.limit ?? 50;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const rearm = options.rearm ?? rearmStaleSkillImports;
  const loadCandidates = options.loadCandidates ??
    (() =>
      withPgTransaction(
        options.database,
        (transaction) => rearm(transaction, limit, staleMs),
      ));
  return options.client.createFunction(
    {
      id: IMPORT_RECOVERY_FUNCTION_ID,
      retries: 3,
      triggers: [
        { cron: "* * * * *" },
        { event: IMPORT_RECOVERY_EVENT },
      ],
    },
    async ({ step }) => {
      const candidates = await step.run(
        "rearm-stale-skill-imports",
        loadCandidates,
      );
      for (const candidate of candidates) {
        await step.sendEvent(
          `rearm-skill-import-${candidate.runId}-${candidate.generation}`,
          {
            name: IMPORT_EVENT,
            data: { payload: { runId: candidate.runId } },
          },
        );
      }
      return { rearmed: candidates.length };
    },
  );
}

export const skillImportFunctionIds = Object.freeze([
  IMPORT_FUNCTION_ID,
  IMPORT_RECOVERY_FUNCTION_ID,
]);
