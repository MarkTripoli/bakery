import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import { appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson } from "../../platform/canonical-json.ts";

export const SkillImportStateSchema = z.enum([
  "queued",
  "resolved",
  "reserved",
  "stored",
  "completed",
  "failed",
]).describe("Durable pinned skill import checkpoint state.");

export const SkillImportSourceProofPersistenceSchema = z.object({
  resolvedRevision: z.string().min(1).max(65_536).describe(
    "Exact upstream revision fixed by the first successful source resolution.",
  ),
  sourceProofDigest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase SHA-256 digest proving fetched source bytes or tree inventory.",
  ),
}).strict().describe(
  "Persisted upstream revision and source proof checkpoint.",
);

const SkillImportFileReservationSchema = z.object({
  path: z.string().min(1).max(500).describe(
    "Normalized relative path reserved for one imported skill file.",
  ),
  mediaType: z.string().min(1).max(255).describe(
    "Validated media type reserved for one imported skill file.",
  ),
  sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024).describe(
    "Validated decoded byte count for one imported skill file.",
  ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase SHA-256 digest for one imported skill file.",
  ),
  isExecutable: z.boolean().describe(
    "Validated executable marker for one imported skill file.",
  ),
  objectKey: z.string().min(1).describe(
    "Shared deterministic immutable object key for one imported skill file.",
  ),
}).strict().describe("Canonical imported file reservation and object proof.");

export const SkillImportReservationPersistenceSchema = z.object({
  skillId: z.string().uuid().describe(
    "Source-path-linked skill UUID selected under the source lock.",
  ),
  ordinal: z.number().int().min(1).describe(
    "Reserved immutable ordinal in the skill version history.",
  ),
  skillVersionId: z.string().uuid().describe(
    "Shared deterministic UUIDv8 skill version identity.",
  ),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Canonical imported manifest SHA-256 digest.",
  ),
  entryPath: z.string().min(1).max(500).describe(
    "Validated relative entry path for the imported version.",
  ),
  fileInventory: z.array(SkillImportFileReservationSchema).max(256).describe(
    "Complete canonical file and object-key reservation inventory.",
  ),
}).strict().describe(
  "Durable source-linked skill, ordinal, UUIDv8, manifest, and object reservation.",
);

export type SkillImportCheckpointRow = {
  id: string;
  organization_id: string;
  run_id: string;
  source_id: string;
  requested_revision: string;
  source_path: string;
  registered_source_type: "git" | "url";
  registered_locator: string;
  registered_license: string;
  state: z.output<typeof SkillImportStateSchema>;
  recovery_generation: string | number;
  recovery_lease_token: string | null;
  recovery_lease_expires_at: Date | string | null;
  resolved_revision: string | null;
  source_proof_digest: string | null;
  skill_id: string | null;
  ordinal: number | null;
  skill_version_id: string | null;
  manifest_digest: string | null;
  entry_path: string | null;
  file_inventory: unknown | null;
  terminal_fault: unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

export const SKILL_IMPORT_CHECKPOINT_COLUMNS = `id, organization_id, run_id,
  source_id, requested_revision, source_path, registered_source_type,
  registered_locator, registered_license, state, recovery_generation,
  recovery_lease_token, recovery_lease_expires_at, resolved_revision,
  source_proof_digest, skill_id, ordinal, skill_version_id, manifest_digest,
  entry_path, file_inventory, terminal_fault, created_at, updated_at, version`;

export async function loadSkillImportCheckpoint(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  lock = false,
): Promise<SkillImportCheckpointRow> {
  const result = await transaction.query<SkillImportCheckpointRow>(
    `select ${SKILL_IMPORT_CHECKPOINT_COLUMNS}
       from bakery.skill_imports
      where organization_id = $1 and run_id = $2
      ${lock ? "for update" : ""}`,
    [organizationId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

export async function recordSkillImportResolvedProof(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    runId: string;
    resolvedRevision: string;
    sourceProofDigest: string;
  }>,
): Promise<SkillImportCheckpointRow> {
  const proof = SkillImportSourceProofPersistenceSchema.parse({
    resolvedRevision: options.resolvedRevision,
    sourceProofDigest: options.sourceProofDigest,
  });
  const current = await loadSkillImportCheckpoint(
    transaction,
    options.organizationId,
    options.runId,
    true,
  );
  if (current.resolved_revision !== null) {
    if (
      current.resolved_revision !== proof.resolvedRevision ||
      current.source_proof_digest !== proof.sourceProofDigest
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "skill_import_source_proof_mismatch" },
      });
    }
    return current;
  }
  const result = await transaction.query<SkillImportCheckpointRow>(
    `update bakery.skill_imports
        set state = 'resolved', resolved_revision = $3,
            source_proof_digest = $4, updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2 and state = 'queued'
      returning ${SKILL_IMPORT_CHECKPOINT_COLUMNS}`,
    [
      options.organizationId,
      options.runId,
      proof.resolvedRevision,
      proof.sourceProofDigest,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  return row;
}

export async function recordSkillImportReservation(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    runId: string;
    skillId: string;
    ordinal: number;
    skillVersionId: string;
    manifestDigest: string;
    entryPath: string;
    fileInventory: readonly z.output<typeof SkillImportFileReservationSchema>[];
  }>,
): Promise<SkillImportCheckpointRow> {
  const reservation = SkillImportReservationPersistenceSchema.parse({
    skillId: options.skillId,
    ordinal: options.ordinal,
    skillVersionId: options.skillVersionId,
    manifestDigest: options.manifestDigest,
    entryPath: options.entryPath,
    fileInventory: options.fileInventory,
  });
  const current = await loadSkillImportCheckpoint(
    transaction,
    options.organizationId,
    options.runId,
    true,
  );
  if (current.skill_version_id !== null) {
    const same = current.skill_id === reservation.skillId &&
      current.ordinal === reservation.ordinal &&
      current.skill_version_id === reservation.skillVersionId &&
      current.manifest_digest === reservation.manifestDigest &&
      current.entry_path === reservation.entryPath &&
      canonicalJson(current.file_inventory) ===
        canonicalJson(reservation.fileInventory);
    if (!same) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "skill_import_reservation_mismatch" },
      });
    }
    return current;
  }
  if (
    current.state !== "resolved" || current.resolved_revision === null ||
    current.source_proof_digest === null
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const result = await transaction.query<SkillImportCheckpointRow>(
    `update bakery.skill_imports
        set state = 'reserved', skill_id = $3, ordinal = $4,
            skill_version_id = $5, manifest_digest = $6, entry_path = $7,
            file_inventory = $8::jsonb, updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2 and state = 'resolved'
      returning ${SKILL_IMPORT_CHECKPOINT_COLUMNS}`,
    [
      options.organizationId,
      options.runId,
      reservation.skillId,
      reservation.ordinal,
      reservation.skillVersionId,
      reservation.manifestDigest,
      reservation.entryPath,
      JSON.stringify(reservation.fileInventory),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  return row;
}

export type SkillImportExecutionRow = SkillImportCheckpointRow & {
  requested_by: string;
  run_status: string;
  run_version: number;
};

export async function loadSkillImportExecution(
  transaction: PgTransactionClient,
  runId: string,
  lock = false,
): Promise<SkillImportExecutionRow> {
  const result = await transaction.query<SkillImportExecutionRow>(
    `select import.*, run.requested_by, run.status as run_status,
            run.version as run_version
       from bakery.skill_imports as import
       join bakery.workflow_runs as run
         on run.organization_id = import.organization_id
        and run.id = import.run_id
        and run.kind = 'skill_import'
      where import.run_id = $1
      ${lock ? "for update of import, run" : ""}`,
    [runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  SkillImportStateSchema.parse(row.state);
  return row;
}

export async function startSkillImportExecution(
  transaction: PgTransactionClient,
  runId: string,
): Promise<SkillImportExecutionRow> {
  const current = await loadSkillImportExecution(transaction, runId, true);
  if (current.state === "completed" || current.state === "failed") {
    return current;
  }
  await transaction.query(
    `update bakery.workflow_runs
        set status = case when status = 'queued' then 'running' else status end,
            started_at = coalesce(started_at, now()), updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2 and kind = 'skill_import'
        and status not in ('completed', 'failed', 'canceled', 'blocked')`,
    [current.organization_id, runId],
  );
  return await loadSkillImportExecution(transaction, runId);
}

const SkillImportObjectProofSchema = z.object({
  objectKey: z.string().min(1).describe(
    "Deterministic immutable object key read back after import storage.",
  ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase SHA-256 digest read back from immutable storage.",
  ),
  sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024).describe(
    "Verified immutable object byte count.",
  ),
}).strict().describe("Read-back proof for one stored imported object.");

export async function recordSkillImportStored(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    runId: string;
    objects: readonly z.output<typeof SkillImportObjectProofSchema>[];
  }>,
): Promise<SkillImportCheckpointRow> {
  const objects = z.array(SkillImportObjectProofSchema).max(256).parse(
    options.objects,
  );
  const current = await loadSkillImportCheckpoint(
    transaction,
    options.organizationId,
    options.runId,
    true,
  );
  if (current.state === "stored" || current.state === "completed") {
    return current;
  }
  if (current.state !== "reserved") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const reservation = SkillImportReservationPersistenceSchema.pick({
    fileInventory: true,
  }).parse({ fileInventory: current.file_inventory });
  const expected = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const file of reservation.fileInventory) {
    expected.set(file.objectKey, {
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    });
  }
  const actual = new Map(
    objects.map((object) => [object.objectKey, {
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
    }]),
  );
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) =>
      canonicalJson(actual.get(key)) !== canonicalJson(value)
    )
  ) {
    throw new StandardError({ code: "SKILL_CONTENT_INTEGRITY_FAILED" });
  }
  const result = await transaction.query<SkillImportCheckpointRow>(
    `update bakery.skill_imports
        set state = 'stored', updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2 and state = 'reserved'
      returning ${SKILL_IMPORT_CHECKPOINT_COLUMNS}`,
    [options.organizationId, options.runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  return row;
}

export async function completeSkillImportExecution(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    runId: string;
    skillVersionId: string;
  }>,
): Promise<SkillImportCheckpointRow> {
  const current = await loadSkillImportCheckpoint(
    transaction,
    options.organizationId,
    options.runId,
    true,
  );
  if (current.skill_version_id !== options.skillVersionId) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  if (current.state === "completed") return current;
  if (current.state !== "stored") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const result = await transaction.query<SkillImportCheckpointRow>(
    `update bakery.skill_imports
        set state = 'completed', recovery_lease_token = null,
            recovery_lease_expires_at = null, updated_at = now(),
            version = version + 1
      where organization_id = $1 and run_id = $2 and state = 'stored'
      returning ${SKILL_IMPORT_CHECKPOINT_COLUMNS}`,
    [options.organizationId, options.runId],
  );
  await transaction.query(
    `update bakery.workflow_runs
        set status = 'completed', finished_at = coalesce(finished_at, now()),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and kind = 'skill_import'
        and status not in ('completed', 'failed')`,
    [options.organizationId, options.runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  return row;
}

const SkillImportTerminalFaultSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).describe(
    "Redacted stable import failure code without source or archive content.",
  ),
}).strict().describe("Redacted terminal pinned import fault.");

export async function failSkillImportExecution(
  transaction: PgTransactionClient,
  runId: string,
  code: string,
): Promise<void> {
  const fault = SkillImportTerminalFaultSchema.parse({ code });
  const current = await loadSkillImportExecution(transaction, runId, true);
  if (current.state === "completed" || current.state === "failed") return;
  await transaction.query(
    `update bakery.skill_imports
        set state = 'failed', terminal_fault = $3::jsonb,
            recovery_lease_token = null, recovery_lease_expires_at = null,
            updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2
        and state not in ('completed', 'failed')`,
    [current.organization_id, runId, JSON.stringify(fault)],
  );
  await transaction.query(
    `update bakery.workflow_runs
        set status = 'failed', finished_at = coalesce(finished_at, now()),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and kind = 'skill_import'
        and status not in ('completed', 'failed')`,
    [current.organization_id, runId],
  );
}

export type SkillImportRecoveryCandidate = Readonly<{
  runId: string;
  generation: number;
}>;

export async function rearmStaleSkillImports(
  transaction: PgTransactionClient,
  limit: number,
  staleMs: number,
): Promise<SkillImportRecoveryCandidate[]> {
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
    !Number.isSafeInteger(staleMs) || staleMs < 1_000
  ) throw new Error("SKILL_IMPORT_RECOVERY_OPTIONS_INVALID");
  const candidates = await transaction.query<SkillImportExecutionRow>(
    `select import.*, run.requested_by, run.status as run_status,
            run.version as run_version
       from bakery.skill_imports as import
       join bakery.workflow_runs as run
         on run.organization_id = import.organization_id
        and run.id = import.run_id and run.kind = 'skill_import'
      where import.state not in ('completed', 'failed')
        and run.status not in ('completed', 'failed', 'canceled', 'blocked')
        and import.updated_at <= now() - ($1::integer * interval '1 millisecond')
      order by import.updated_at, import.id
      for update of import skip locked
      limit $2`,
    [staleMs, limit],
  );
  const rearmed: SkillImportRecoveryCandidate[] = [];
  for (const candidate of candidates.rows) {
    const generation = Number(candidate.recovery_generation) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("SKILL_IMPORT_RECOVERY_GENERATION_INVALID");
    }
    await transaction.query(
      `update bakery.skill_imports
          set recovery_generation = $3, updated_at = now(), version = version + 1
        where organization_id = $1 and run_id = $2`,
      [candidate.organization_id, candidate.run_id, generation],
    );
    const run = await transaction.query<{ version: number }>(
      `update bakery.workflow_runs
          set updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and kind = 'skill_import'
        returning version`,
      [candidate.organization_id, candidate.run_id],
    );
    const aggregateVersion = run.rows[0]?.version;
    if (!aggregateVersion) throw new Error("SKILL_IMPORT_RECOVERY_RUN_MISSING");
    await appendDomainEvent(transaction, {
      organizationId: candidate.organization_id,
      eventType: "skill.import.requested",
      aggregateId: candidate.run_id,
      aggregateVersion,
      payload: { runId: candidate.run_id },
      traceId: candidate.run_id,
      outboxDeliveryKey:
        `skill-import:${candidate.run_id}:generation:${generation}`,
    });
    rearmed.push(Object.freeze({ runId: candidate.run_id, generation }));
  }
  return rearmed;
}
