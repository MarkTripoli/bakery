import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { deriveSkillPublicationIdentity } from "./identity.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import { SkillFileStoreError } from "./storage.ts";
import {
  type LocalSkillVersionInput,
  type ValidatedSkillVersion,
  validateLocalSkillVersion,
} from "./validation.ts";

export type SkillVersionRow = {
  id: string;
  skill_id: string;
  revision: number;
  source_revision: string;
  digest: string;
  entry_path: string;
  manifest: JsonValue;
  status: "draft" | "published" | "retired";
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

export const VERSION_COLUMNS = `id, skill_id, revision, source_revision, digest,
  entry_path, manifest, status, created_by, created_at, updated_at, version`;

/** Domain limits enforced before version metadata reaches PostgreSQL. */
function validPersistencePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") &&
    !value.includes("\\") && !value.endsWith("/") && !value.includes("//") &&
    value.split("/").every((segment) =>
      segment !== "." && segment !== ".." && segment.length > 0
    );
}

export const SkillVersionPersistenceSchema = z.object({
  id: z.string().uuid().describe("Deterministic published version UUID."),
  organizationId: z.string().uuid().describe("Owning organization UUID."),
  skillId: z.string().uuid().describe("Owning skill UUID."),
  revision: z.number().int().min(1).describe("Positive immutable revision."),
  sourceRevision: z.string().min(1).max(65536).describe(
    "Bounded source revision.",
  ),
  digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase SHA-256 digest.",
  ),
  entryPath: z.string().min(1).max(500).refine(validPersistencePath).describe(
    "Safe relative entry path.",
  ),
  manifest: z.record(
    z.string().describe("Manifest property name."),
    z.unknown().describe("Manifest property value."),
  ).refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144,
    "manifest must be at most 262144 UTF-8 bytes",
  ).describe("Canonical manifest object within the persistence size limit."),
  status: z.enum(["draft", "published", "retired"]).describe(
    "Allowed version lifecycle state.",
  ),
  createdBy: z.string().uuid().describe("Principal that created the version."),
}).describe("Validated skill version metadata accepted before persistence.");

export const SkillFilePersistenceSchema = z.object({
  organizationId: z.string().uuid().describe("Owning organization UUID."),
  skillVersionId: z.string().uuid().describe("Owning version UUID."),
  path: z.string().min(1).max(500).refine(validPersistencePath).describe(
    "Safe relative file path.",
  ),
  mediaType: z.string().min(1).max(255).describe("Bounded media type."),
  objectKey: z.string().min(1).describe("Derived immutable storage key."),
  sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024).describe(
    "Decoded file byte count.",
  ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase file SHA-256.",
  ),
  isExecutable: z.boolean().describe("Executable policy marker."),
}).describe(
  "Validated skill file metadata and derived object key accepted before persistence.",
);

export function validateSkillVersionPersistence(input: unknown) {
  const result = SkillVersionPersistenceSchema.safeParse(input);
  if (!result.success) throw new StandardError({ code: "UNPROCESSABLE" });
  return result.data;
}

export function validateSkillFilePersistence(input: unknown) {
  const result = SkillFilePersistenceSchema.safeParse(input);
  if (!result.success) throw new StandardError({ code: "UNPROCESSABLE" });
  const expectedKey =
    `organizations/${result.data.organizationId}/skill-versions/${result.data.skillVersionId}/sha256/${result.data.sha256}`;
  if (result.data.objectKey !== expectedKey) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return result.data;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toSkillVersion(row: SkillVersionRow) {
  return {
    id: row.id,
    skillId: row.skill_id,
    revision: row.revision,
    sourceRevision: row.source_revision,
    digest: row.digest,
    entryPath: row.entry_path,
    manifest: row.manifest,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

function publicationError(error: unknown): never {
  if (error instanceof StandardError) throw error;
  if (error instanceof SkillFileStoreError) {
    if (error.code === "SKILL_CONTENT_INTEGRITY_FAILED") {
      throw new StandardError({
        code: "SKILL_CONTENT_INTEGRITY_FAILED",
        cause: error,
      });
    }
    if (error.code.startsWith("SKILL_FILE_")) {
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE", cause: error });
    }
  }
  throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE", cause: error });
}

type SkillPublicationIdentity = Readonly<{
  versionId: string;
  objectKeys: readonly string[];
}>;

type SkillSnapshot = Readonly<{
  sourceId: string;
  sourceType: "git" | "url" | "local_bundle";
  sourceLocator: string;
  sourceLicense: string | null;
  sourceEnabled: boolean;
}>;

export type SkillVersionPublicationPreparation = Readonly<{
  organizationId: string;
  principalId: string;
  sourceRevision: string;
  validated: ValidatedSkillVersion;
  identity: SkillPublicationIdentity;
  skill: SkillSnapshot;
}>;

export type LocalSkillVersionPublicationPreparation =
  SkillVersionPublicationPreparation;

export type SkillVersionPublicationProof = Readonly<{
  objects: readonly Readonly<{
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }>[];
}>;

export type LocalSkillVersionPublicationProof = SkillVersionPublicationProof;

async function querySkill(
  transaction: PgTransactionClient,
  organizationId: string,
  skillId: string,
  sourceType: SkillSnapshot["sourceType"],
  lockRows = false,
): Promise<SkillSnapshot> {
  const result = await transaction.query<SkillSnapshot>(
    `select skill.source_id as "sourceId",
            source.source_type as "sourceType",
            source.locator as "sourceLocator",
            source.license as "sourceLicense",
            source.enabled as "sourceEnabled"
       from bakery.skills as skill
       join bakery.skill_sources as source
         on source.organization_id = skill.organization_id
        and source.id = skill.source_id
      where skill.organization_id = $1 and skill.id = $2
        and source.source_type = $3
      ${lockRows ? "for update of skill, source" : ""}`,
    [organizationId, skillId, sourceType],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return Object.freeze(row);
}

function requireLicense(validated: ValidatedSkillVersion): string {
  const license = validated.manifest.license;
  if (typeof license !== "string") {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return license;
}

function assertRevisionAvailable(
  existing: SkillVersionRow | undefined,
  preparation: Pick<
    SkillVersionPublicationPreparation,
    "sourceRevision" | "validated" | "identity"
  >,
): ReturnType<typeof toSkillVersion> | undefined {
  if (!existing) return undefined;
  if (
    existing.source_revision !== preparation.sourceRevision ||
    existing.digest !== preparation.validated.digest ||
    existing.entry_path !== preparation.validated.entryPath ||
    canonicalJson(existing.manifest) !==
      preparation.validated.canonicalManifest ||
    existing.id !== preparation.identity.versionId
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return toSkillVersion(existing);
}

async function assertNextRevision(
  transaction: PgTransactionClient,
  organizationId: string,
  skillId: string,
  revision: number,
): Promise<void> {
  const latest = await transaction.query<{ revision: number }>(
    `select revision from bakery.skill_versions
      where organization_id = $1 and skill_id = $2
      order by revision desc limit 1`,
    [organizationId, skillId],
  );
  if (latest.rows[0] && revision !== latest.rows[0].revision + 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
}

/** Validates shared local or remote identity before object I/O. */
export async function prepareSkillVersionPublication(options: {
  transaction: PgTransactionClient;
  organizationId: string;
  principalId: string;
  validated: ValidatedSkillVersion;
  sourceRevision: string;
  sourceType: SkillSnapshot["sourceType"];
  requireEnabled?: boolean;
}): Promise<SkillVersionPublicationPreparation> {
  const {
    transaction,
    organizationId,
    principalId,
    validated,
    sourceRevision,
    sourceType,
  } = options;
  const identity = await deriveSkillPublicationIdentity({
    organizationId,
    skillId: validated.skillId,
    revision: validated.revision,
    digest: validated.digest,
    fileDigests: validated.files.map((file) => file.sha256),
  });
  validateSkillVersionPersistence({
    id: identity.versionId,
    organizationId,
    skillId: validated.skillId,
    revision: validated.revision,
    sourceRevision,
    digest: validated.digest,
    entryPath: validated.entryPath,
    manifest: JSON.parse(validated.canonicalManifest) as Record<
      string,
      unknown
    >,
    status: sourceType === "local_bundle" ? "published" : "draft",
    createdBy: principalId,
  });
  for (const [index, file] of validated.files.entries()) {
    validateSkillFilePersistence({
      organizationId,
      skillVersionId: identity.versionId,
      path: file.path,
      mediaType: file.mediaType,
      objectKey: identity.objectKeys[index],
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      isExecutable: file.isExecutable,
    });
  }
  const skill = await querySkill(
    transaction,
    organizationId,
    validated.skillId,
    sourceType,
  );
  const existing = await transaction.query<SkillVersionRow>(
    `select ${VERSION_COLUMNS} from bakery.skill_versions
      where organization_id = $1 and skill_id = $2 and revision = $3`,
    [organizationId, validated.skillId, validated.revision],
  );
  const preparation = Object.freeze({
    organizationId,
    principalId,
    sourceRevision,
    validated,
    identity: Object.freeze(identity),
    skill,
  });
  if (!existing.rows[0]) {
    await assertNextRevision(
      transaction,
      organizationId,
      validated.skillId,
      validated.revision,
    );
  } else {
    assertRevisionAvailable(existing.rows[0], preparation);
  }
  const license = requireLicense(validated);
  if (
    skill.sourceLicense !== null && skill.sourceLicense !== license ||
    sourceType !== "local_bundle" && skill.sourceLicense !== license ||
    options.requireEnabled === true && !skill.sourceEnabled
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return preparation;
}

/** Preserves local upload validation and manifest-digest source revision. */
export async function prepareLocalSkillVersionPublication(options: {
  transaction: PgTransactionClient;
  input: LocalSkillVersionInput;
  organizationId: string;
  principalId: string;
}): Promise<LocalSkillVersionPublicationPreparation> {
  let validated: ValidatedSkillVersion;
  try {
    validated = await validateLocalSkillVersion(options.input);
  } catch (error) {
    throw new StandardError({ code: "UNPROCESSABLE", cause: error });
  }
  return await prepareSkillVersionPublication({
    transaction: options.transaction,
    organizationId: options.organizationId,
    principalId: options.principalId,
    validated,
    sourceRevision: validated.digest,
    sourceType: "local_bundle",
  });
}

/** Stores each distinct content-addressed object after preflight has rolled back. */
export async function storeSkillVersionPublication(
  preparation: SkillVersionPublicationPreparation,
  store: SkillFileStoreOperations,
): Promise<SkillVersionPublicationProof> {
  const objects = new Map<string, {
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    content: Uint8Array;
  }>();
  for (const [index, file] of preparation.validated.files.entries()) {
    const objectKey = preparation.identity.objectKeys[index];
    if (!objects.has(objectKey)) {
      objects.set(objectKey, {
        objectKey,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        content: file.content,
      });
    }
  }
  try {
    for (const object of objects.values()) {
      await store.recover(
        object.objectKey,
        object.sha256,
        object.sizeBytes,
      ).catch((error) => {
        if (
          error instanceof SkillFileStoreError &&
          error.code === "SKILL_FILE_NOT_FOUND"
        ) return;
        throw error;
      });
      await store.putIfAbsent(
        object.objectKey,
        object.content,
        object.sha256,
      );
      await store.read(
        object.objectKey,
        object.sha256,
        object.sizeBytes,
      );
    }
  } catch (error) {
    publicationError(error);
  }
  return Object.freeze({
    objects: Object.freeze(
      Array.from(
        objects.values(),
        ({ objectKey, sha256, sizeBytes }) =>
          Object.freeze({ objectKey, sha256, sizeBytes }),
      ),
    ),
  });
}

export async function storeLocalSkillVersionPublication(
  preparation: LocalSkillVersionPublicationPreparation,
  store: SkillFileStoreOperations,
): Promise<LocalSkillVersionPublicationProof> {
  return await storeSkillVersionPublication(preparation, store);
}

function assertPublicationProof(
  preparation: SkillVersionPublicationPreparation,
  proof: SkillVersionPublicationProof,
): void {
  const expected = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const [index, file] of preparation.validated.files.entries()) {
    expected.set(preparation.identity.objectKeys[index], {
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    });
  }
  if (proof.objects.length !== expected.size) {
    throw new StandardError({ code: "SKILL_CONTENT_INTEGRITY_FAILED" });
  }
  for (const object of proof.objects) {
    const expectedObject = expected.get(object.objectKey);
    if (
      !expectedObject || expectedObject.sha256 !== object.sha256 ||
      expectedObject.sizeBytes !== object.sizeBytes
    ) {
      throw new StandardError({ code: "SKILL_CONTENT_INTEGRITY_FAILED" });
    }
  }
}

/** Reserves remote draft metadata before immutable object I/O. */
export async function reserveSkillVersionPublication(
  transaction: PgTransactionClient,
  preparation: SkillVersionPublicationPreparation,
): Promise<ReturnType<typeof toSkillVersion>> {
  const { organizationId, principalId, sourceRevision, validated, identity } =
    preparation;
  if (preparation.skill.sourceType === "local_bundle") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const skill = await querySkill(
    transaction,
    organizationId,
    validated.skillId,
    preparation.skill.sourceType,
    true,
  );
  if (
    skill.sourceId !== preparation.skill.sourceId ||
    skill.sourceLocator !== preparation.skill.sourceLocator ||
    skill.sourceLicense !== preparation.skill.sourceLicense ||
    !skill.sourceEnabled
  ) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const existing = await transaction.query<SkillVersionRow>(
    `select ${VERSION_COLUMNS} from bakery.skill_versions
      where organization_id = $1 and skill_id = $2 and revision = $3`,
    [organizationId, validated.skillId, validated.revision],
  );
  const replay = assertRevisionAvailable(existing.rows[0], preparation);
  if (replay) {
    if (replay.status !== "draft" && replay.status !== "published") {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    await assertReservedFiles(transaction, preparation);
    return replay;
  }
  await assertNextRevision(
    transaction,
    organizationId,
    validated.skillId,
    validated.revision,
  );
  const inserted = await transaction.query<SkillVersionRow>(
    `insert into bakery.skill_versions (
       id, organization_id, skill_id, revision, source_revision, digest,
       entry_path, manifest, status, created_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'draft', $9)
     returning ${VERSION_COLUMNS}`,
    [
      identity.versionId,
      organizationId,
      validated.skillId,
      validated.revision,
      sourceRevision,
      validated.digest,
      validated.entryPath,
      validated.canonicalManifest,
      principalId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("SKILL_VERSION_RESERVATION_INSERT_FAILED");
  await insertSkillFiles(transaction, preparation, row.id);
  return toSkillVersion(row);
}

type ReservedSkillFileRow = {
  path: string;
  media_type: string;
  object_key: string;
  size_bytes: number;
  sha256: string;
  is_executable: boolean;
};

async function insertSkillFiles(
  transaction: PgTransactionClient,
  preparation: SkillVersionPublicationPreparation,
  skillVersionId: string,
): Promise<void> {
  for (let index = 0; index < preparation.validated.files.length; index++) {
    const file = preparation.validated.files[index];
    await transaction.query(
      `insert into bakery.skill_files (
         organization_id, skill_version_id, path, media_type, object_key,
         size_bytes, sha256, is_executable
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        preparation.organizationId,
        skillVersionId,
        file.path,
        file.mediaType,
        preparation.identity.objectKeys[index],
        file.sizeBytes,
        file.sha256,
        file.isExecutable,
      ],
    );
  }
}

async function assertReservedFiles(
  transaction: PgTransactionClient,
  preparation: SkillVersionPublicationPreparation,
): Promise<void> {
  const result = await transaction.query<ReservedSkillFileRow>(
    `select path, media_type, object_key, size_bytes, sha256, is_executable
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2
      order by path`,
    [preparation.organizationId, preparation.identity.versionId],
  );
  const expected = preparation.validated.files.map((file, index) => ({
    path: file.path,
    media_type: file.mediaType,
    object_key: preparation.identity.objectKeys[index],
    size_bytes: file.sizeBytes,
    sha256: file.sha256,
    is_executable: file.isExecutable,
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(result.rows) !== canonicalJson(expected)) {
    throw new StandardError({ code: "SKILL_CONTENT_INTEGRITY_FAILED" });
  }
}

/** Finalizes shared local or reserved remote publication under live authority. */
export async function finalizeSkillVersionPublication(options: {
  transaction: PgTransactionClient;
  preparation: SkillVersionPublicationPreparation;
  proof: SkillVersionPublicationProof;
  allowReservedDraft: boolean;
  operation: string;
  requestId: string;
  traceId: string;
}): Promise<ReturnType<typeof toSkillVersion>> {
  const { transaction, preparation, proof } = options;
  const {
    organizationId,
    principalId,
    sourceRevision,
    validated,
    identity,
  } = preparation;
  assertPublicationProof(preparation, proof);
  const skill = await querySkill(
    transaction,
    organizationId,
    validated.skillId,
    preparation.skill.sourceType,
    true,
  );
  const remote = preparation.skill.sourceType !== "local_bundle";
  if (
    skill.sourceId !== preparation.skill.sourceId ||
    skill.sourceLocator !== preparation.skill.sourceLocator ||
    remote && (
        !skill.sourceEnabled ||
        skill.sourceLicense !== preparation.skill.sourceLicense
      )
  ) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const license = requireLicense(validated);
  if (skill.sourceLicense !== null && skill.sourceLicense !== license) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const final = await transaction.query<SkillVersionRow>(
    `select ${VERSION_COLUMNS} from bakery.skill_versions
      where organization_id = $1 and skill_id = $2 and revision = $3`,
    [organizationId, validated.skillId, validated.revision],
  );
  const replay = assertRevisionAvailable(final.rows[0], preparation);
  if (replay?.status === "published") return replay;

  let row: SkillVersionRow;
  if (replay?.status === "draft") {
    if (!options.allowReservedDraft) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    await assertReservedFiles(transaction, preparation);
    const published = await transaction.query<SkillVersionRow>(
      `update bakery.skill_versions
          set status = 'published', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'draft'
        returning ${VERSION_COLUMNS}`,
      [organizationId, identity.versionId],
    );
    const updated = published.rows[0];
    if (!updated) throw new StandardError({ code: "STATE_CONFLICT" });
    row = updated;
  } else {
    if (options.allowReservedDraft) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "skill_import_reservation_missing" },
      });
    }
    await assertNextRevision(
      transaction,
      organizationId,
      validated.skillId,
      validated.revision,
    );
    const source = await transaction.query<{ id: string }>(
      `update bakery.skill_sources
          set license = $3, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
          and (license is null or license = $3)
        returning id`,
      [organizationId, skill.sourceId, license],
    );
    if (source.rows.length !== 1) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const inserted = await transaction.query<SkillVersionRow>(
      `insert into bakery.skill_versions (
         id, organization_id, skill_id, revision, source_revision, digest,
         entry_path, manifest, status, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'published', $9)
       returning ${VERSION_COLUMNS}`,
      [
        identity.versionId,
        organizationId,
        validated.skillId,
        validated.revision,
        sourceRevision,
        validated.digest,
        validated.entryPath,
        validated.canonicalManifest,
        principalId,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (!insertedRow) throw new Error("SKILL_VERSION_INSERT_FAILED");
    await insertSkillFiles(transaction, preparation, insertedRow.id);
    row = insertedRow;
  }
  const active = await transaction.query<{ id: string }>(
    `update bakery.skills
        set active_version_id = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning id`,
    [organizationId, validated.skillId, row.id],
  );
  if (active.rows.length !== 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: options.operation,
    resourceType: "skill_version",
    resourceId: row.id,
    requestId: options.requestId,
    traceId: options.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "skill.version_created",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: options.traceId,
    outboxDeliveryKey: `skill-version:${row.id}`,
  });
  return toSkillVersion(row);
}

/** Preserves the local route's existing one-call publication behavior. */
export async function finalizeLocalSkillVersionPublication(options: {
  transaction: PgTransactionClient;
  context: ActionContext;
  preparation: LocalSkillVersionPublicationPreparation;
  proof: LocalSkillVersionPublicationProof;
}): Promise<ReturnType<typeof toSkillVersion>> {
  return await finalizeSkillVersionPublication({
    transaction: options.transaction,
    preparation: options.preparation,
    proof: options.proof,
    allowReservedDraft: false,
    operation: "skillVersions.create",
    requestId: options.context.requestId,
    traceId: options.context.traceId,
  });
}
