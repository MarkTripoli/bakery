import type { ActionContext } from "@bakery/contracts/action-registry";
import { type contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import type { z } from "zod";
import { authorableSkill } from "./skill-drafts.ts";
import { diffSkillText } from "./skill-text-diff.ts";
import {
  type SkillSourceAdapter,
  SkillSourceAdapterError,
  type SkillSourceType,
} from "./source-adapters.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import { skillFileSha256 } from "./validation.ts";

type SourceUpdate = z.output<typeof contractSchemas.SkillSourceUpdateCheck>;
/** One entry of the answer's changes, as the contract describes it. */
type Change = Readonly<{
  path: string;
  change: "added" | "removed" | "changed";
  installedSha256: string | null;
  latestSha256: string | null;
  installedSizeBytes: number | null;
  latestSizeBytes: number | null;
  diff: string | null;
  diffOmitted: "binary" | "too_large" | "mode_only" | null;
}>;

/** How long one check waits for the source, under the request's own deadline. */
export const SKILL_SOURCE_UPDATE_TIMEOUT_MS = 8_000;
/** The most changed files one answer lists. */
export const SKILL_SOURCE_UPDATE_MAX_CHANGES = 200;

type InstalledFile = {
  path: string;
  size_bytes: number;
  sha256: string;
  is_executable: boolean;
  object_key: string;
};

/**
 * What the check learned before any network or object I/O: the skill, its
 * source and the files of the installed version. Read in a transaction that is
 * then given up, so the fetch that follows holds no connection.
 */
export type SkillSourceUpdatePreparation = Readonly<{
  skillId: string;
  sourceId: string;
  sourceType: SkillSourceType;
  locator: string;
  sourcePath: string | undefined;
  requestedRevision: string;
  installedRevision: string;
  installedVersionId: string;
  lastCheckedAt: string | null;
  installed: readonly InstalledFile[];
}>;

/** What looking at the source again found, held between the two transactions. */
export type SkillSourceUpdateReading = Readonly<
  | { reached: false; problem: string }
  | {
    reached: true;
    latestRevision: string;
    changes: readonly Change[];
    changesTruncated: boolean;
    /** Every file that differs, including those past the list's cap. */
    changedFiles: number;
  }
>;

/**
 * skills.sourceUpdate, first phase: the skill the caller may author and the
 * facts the check needs, refused as the check is refused (no remote source, no
 * completed import). Nothing is fetched here.
 */
export async function prepareSkillSourceUpdate(
  context: ActionContext,
): Promise<SkillSourceUpdatePreparation> {
  const facts = await authorableSkill(context);
  const { transaction, organizationId } = facts;
  const found = await transaction.query<{
    source_id: string;
    source_type: string;
    locator: string;
    source_path: string | null;
    requested_revision: string | null;
    installed_revision: string | null;
    installed_version_id: string | null;
    last_checked_at: string | null;
  }>(
    `select source.id as source_id, source.source_type, source.locator,
            skill.source_path, latest.requested_revision,
            version.source_revision as installed_revision,
            version.id as installed_version_id,
            to_char(source.last_checked_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_checked_at
       from bakery.skills as skill
       join bakery.skill_sources as source
         on source.organization_id = skill.organization_id
        and source.id = skill.source_id
       left join bakery.skill_versions as version
         on version.organization_id = skill.organization_id
        and version.id = skill.active_version_id
       left join lateral (
         -- A reviewed update pins the exact revision it took and records the
         -- branch it follows; the check keeps following that branch.
         select coalesce(run.snapshot #>> '{request,followedRevision}',
                         import.requested_revision) as requested_revision
           from bakery.skill_imports as import
           join bakery.workflow_runs as run
             on run.organization_id = import.organization_id
            and run.id = import.run_id
          where import.organization_id = skill.organization_id
            and import.skill_id = skill.id and import.state = 'completed'
          order by import.updated_at desc, import.id desc
          limit 1
       ) as latest on true
      where skill.organization_id = $1 and skill.id = $2`,
    [organizationId, facts.skillId],
  );
  const skill = found.rows[0];
  if (!skill) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (skill.source_type !== "git" && skill.source_type !== "url") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_has_no_remote_source" },
    });
  }
  if (
    skill.requested_revision === null || skill.installed_revision === null ||
    skill.installed_version_id === null
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_has_no_completed_import" },
    });
  }
  const installed = (await transaction.query<InstalledFile>(
    `select path, size_bytes, sha256, is_executable, object_key
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2 order by path`,
    [organizationId, skill.installed_version_id],
  )).rows;
  return Object.freeze({
    skillId: facts.skillId,
    sourceId: skill.source_id,
    sourceType: skill.source_type,
    locator: skill.locator,
    sourcePath: skill.source_path || undefined,
    requestedRevision: skill.requested_revision,
    installedRevision: skill.installed_revision,
    installedVersionId: skill.installed_version_id,
    lastCheckedAt: skill.last_checked_at,
    installed,
  });
}

/**
 * skills.sourceUpdate, middle phase, with no transaction open: looks at the
 * source again and compares it with the installed files, file by file. A source
 * that cannot be reached is an answer, not an error: the skill still works,
 * only the check failed.
 */
export async function readSkillSourceUpdate(
  preparation: SkillSourceUpdatePreparation,
  deps: Readonly<{
    adapter?: SkillSourceAdapter;
    store?: SkillFileStoreOperations;
  }>,
): Promise<SkillSourceUpdateReading> {
  if (deps.adapter === undefined) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  let proof;
  try {
    proof = await deps.adapter.fetchPinnedSource({
      sourceType: preparation.sourceType,
      locator: preparation.locator,
      requestedRevision: preparation.requestedRevision,
      path: preparation.sourcePath,
      signal: AbortSignal.timeout(SKILL_SOURCE_UPDATE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      reached: false,
      problem: error instanceof SkillSourceAdapterError
        ? error.code
        : "SOURCE_UNAVAILABLE",
    };
  }

  const installedByPath = new Map(
    preparation.installed.map((file) => [file.path, file]),
  );
  const latestByPath = new Map(
    proof.inventory.files.map((file) => [file.path, file]),
  );
  const paths = [
    ...new Set([...installedByPath.keys(), ...latestByPath.keys()]),
  ].sort();

  // Which files differ is settled first, so the answer can say how many there
  // are even when it lists only the first of them.
  const differing: {
    path: string;
    before: InstalledFile | undefined;
    after: (typeof proof.inventory.files)[number] | undefined;
    afterSha: string | null;
  }[] = [];
  for (const path of paths) {
    const before = installedByPath.get(path);
    const after = latestByPath.get(path);
    const afterSha = after ? await skillFileSha256(after.content) : null;
    if (
      before && after && before.sha256 === afterSha &&
      before.is_executable === after.isExecutable
    ) continue;
    differing.push({ path, before, after, afterSha });
  }

  const changes: Change[] = [];
  for (const { path, before, after, afterSha } of differing) {
    if (changes.length >= SKILL_SOURCE_UPDATE_MAX_CHANGES) break;
    // The installed bytes are only needed for a text difference: a file that
    // changed or was removed. An added file has none, a mode-only change no diff.
    let beforeBytes: Uint8Array | null = null;
    if (before && before.sha256 !== afterSha) {
      if (deps.store === undefined) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      beforeBytes = await deps.store.read(
        before.object_key,
        before.sha256,
        before.size_bytes,
      );
    }
    let diff: string | null = null;
    let diffOmitted: Change["diffOmitted"] = null;
    if (before && after && before.sha256 === afterSha) {
      diffOmitted = "mode_only";
    } else {
      const shown = diffSkillText(beforeBytes, after?.content ?? null);
      if (shown.kind === "diff") diff = shown.text;
      else diffOmitted = shown.reason;
    }
    changes.push({
      path,
      change: !before ? "added" : !after ? "removed" : "changed",
      installedSha256: before?.sha256 ?? null,
      latestSha256: afterSha,
      installedSizeBytes: before?.size_bytes ?? null,
      latestSizeBytes: after?.content.byteLength ?? null,
      diff,
      diffOmitted,
    });
  }
  return {
    reached: true,
    latestRevision: proof.sourceRevision,
    changes,
    changesTruncated: differing.length > changes.length,
    changedFiles: differing.length,
  };
}

/**
 * skills.sourceUpdate, last phase: the caller is checked again, the skill must
 * still be the one that was read, and a look that reached the source moves the
 * source's last check time and is audited. An unreachable source writes nothing,
 * so the last good check time stays.
 */
export async function commitSkillSourceUpdate(
  context: ActionContext,
  preparation: SkillSourceUpdatePreparation,
  reading: SkillSourceUpdateReading,
): Promise<SourceUpdate> {
  const facts = await authorableSkill(context);
  const { transaction, organizationId } = facts;
  const current = await transaction.query<{ source_id: string | null }>(
    `select source_id from bakery.skills
      where organization_id = $1 and id = $2`,
    [organizationId, facts.skillId],
  );
  if (
    facts.activeVersionId !== preparation.installedVersionId ||
    current.rows[0]?.source_id !== preparation.sourceId
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_changed_during_source_check" },
    });
  }
  const base = {
    skillId: preparation.skillId,
    sourceId: preparation.sourceId,
    requestedRevision: preparation.requestedRevision,
    installedRevision: preparation.installedRevision,
  };
  if (!reading.reached) {
    return {
      ...base,
      status: "unreachable",
      latestRevision: null,
      lastCheckedAt: preparation.lastCheckedAt,
      problem: reading.problem,
      changes: [],
      changesTruncated: false,
    };
  }
  const checked = await transaction.query<{ last_checked_at: string }>(
    `update bakery.skill_sources
        set last_checked_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning to_char(last_checked_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_checked_at`,
    [organizationId, preparation.sourceId],
  );
  await appendAudit(transaction, {
    organizationId,
    principalId: facts.principalId,
    operation: "skills.sourceUpdate",
    resourceType: "skill",
    resourceId: facts.skillId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      sourceId: preparation.sourceId,
      installedRevision: preparation.installedRevision,
      latestRevision: reading.latestRevision,
      changedFiles: reading.changedFiles,
      changesTruncated: reading.changesTruncated,
    },
  });
  return {
    ...base,
    status: reading.changedFiles > 0 ? "update_available" : "current",
    latestRevision: reading.latestRevision,
    lastCheckedAt: checked.rows[0]?.last_checked_at ?? null,
    problem: null,
    changes: [...reading.changes],
    changesTruncated: reading.changesTruncated,
  };
}

/**
 * skills.takeSourceUpdate, last phase: the caller may still author the skill,
 * the skill is the version they saw (If-Match), it still has the source and
 * installed version that were read, and the source's latest revision is still
 * the one they reviewed. Returns what the import needs; nothing is written here.
 */
export async function confirmSkillSourceUpdateTake(
  context: ActionContext,
  preparation: SkillSourceUpdatePreparation,
  reading: SkillSourceUpdateReading,
  revision: string,
): Promise<
  Readonly<{
    principalId: string;
    organizationId: string;
    sourceId: string;
    sourcePath: string;
    followedRevision: string;
    scope: "organization" | "personal";
    ownerPrincipalId: string | null;
  }>
> {
  const facts = await authorableSkill(context);
  const { transaction, organizationId } = facts;
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const current = await transaction.query<
    { source_id: string | null; source_path: string | null; version: number }
  >(
    `select source_id, source_path, version from bakery.skills
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, facts.skillId],
  );
  const skill = current.rows[0];
  if (!skill) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (skill.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (
    facts.activeVersionId !== preparation.installedVersionId ||
    skill.source_id !== preparation.sourceId
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_changed_during_source_check" },
    });
  }
  if (!reading.reached) {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason: reading.problem },
    });
  }
  if (reading.latestRevision !== revision) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_update_revision_not_latest" },
    });
  }
  if (revision === preparation.installedRevision) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_update_already_installed" },
    });
  }
  const imported = await transaction.query(
    `select 1 from bakery.skill_versions
      where organization_id = $1 and skill_id = $2 and source_revision = $3
        and status = 'published'
      limit 1`,
    [organizationId, facts.skillId, revision],
  );
  if (imported.rows.length > 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_update_revision_already_imported" },
    });
  }
  return Object.freeze({
    principalId: facts.principalId,
    organizationId,
    sourceId: preparation.sourceId,
    sourcePath: skill.source_path ?? "",
    followedRevision: preparation.requestedRevision,
    // The update is a new version of this same skill, so it keeps its scope.
    scope: facts.scope === "personal" ? "personal" : "organization",
    ownerPrincipalId: facts.scope === "personal" ? facts.principalId : null,
  });
}
