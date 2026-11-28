import { Buffer } from "node:buffer";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { type contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  finalizeLocalSkillVersionPublication,
  type LocalSkillVersionPublicationPreparation,
  type LocalSkillVersionPublicationProof,
  prepareLocalSkillVersionPublication,
} from "./publication.ts";
import {
  assertMayAuthorSkill,
  SKILL_VISIBLE_TO,
  type SkillScope,
} from "./skill-scope-guard.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import {
  decodeSkillFileBase64,
  isSkillExecutableMedia,
  isSkillMediaType,
  type LocalSkillVersionInput,
  normalizeSkillFilePath,
  skillFileIdentity,
  skillFileSha256,
  SkillUploadInvalid,
  skillUploadIssues,
  validateLocalSkillVersion,
} from "./validation.ts";

type Draft = z.output<typeof contractSchemas.SkillDraft>;
type DraftFile = z.output<typeof contractSchemas.SkillDraftFile>;
type DraftCheck = z.output<typeof contractSchemas.SkillDraftCheck>;
type FileSave = z.output<typeof contractSchemas.SkillDraftFileSave>;
type DraftUpdate = z.output<typeof contractSchemas.SkillDraftUpdate>;

/** The most files and bytes a draft holds, as an upload does. */
export const SKILL_DRAFT_MAX_FILES = 256;
export const SKILL_DRAFT_MAX_BYTES = 10 * 1024 * 1024;
/** The most problems one check reports. */
export const SKILL_DRAFT_MAX_PROBLEMS = 50;

type DraftRow = {
  id: string;
  skill_id: string;
  base_version_id: string | null;
  base_revision: number | null;
  entry_path: string;
  license: string | null;
  manifest_extra: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
};

type FileRow = {
  id: string;
  path: string;
  media_type: string;
  is_executable: boolean;
  size_bytes: number;
  sha256: string;
};

const DRAFT_COLUMNS = `draft.id, draft.skill_id, draft.base_version_id,
  base.revision as base_revision, draft.entry_path, draft.license,
  draft.manifest_extra, draft.version,
  to_char(draft.created_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  to_char(draft.updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

const DRAFT_FROM = `bakery.skill_drafts as draft
  left join bakery.skill_versions as base
    on base.organization_id = draft.organization_id
   and base.id = draft.base_version_id`;

export type Facts = Readonly<{
  transaction: PgTransactionClient;
  organizationId: string;
  principalId: string;
  skillId: string;
  scope: SkillScope;
  activeVersionId: string | null;
}>;

/**
 * Finds the skill the caller may author. Someone else's personal skill is not
 * found; a skill that comes with Bakery has no draft, only a copy has.
 */
export async function authorableSkill(
  context: ActionContext,
): Promise<Facts> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const skillId = context.params.id;
  if (!skillId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const found = await transaction.query<{
    scope: SkillScope;
    owner_principal_id: string | null;
    active_version_id: string | null;
  }>(
    `select scope, owner_principal_id, active_version_id from bakery.skills
      where organization_id = $1 and id = $2 and ${SKILL_VISIBLE_TO("$3")}`,
    [organizationId, skillId, principalId],
  );
  const skill = found.rows[0];
  if (!skill) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await assertMayAuthorSkill(transaction, organizationId, principalId, {
    scope: skill.scope,
    ownerPrincipalId: skill.owner_principal_id,
  });
  return {
    transaction,
    organizationId,
    principalId,
    skillId,
    scope: skill.scope,
    activeVersionId: skill.active_version_id,
  };
}

async function readDraftRow(
  facts: Facts,
  lock = false,
): Promise<DraftRow | undefined> {
  const result = await facts.transaction.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from ${DRAFT_FROM}
      where draft.organization_id = $1 and draft.skill_id = $2${
      lock ? " for update of draft" : ""
    }`,
    [facts.organizationId, facts.skillId],
  );
  return result.rows[0];
}

async function listFiles(facts: Facts, draftId: string): Promise<FileRow[]> {
  const result = await facts.transaction.query<FileRow>(
    `select id, path, media_type, is_executable, size_bytes, sha256
       from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 order by path`,
    [facts.organizationId, draftId],
  );
  return result.rows;
}

async function project(facts: Facts, row: DraftRow): Promise<Draft> {
  const files = await listFiles(facts, row.id);
  return {
    id: row.id,
    skillId: row.skill_id,
    baseVersionId: row.base_version_id,
    baseRevision: row.base_revision,
    entryPath: row.entry_path,
    license: row.license,
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      mediaType: file.media_type,
      isExecutable: file.is_executable,
      sizeBytes: file.size_bytes,
      sha256: file.sha256,
    })),
    totalBytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireDraft(
  facts: Facts,
  lock = false,
): Promise<DraftRow> {
  const row = await readDraftRow(facts, lock);
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

function requireExpectedVersion(
  context: ActionContext,
  row: Pick<DraftRow, "version">,
): number {
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (expected !== row.version) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  return expected;
}

async function touch(
  facts: Facts,
  draftId: string,
  expected: number,
  extra: { entryPath?: string; license?: string | null } = {},
): Promise<void> {
  const updated = await facts.transaction.query(
    `update bakery.skill_drafts
        set entry_path = coalesce($4, entry_path),
            license = case when $5::boolean then $6 else license end,
            updated_by = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and version = $7
      returning id`,
    [
      facts.organizationId,
      draftId,
      facts.principalId,
      extra.entryPath ?? null,
      extra.license !== undefined,
      extra.license ?? null,
      expected,
    ],
  );
  if (updated.rows.length !== 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
}

function uploadProblem(error: SkillUploadInvalid): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    cause: error,
    params: { issues: skillUploadIssues(error) },
  });
}

/** skillDrafts.get */
export async function getSkillDraft(context: ActionContext): Promise<Draft> {
  const facts = await authorableSkill(context);
  return await project(facts, await requireDraft(facts));
}

/**
 * skillDrafts.open: the skill's draft, started from its active version when it
 * has none yet. The same draft comes back every time, so opening is safe to
 * repeat. The active version's files are read back from the store, which is
 * why opening a draft of a published skill needs it.
 */
export async function openSkillDraft(
  context: ActionContext,
  store: SkillFileStoreOperations | undefined,
): Promise<Draft> {
  const facts = await authorableSkill(context);
  const existing = await readDraftRow(facts);
  if (existing) return await project(facts, existing);
  if (attributeAction(context, facts.principalId).actorKind !== "person") {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "skill_draft_requires_person" },
    });
  }
  type Base = {
    id: string;
    entry_path: string;
    manifest: Record<string, unknown>;
  };
  let base: Base | undefined;
  let baseFiles: (FileRow & { object_key: string })[] = [];
  if (facts.activeVersionId !== null) {
    base = (await facts.transaction.query<Base>(
      `select id, entry_path, manifest from bakery.skill_versions
        where organization_id = $1 and id = $2 and skill_id = $3`,
      [facts.organizationId, facts.activeVersionId, facts.skillId],
    )).rows[0];
    if (base) {
      baseFiles = (await facts.transaction.query<
        FileRow & { object_key: string }
      >(
        `select id, path, media_type, is_executable, size_bytes, sha256,
                object_key
           from bakery.skill_files
          where organization_id = $1 and skill_version_id = $2 order by path`,
        [facts.organizationId, base.id],
      )).rows;
    }
  }
  // Reading the active version's files needs the file store; with none to copy,
  // it is not needed.
  let fileStore: SkillFileStoreOperations | undefined;
  if (baseFiles.length > 0) {
    if (store === undefined) {
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    fileStore = store;
  }
  const { files: _files, entryPath: _entry, license, ...extra } = base
    ?.manifest ?? {};
  const draftId = crypto.randomUUID();
  // Two requests may open it at once. A unique violation would abort this
  // transaction, so the insert says what to do instead: when the other
  // request's draft is there (or appears as it commits), nothing is inserted
  // and that draft is the draft.
  const inserted = await facts.transaction.query<{ id: string }>(
    `insert into bakery.skill_drafts (
       id, organization_id, skill_id, base_version_id, entry_path, license,
       manifest_extra, created_by, updated_by
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
     on conflict (organization_id, skill_id) do nothing
     returning id`,
    [
      draftId,
      facts.organizationId,
      facts.skillId,
      base?.id ?? null,
      base?.entry_path ?? "SKILL.md",
      typeof license === "string" ? license : null,
      JSON.stringify(extra),
      facts.principalId,
    ],
  );
  if (inserted.rows.length === 0) {
    return await project(facts, await requireDraft(facts));
  }
  if (fileStore !== undefined) {
    for (const file of baseFiles) {
      const content = await fileStore.read(
        file.object_key,
        file.sha256,
        file.size_bytes,
      );
      await facts.transaction.query(
        `insert into bakery.skill_draft_files (
           id, organization_id, draft_id, path, media_type, is_executable,
           content, size_bytes, sha256
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          facts.organizationId,
          draftId,
          file.path,
          file.media_type,
          file.is_executable,
          Buffer.from(content),
          file.size_bytes,
          file.sha256,
        ],
      );
    }
  }
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDrafts.open",
    resourceType: "skill_draft",
    resourceId: draftId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId, baseVersionId: base?.id ?? null },
  });
  return await project(facts, await requireDraft(facts));
}

/** skillDrafts.update */
export async function updateSkillDraft(
  context: ActionContext,
  input: DraftUpdate,
): Promise<Draft> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  const expected = requireExpectedVersion(context, row);
  let entryPath: string | undefined;
  if (input.entryPath !== undefined) {
    try {
      entryPath = normalizeSkillFilePath(input.entryPath);
    } catch (error) {
      if (error instanceof SkillUploadInvalid) uploadProblem(error);
      throw error;
    }
  }
  if (
    input.license !== undefined &&
    !/^[\x20-\x7e]{1,200}$/.test(input.license)
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["license"],
          code: "invalid",
          message: "The license is 1 to 200 printable characters.",
        }],
      },
    });
  }
  await touch(facts, row.id, expected, {
    entryPath,
    license: input.license,
  });
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDrafts.update",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId },
  });
  return await project(facts, await requireDraft(facts));
}

/** skillDrafts.discard */
export async function discardSkillDraft(context: ActionContext): Promise<null> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  requireExpectedVersion(context, row);
  await facts.transaction.query(
    `delete from bakery.skill_drafts where organization_id = $1 and id = $2`,
    [facts.organizationId, row.id],
  );
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDrafts.discard",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId },
  });
  return null;
}

/** skillDraftFiles.save: adds a file or replaces the one at the same path. */
export async function saveSkillDraftFile(
  context: ActionContext,
  input: FileSave,
): Promise<Draft> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  const expected = requireExpectedVersion(context, row);
  let path: string;
  let content: Uint8Array;
  try {
    path = normalizeSkillFilePath(input.path);
    content = decodeSkillFileBase64(input.contentBase64);
  } catch (error) {
    if (error instanceof SkillUploadInvalid) uploadProblem(error);
    throw error;
  }
  if (!isSkillMediaType(input.mediaType)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["mediaType"],
          code: "invalid",
          message: "That is not a file type Bakery can store.",
        }],
      },
    });
  }
  const executable = input.isExecutable ?? false;
  if (executable && !isSkillExecutableMedia(input.mediaType)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["isExecutable"],
          code: "executable_media",
          message: "Only a script can be marked as runnable.",
        }],
      },
    });
  }
  const others = (await listFiles(facts, row.id)).filter((file) =>
    file.path !== path
  );
  if (
    others.some((file) =>
      skillFileIdentity(file.path) === skillFileIdentity(path)
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "path_collision" },
    });
  }
  const bytes = others.reduce((sum, file) => sum + file.size_bytes, 0) +
    content.byteLength;
  if (
    others.length + 1 > SKILL_DRAFT_MAX_FILES || bytes > SKILL_DRAFT_MAX_BYTES
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "draft_too_large" },
    });
  }
  const sha256 = await skillFileSha256(content);
  await facts.transaction.query(
    `insert into bakery.skill_draft_files (
       id, organization_id, draft_id, path, media_type, is_executable, content,
       size_bytes, sha256
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (draft_id, path) do update
       set media_type = excluded.media_type,
           is_executable = excluded.is_executable,
           content = excluded.content, size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256, updated_at = now()`,
    [
      crypto.randomUUID(),
      facts.organizationId,
      row.id,
      path,
      input.mediaType,
      executable,
      Buffer.from(content),
      content.byteLength,
      sha256,
    ],
  );
  await touch(facts, row.id, expected);
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDraftFiles.save",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId, path, sizeBytes: content.byteLength },
  });
  return await project(facts, await requireDraft(facts));
}

/**
 * skillDraftFiles.rename: moves one file to a new path in one step. The file
 * keeps its bytes, type and runnable mark, so the check reports the same line
 * problems at the new path; a draft whose entry file moves follows it.
 */
export async function renameSkillDraftFile(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SkillDraftFileRename>,
): Promise<Draft> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  const expected = requireExpectedVersion(context, row);
  let from: string;
  let to: string;
  try {
    from = normalizeSkillFilePath(input.path);
    to = normalizeSkillFilePath(input.newPath);
  } catch (error) {
    if (error instanceof SkillUploadInvalid) uploadProblem(error);
    throw error;
  }
  const files = await listFiles(facts, row.id);
  if (!files.some((file) => file.path === from)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (from === to) return await project(facts, row);
  if (
    files.some((file) =>
      file.path !== from &&
      skillFileIdentity(file.path) === skillFileIdentity(to)
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "path_collision" },
    });
  }
  // A file row's path is not updatable by the application role, so the file
  // moves as a copy under the new path and the old row is removed.
  await facts.transaction.query(
    `insert into bakery.skill_draft_files (
       id, organization_id, draft_id, path, media_type, is_executable, content,
       size_bytes, sha256
     )
     select $5, organization_id, draft_id, $4, media_type, is_executable,
            content, size_bytes, sha256
       from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 and path = $3`,
    [facts.organizationId, row.id, from, to, crypto.randomUUID()],
  );
  await facts.transaction.query(
    `delete from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 and path = $3`,
    [facts.organizationId, row.id, from],
  );
  if (row.entry_path === from) {
    await facts.transaction.query(
      `update bakery.skill_drafts set entry_path = $3
        where organization_id = $1 and id = $2`,
      [facts.organizationId, row.id, to],
    );
  }
  await touch(facts, row.id, expected);
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDraftFiles.rename",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId, path: from, newPath: to },
  });
  return await project(facts, await requireDraft(facts));
}

/** skillDraftFiles.get */
export async function getSkillDraftFile(
  context: ActionContext,
): Promise<DraftFile> {
  const facts = await authorableSkill(context);
  const fileId = context.params.fileId;
  const row = await requireDraft(facts);
  const file = (await facts.transaction.query<
    FileRow & { content: Uint8Array }
  >(
    `select id, path, media_type, is_executable, size_bytes, sha256, content
       from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 and id = $3`,
    [facts.organizationId, row.id, fileId],
  )).rows[0];
  if (!file) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    id: file.id,
    path: file.path,
    mediaType: file.media_type,
    isExecutable: file.is_executable,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    contentBase64: Buffer.from(file.content).toString("base64"),
  };
}

/** skillDraftFiles.delete */
export async function deleteSkillDraftFile(
  context: ActionContext,
): Promise<Draft> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  const expected = requireExpectedVersion(context, row);
  const deleted = await facts.transaction.query<{ path: string }>(
    `delete from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 and id = $3
      returning path`,
    [facts.organizationId, row.id, context.params.fileId],
  );
  if (deleted.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  await touch(facts, row.id, expected);
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDraftFiles.delete",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId, path: deleted.rows[0].path },
  });
  return await project(facts, await requireDraft(facts));
}

/** A relative link in markdown: `[text](target)`, with its line. */
export function relativeLinks(
  markdown: string,
): { target: string; line: number }[] {
  const found: { target: string; line: number }[] = [];
  markdown.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const raw = match[1];
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") ||
        raw.startsWith("/")
      ) {
        continue;
      }
      const path = raw.split("#")[0].split("?")[0];
      // A stray % (`50%off.md`) is not an escape; the link is read as written.
      let target = path;
      try {
        target = decodeURI(path);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
      }
      if (target !== "") found.push({ target, line: index + 1 });
    }
  });
  return found;
}

type DraftFileWithContent = FileRow & { content: Uint8Array };
type DraftProblem = {
  file: string | null;
  line: number | null;
  code: string;
  message: string;
  missingPath: string | null;
};

async function readDraftFiles(
  facts: Facts,
  draftId: string,
): Promise<DraftFileWithContent[]> {
  return (await facts.transaction.query<DraftFileWithContent>(
    `select id, path, media_type, is_executable, size_bytes, sha256, content
       from bakery.skill_draft_files
      where organization_id = $1 and draft_id = $2 order by path`,
    [facts.organizationId, draftId],
  )).rows;
}

/** The draft as the upload a publish would validate, at the revision it would take. */
function draftUpload(
  facts: Facts,
  row: DraftRow,
  rows: readonly DraftFileWithContent[],
  revision: number,
): LocalSkillVersionInput {
  return {
    id: facts.skillId,
    revision,
    digest: "",
    entryPath: row.entry_path,
    manifest: {
      ...row.manifest_extra,
      schemaVersion: 1,
      ...(row.license === null ? {} : { license: row.license }),
      entryPath: row.entry_path,
      files: rows.map((file) => ({
        path: file.path,
        mediaType: file.media_type,
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        isExecutable: file.is_executable,
      })),
    },
    files: rows.map((file) => ({
      path: file.path,
      mediaType: file.media_type,
      isExecutable: file.is_executable,
      contentBase64: Buffer.from(file.content).toString("base64"),
    })),
  };
}

/** What a publish would say about the draft, as sentences tied to a file and line. */
async function draftProblems(
  row: DraftRow,
  rows: readonly DraftFileWithContent[],
  upload: ReturnType<typeof draftUpload>,
): Promise<DraftProblem[]> {
  const problems: DraftProblem[] = [];
  const add = (
    file: string | null,
    line: number | null,
    code: string,
    message: string,
    missingPath: string | null = null,
  ) => {
    if (problems.length < SKILL_DRAFT_MAX_PROBLEMS) {
      problems.push({ file, line, code, message, missingPath });
    }
  };
  try {
    await validateLocalSkillVersion(upload, { computeDigest: true });
  } catch (error) {
    if (!(error instanceof SkillUploadInvalid)) throw error;
    for (const issue of skillUploadIssues(error)) {
      const index = issue.path[0] === "files" ? Number(issue.path[1]) : null;
      add(
        index === null ? null : rows[index]?.path ?? null,
        null,
        issue.code,
        issue.message,
      );
    }
  }
  const entry = rows.find((file) => file.path === row.entry_path);
  if (entry) {
    const paths = new Set(rows.map((file) => file.path));
    const text = new TextDecoder().decode(entry.content);
    for (const link of relativeLinks(text)) {
      let target: string;
      try {
        target = normalizeSkillFilePath(link.target);
      } catch {
        continue;
      }
      if (!paths.has(target)) {
        add(
          entry.path,
          link.line,
          "referenced_file_missing",
          `The instructions mention "${link.target}", which is not in this skill.`,
          target,
        );
      }
    }
  }
  return problems;
}

/**
 * skillDrafts.check: what a publish would say about the draft, as sentences tied
 * to a file and, where known, a line. It runs the validation an upload runs, so
 * a draft that checks clean publishes.
 */
export async function checkSkillDraft(
  context: ActionContext,
): Promise<DraftCheck> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts);
  const rows = await readDraftFiles(facts, row.id);
  const problems = await draftProblems(
    row,
    rows,
    draftUpload(facts, row, rows, 1),
  );
  const check: DraftCheck = {
    ok: problems.length === 0,
    problems,
    draftVersion: row.version,
  };
  return check;
}

/** A draft ready to publish: the version it becomes, held until its bytes are stored. */
export type SkillDraftPublishPreparation = Readonly<{
  draftId: string;
  draftVersion: number;
  publication: LocalSkillVersionPublicationPreparation;
}>;

/**
 * skillDrafts.publish, first phase (before any object is written): the draft at
 * the version the caller saw, checked as a publish checks it, and prepared as the
 * next revision of its skill. A draft with problems is refused with each one.
 */
export async function prepareSkillDraftPublish(
  context: ActionContext,
): Promise<SkillDraftPublishPreparation> {
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  const expected = requireExpectedVersion(context, row);
  const rows = await readDraftFiles(facts, row.id);
  const next = Number(
    (await facts.transaction.query<{ next: number }>(
      `select coalesce(max(revision), 0) + 1 as next
         from bakery.skill_versions
        where organization_id = $1 and skill_id = $2`,
      [facts.organizationId, facts.skillId],
    )).rows[0].next,
  );
  const upload = draftUpload(facts, row, rows, next);
  const problems = await draftProblems(row, rows, upload);
  if (problems.length > 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: problems.map((problem) => ({
          path: problem.file === null ? [] : ["files", problem.file],
          code: problem.code,
          message: problem.line === null
            ? problem.message
            : `${problem.message} (line ${problem.line})`,
        })),
      },
    });
  }
  let digest: string;
  try {
    digest = (await validateLocalSkillVersion(upload, {
      computeDigest: true,
    })).digest;
  } catch (error) {
    if (error instanceof SkillUploadInvalid) uploadProblem(error);
    throw error;
  }
  const publication = await prepareLocalSkillVersionPublication({
    transaction: facts.transaction,
    input: { ...upload, digest },
    organizationId: facts.organizationId,
    principalId: facts.principalId,
  });
  return Object.freeze({
    draftId: row.id,
    draftVersion: expected,
    publication,
  });
}

/**
 * skillDrafts.publish, final phase: the version is finalized and the draft is
 * gone in one transaction, so a published draft is never published twice and a
 * draft that changed since it was prepared publishes nothing.
 */
export async function commitSkillDraftPublish(options: {
  context: ActionContext;
  preparation: SkillDraftPublishPreparation;
  proof: LocalSkillVersionPublicationProof;
}) {
  const { context, preparation, proof } = options;
  const facts = await authorableSkill(context);
  const row = await requireDraft(facts, true);
  if (
    row.id !== preparation.draftId || row.version !== preparation.draftVersion
  ) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const version = await finalizeLocalSkillVersionPublication({
    transaction: facts.transaction,
    context,
    preparation: preparation.publication,
    proof,
  });
  await facts.transaction.query(
    `delete from bakery.skill_drafts where organization_id = $1 and id = $2`,
    [facts.organizationId, row.id],
  );
  await appendAudit(facts.transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "skillDrafts.publish",
    resourceType: "skill_draft",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { skillId: facts.skillId, versionId: version.id },
  });
  return version;
}
