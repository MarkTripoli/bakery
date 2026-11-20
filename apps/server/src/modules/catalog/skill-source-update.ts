import type { ActionContext } from "@bakery/contracts/action-registry";
import { type contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
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
 * Looks at the skill's source again and says whether it holds something newer
 * than the installed version, file by file. Nothing is installed: taking the
 * update is a separate step a person chooses after reading this.
 *
 * It follows the requested revision of the skill's latest completed import (a
 * branch or tag moves, a commit does not). A source that cannot be reached is
 * an answer, not an error: the skill still works, only the check failed, and
 * the last good check time is left alone.
 */
export async function checkSkillSourceUpdate(
  context: ActionContext,
  deps: Readonly<{
    adapter?: SkillSourceAdapter;
    store?: SkillFileStoreOperations;
  }>,
): Promise<SourceUpdate> {
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
         select requested_revision
           from bakery.skill_imports as import
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
  if (deps.adapter === undefined) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }

  const base = {
    skillId: facts.skillId,
    sourceId: skill.source_id,
    requestedRevision: skill.requested_revision,
    installedRevision: skill.installed_revision,
  };
  let proof;
  try {
    proof = await deps.adapter.fetchPinnedSource({
      sourceType: skill.source_type as SkillSourceType,
      locator: skill.locator,
      requestedRevision: skill.requested_revision,
      path: skill.source_path || undefined,
      signal: AbortSignal.timeout(SKILL_SOURCE_UPDATE_TIMEOUT_MS),
    });
  } catch (error) {
    const problem = error instanceof SkillSourceAdapterError
      ? error.code
      : "SOURCE_UNAVAILABLE";
    return {
      ...base,
      status: "unreachable",
      latestRevision: null,
      lastCheckedAt: skill.last_checked_at,
      problem,
      changes: [],
      changesTruncated: false,
    };
  }

  const installed = (await transaction.query<InstalledFile>(
    `select path, size_bytes, sha256, is_executable, object_key
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2 order by path`,
    [organizationId, skill.installed_version_id],
  )).rows;
  const installedByPath = new Map(installed.map((file) => [file.path, file]));
  const latestByPath = new Map(
    proof.inventory.files.map((file) => [file.path, file]),
  );
  const paths = [
    ...new Set([...installedByPath.keys(), ...latestByPath.keys()]),
  ]
    .sort();

  const changes: Change[] = [];
  let changesTruncated = false;
  for (const path of paths) {
    const before = installedByPath.get(path);
    const after = latestByPath.get(path);
    const afterSha = after ? await skillFileSha256(after.content) : null;
    if (before && after && before.sha256 === afterSha) {
      if (before.is_executable === after.isExecutable) continue;
    }
    if (changes.length >= SKILL_SOURCE_UPDATE_MAX_CHANGES) {
      changesTruncated = true;
      break;
    }
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

  const checked = await transaction.query<{ last_checked_at: string }>(
    `update bakery.skill_sources
        set last_checked_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning to_char(last_checked_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_checked_at`,
    [organizationId, skill.source_id],
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
      sourceId: skill.source_id,
      installedRevision: skill.installed_revision,
      latestRevision: proof.sourceRevision,
      changedFiles: changes.length,
    },
  });
  return {
    ...base,
    status: changes.length > 0 ? "update_available" : "current",
    latestRevision: proof.sourceRevision,
    lastCheckedAt: checked.rows[0]?.last_checked_at ?? null,
    problem: null,
    changes,
    changesTruncated,
  };
}
