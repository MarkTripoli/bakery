import { StandardError } from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
 * compiling it: an object that names an `action` and carries a `skills` array
 * is a step, wherever it sits, and each UUID in the array is one version.
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
    if (depth > MAX_WALK_DEPTH || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index], depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.action === "string" && Array.isArray(record.skills)) {
      for (const id of record.skills) {
        if (typeof id !== "string" || !UUID.test(id)) continue;
        found.set(`${stepPointer(path)}#${id}`, {
          segments: path,
          versionId: id,
        });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      walk(child, [...path, key], depth + 1);
    }
  };
  walk(definition, [], 0);
  return [...found.values()].slice(0, MAX_STEP_SKILL_REFS);
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
  const confirmed = new Set(facts.confirmed ?? []);
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
