import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { assertMayAuthorSkill, type SkillScope } from "./skill-scope-guard.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEP_SKILL_REFS = 256;
const MAX_WALK_DEPTH = 32;

/** One skill version named by one step of an authored workflow definition. */
export type StepSkillRef = Readonly<{
  /** Path of the step inside the definition, as object keys and array indexes. */
  segments: readonly (string | number)[];
  versionId: string;
}>;

/** The JSON Pointer a grant stores for a step. */
export function stepPointer(segments: readonly (string | number)[]): string {
  return segments.map((segment) =>
    `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
  ).join("");
}

/**
 * Every skill version a step of the definition adds. A draft is saved even when
 * it does not compile, so this reads the authored JSON tolerantly instead of
 * compiling it: an object that names an `action` (a compiled step) or `uses`
 * (a step as authored, which is what a draft holds) and carries a `skills`
 * array is a step, wherever it sits, and each UUID in the array is one
 * version, in the lower case the database stores it.
 *
 * A definition the walk cannot read to the end is refused, never truncated: a
 * step past the depth or reference limit would otherwise carry a personal skill
 * without the owner check.
 */
export function collectStepSkills(
  definition: unknown,
): readonly StepSkillRef[] {
  const found = new Map<string, StepSkillRef>();
  const walk = (
    value: unknown,
    path: readonly (string | number)[],
    depth: number,
  ): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > MAX_WALK_DEPTH) {
      throw definitionRefused(
        path,
        "definition_too_deep_to_check_skills",
        `A workflow definition nests at most ${MAX_WALK_DEPTH} levels deep so every skill it names can be checked.`,
      );
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index], depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      (typeof record.action === "string" || typeof record.uses === "string") &&
      Array.isArray(record.skills)
    ) {
      for (const id of record.skills) {
        if (typeof id !== "string" || !UUID.test(id)) continue;
        const versionId = id.toLowerCase();
        found.set(`${stepPointer(path)}#${versionId}`, {
          segments: path,
          versionId,
        });
        if (found.size > MAX_STEP_SKILL_REFS) {
          throw definitionRefused(
            path,
            "too_many_skill_references",
            `A workflow definition names at most ${MAX_STEP_SKILL_REFS} skill versions so every one can be checked.`,
          );
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      walk(child, [...path, key], depth + 1);
    }
  };
  walk(definition, [], 0);
  return [...found.values()];
}

function definitionRefused(
  segments: readonly (string | number)[],
  code: string,
  message: string,
): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: ["definition", ...segments], code, message }] },
  });
}

export type PersonalSkillUseFacts = Readonly<{
  organizationId: string;
  principalId: string;
  actorKind: "person" | "agent";
  requestId: string;
  traceId: string;
  workflowId: string;
  /** The draft's definition as authored. */
  definition: unknown;
  /** Skill versions the author confirmed sharing, named by the request. */
  confirmed: readonly string[] | undefined;
}>;

type PersonalVersionRow = {
  version_id: string;
  skill_id: string;
  owner_principal_id: string;
};

function issue(
  segments: readonly (string | number)[],
  code: string,
  message: string,
) {
  return { path: ["definition", ...segments, "skills"], code, message };
}

/**
 * Decides, for every personal skill a draft's steps name, whether the draft may
 * carry it, and records the grant when its owner confirms.
 *
 * A personal skill is visible to its owner alone, so letting a shared workflow
 * use it is an act of the owner: it needs the owner's explicit confirmation
 * naming the version, and nobody else can attach it. A step that already holds a
 * live grant for the exact version passes without asking again, so an Admin can
 * edit the rest of the workflow. A version the owner has not confirmed is
 * refused, so no client can share one silently, and a skill that is not the
 * caller's and not granted to this step answers as unavailable without saying
 * who owns it.
 */
export async function reconcilePersonalSkillUse(
  transaction: PgTransactionClient,
  facts: PersonalSkillUseFacts,
): Promise<void> {
  const refs = collectStepSkills(facts.definition);
  if (refs.length === 0) return;
  const versionIds = [...new Set(refs.map((ref) => ref.versionId))];
  const personal = await transaction.query<PersonalVersionRow>(
    `select version.id as version_id, skill.id as skill_id,
            skill.owner_principal_id
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
      where version.organization_id = $1
        and version.id = any($2::uuid[])
        and skill.scope = 'personal'`,
    [facts.organizationId, versionIds],
  );
  if (personal.rows.length === 0) return;
  const byVersion = new Map(personal.rows.map((row) => [row.version_id, row]));
  const granted = await transaction.query<{
    skill_version_id: string;
    step_path: string;
  }>(
    `select skill_version_id, step_path from bakery.skill_use_grants
      where organization_id = $1 and workflow_id = $2
        and skill_version_id = any($3::uuid[])`,
    [facts.organizationId, facts.workflowId, [...byVersion.keys()]],
  );
  const live = new Set(
    granted.rows.map((row) => `${row.step_path}#${row.skill_version_id}`),
  );
  const confirmed = new Set(
    (facts.confirmed ?? []).map((id) => id.toLowerCase()),
  );
  const issues: ReturnType<typeof issue>[] = [];
  const toGrant: { ref: StepSkillRef; row: PersonalVersionRow }[] = [];
  for (const ref of refs) {
    const row = byVersion.get(ref.versionId);
    if (!row) continue;
    const pointer = stepPointer(ref.segments);
    if (live.has(`${pointer}#${ref.versionId}`)) continue;
    if (row.owner_principal_id !== facts.principalId) {
      issues.push(issue(
        ref.segments,
        "skill_unavailable",
        "This skill is not available to this workflow.",
      ));
      continue;
    }
    if (!confirmed.has(ref.versionId)) {
      issues.push(issue(
        ref.segments,
        "personal_skill_confirmation_required",
        "Attaching a personal skill lets everyone who can see or run this workflow use this version; name it in confirmPersonalSkillUse to allow that.",
      ));
      continue;
    }
    toGrant.push({ ref, row });
  }
  if (issues.length > 0) {
    throw new StandardError({ code: "UNPROCESSABLE", params: { issues } });
  }
  if (toGrant.length === 0) return;
  // Letting a workflow use a skill is the owner's own act, never an agent's.
  if (facts.actorKind !== "person") {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "personal_skill_use_requires_person" },
    });
  }
  for (const { ref, row } of toGrant) {
    const id = crypto.randomUUID();
    const pointer = stepPointer(ref.segments);
    await transaction.query(
      `insert into bakery.skill_use_grants (
         id, organization_id, skill_id, skill_version_id, workflow_id,
         step_path, granted_by
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        facts.organizationId,
        row.skill_id,
        ref.versionId,
        facts.workflowId,
        pointer,
        facts.principalId,
      ],
    );
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: facts.principalId,
      operation: "skillUseGrants.create",
      resourceType: "skill_use_grant",
      resourceId: id,
      requestId: facts.requestId,
      traceId: facts.traceId,
      details: {
        skillId: row.skill_id,
        skillVersionId: ref.versionId,
        workflowId: facts.workflowId,
        stepPath: pointer,
      },
    });
    await appendDomainEvent(transaction, {
      organizationId: facts.organizationId,
      eventType: "skillUseGrant.created",
      aggregateId: id,
      aggregateVersion: 1,
      payload: { resourceId: id, resourceVersion: 1 },
      traceId: facts.traceId,
    });
  }
}

const GRANTS_ORDERING = "createdAt:desc,id:desc";

type GrantRow = {
  id: string;
  skill_id: string;
  skill_version_id: string;
  workflow_id: string;
  workflow_name: string;
  step_path: string;
  granted_by: string;
  created_at: Date | string;
  cursor_created_at: string;
  version: number;
};

function toGrant(row: GrantRow) {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    stepPath: row.step_path,
    grantedBy: row.granted_by,
    createdAt:
      (row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at)).toISOString(),
    version: row.version,
  };
}

/**
 * Loads the skill a use-grant request names and refuses unless the caller may
 * author it. Someone who cannot see a personal skill gets not found, never
 * forbidden, so the answer does not confirm that it exists.
 */
async function requireAuthorableSkill(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  skillId: string,
): Promise<void> {
  const found = await transaction.query<{
    scope: SkillScope;
    owner_principal_id: string | null;
  }>(
    `select scope, owner_principal_id from bakery.skills
      where organization_id = $1 and id = $2
        and (scope <> 'personal' or owner_principal_id = $3::uuid)`,
    [organizationId, skillId, principalId],
  );
  const skill = found.rows[0];
  if (!skill) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await assertMayAuthorSkill(transaction, organizationId, principalId, {
    scope: skill.scope,
    ownerPrincipalId: skill.owner_principal_id,
  });
}

/** The workflows a skill's owner let use it, newest first. */
export async function listSkillUseGrants(
  context: ActionContext,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const skillId = context.params.id;
  if (!skillId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await requireAuthorableSkill(
    transaction,
    organizationId,
    principalId,
    skillId,
  );
  const binding: CursorBinding = {
    action: "skills.useGrants.list",
    principalId,
    organizationId,
    ordering: GRANTS_ORDERING,
    filters: await sha256Hex(canonicalJson({ skillId })),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<GrantRow>(
    `select grant_row.id, grant_row.skill_id, grant_row.skill_version_id,
            grant_row.workflow_id, workflow.name as workflow_name,
            grant_row.step_path, grant_row.granted_by, grant_row.created_at,
            to_char(grant_row.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
            grant_row.version
       from bakery.skill_use_grants as grant_row
       join bakery.workflow_definitions as workflow
         on workflow.organization_id = grant_row.organization_id
        and workflow.id = grant_row.workflow_id
      where grant_row.organization_id = $1 and grant_row.skill_id = $2
        and ($3::timestamptz is null
          or (grant_row.created_at, grant_row.id) < ($3, $4::uuid))
      order by grant_row.created_at desc, grant_row.id desc
      limit $5`,
    [
      organizationId,
      skillId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = result.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(toGrant),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

/**
 * Stops a workflow using a personal skill: deletes the grant. Stopping is the
 * owner's own act, so an agent is refused. The audit log keeps the grant and
 * the stop; what a stopped grant refuses is decided where runs are admitted.
 */
export async function deleteSkillUseGrant(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const skillId = context.params.id;
  const grantId = context.params.grantId;
  if (!skillId || !grantId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (attributeAction(context, principalId).actorKind !== "person") {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "personal_skill_use_requires_person" },
    });
  }
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  await requireAuthorableSkill(
    transaction,
    organizationId,
    principalId,
    skillId,
  );
  const deleted = await transaction.query<{
    id: string;
    skill_version_id: string;
    workflow_id: string;
    step_path: string;
    version: number;
  }>(
    `delete from bakery.skill_use_grants
      where organization_id = $1 and id = $2 and skill_id = $3 and version = $4
      returning id, skill_version_id, workflow_id, step_path, version`,
    [organizationId, grantId, skillId, expectedVersion],
  );
  const row = deleted.rows[0];
  if (!row) {
    const exists = await transaction.query(
      `select 1 from bakery.skill_use_grants
        where organization_id = $1 and id = $2 and skill_id = $3`,
      [organizationId, grantId, skillId],
    );
    throw new StandardError({
      code: exists.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "skills.useGrants.delete",
    resourceType: "skill_use_grant",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      skillId,
      skillVersionId: row.skill_version_id,
      workflowId: row.workflow_id,
      stepPath: row.step_path,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "skillUseGrant.deleted",
    aggregateId: row.id,
    aggregateVersion: row.version + 1,
    payload: { resourceId: row.id, resourceVersion: row.version + 1 },
    traceId: context.traceId,
  });
  return null;
}
