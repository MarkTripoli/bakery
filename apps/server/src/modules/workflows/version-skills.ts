import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { collectStepSkills, stepPointer } from "../catalog/skill-use-grants.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { listOpenSkillSlots } from "./skill-slots.ts";
import type { WorkflowValidationIssue } from "./validation.ts";

type VersionSkillRow = {
  version_id: string;
  revision: number;
  name: string;
  scope: "global" | "organization" | "personal";
  owner_principal_id: string | null;
  owner_display_name: string | null;
  owner_active: boolean | null;
  skill_enabled: boolean;
  source_enabled: boolean;
};

/** What a person may do with the skill at one step of a workflow version. */
export type StepSkillStatus =
  | "available"
  | "stopped"
  | "unavailable"
  | "missing";

/** Whether the skill can be used at the step right now. */
function statusOf(
  row: VersionSkillRow | undefined,
  granted: boolean,
): StepSkillStatus {
  if (row === undefined) return "unavailable";
  if (!row.skill_enabled || !row.source_enabled) return "unavailable";
  if (row.scope !== "personal") return "available";
  // A personal skill is usable only while its owner is still in the
  // organization and a live use grant covers this step and version.
  if (row.owner_active !== true) return "unavailable";
  return granted ? "available" : "stopped";
}

/**
 * The skills each step of one workflow version uses, as the reader may see
 * them. Someone else's personal skill is a placeholder: its name, its owner's
 * display name and its version, never a link, a file or a description. Whether a
 * published version still uses a skill is answered to the skill's owner only,
 * because it tells who else relies on a personal skill.
 */
export async function readWorkflowVersionSkills(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const workflowId = context.params.id;
  const versionId = context.params.versionId;
  if (!workflowId || !versionId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const loaded = await loadDefinition(
    transaction,
    organizationId,
    workflowId,
    versionId,
  );
  return {
    items: await resolveStepSkills(transaction, {
      organizationId,
      principalId,
      workflowId,
      definition: loaded.definition,
      // Open slots belong to the draft; a published version never has one.
      includeSlots: loaded.draft,
    }),
  };
}

export type ResolvedStepSkill = Readonly<{
  stepPath: string;
  skillVersionId: string | null;
  skillName: string | null;
  revision: number | null;
  scope: "global" | "organization" | "personal" | null;
  ownerDisplayName: string | null;
  mine: boolean;
  status: StepSkillStatus;
  publishedVersionUsesIt: boolean;
}>;

/**
 * Resolves every skill version the definition's steps name. `workflowId` is null
 * for a definition that is not yet a workflow's (a stateless validation): no use
 * grant can exist for it, so a personal skill counts as usable only for its own
 * owner, who is the one who could confirm it at save.
 */
export async function resolveStepSkills(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    workflowId: string | null;
    definition: unknown;
    /** Whether the workflow's open slots are listed too; true by default. */
    includeSlots?: boolean;
  }>,
): Promise<ResolvedStepSkill[]> {
  const items = await resolveReferencedSkills(transaction, facts);
  if (facts.workflowId === null || facts.includeSlots === false) return items;
  const slots = await listOpenSkillSlots(
    transaction,
    facts.organizationId,
    facts.workflowId,
  );
  if (slots.length === 0) return items;
  for (const slot of slots) {
    items.push({
      stepPath: slot.stepPath,
      skillVersionId: null,
      skillName: slot.originalName,
      revision: null,
      scope: null,
      ownerDisplayName: null,
      mine: false,
      status: "missing",
      publishedVersionUsesIt: false,
    });
  }
  items.sort(compareItems);
  return items;
}

function compareItems(left: ResolvedStepSkill, right: ResolvedStepSkill) {
  return left.stepPath.localeCompare(right.stepPath) ||
    (left.skillVersionId ?? "").localeCompare(right.skillVersionId ?? "");
}

async function resolveReferencedSkills(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    workflowId: string | null;
    definition: unknown;
  }>,
): Promise<ResolvedStepSkill[]> {
  const { organizationId, principalId, workflowId, definition } = facts;
  const refs = collectStepSkills(definition);
  if (refs.length === 0) return [];
  const versionIds = [...new Set(refs.map((ref) => ref.versionId))];
  const skills = await transaction.query<VersionSkillRow>(
    `select version.id as version_id, version.revision, skill.name,
            skill.scope, skill.owner_principal_id,
            owner.display_name as owner_display_name,
            (membership.status = 'active') as owner_active,
            skill.enabled as skill_enabled, source.enabled as source_enabled
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
       join bakery.skill_sources as source
         on source.organization_id = skill.organization_id
        and source.id = skill.source_id
       left join bakery.principals as owner
         on owner.id = skill.owner_principal_id
       left join bakery.organization_memberships as membership
         on membership.organization_id = skill.organization_id
        and membership.principal_id = skill.owner_principal_id
      where version.organization_id = $1 and version.id = any($2::uuid[])`,
    [organizationId, versionIds],
  );
  const byVersion = new Map(skills.rows.map((row) => [row.version_id, row]));
  const personalVersions = skills.rows
    .filter((row) => row.scope === "personal")
    .map((row) => row.version_id);
  const live = new Set<string>();
  const publishedUse = new Set<string>();
  if (personalVersions.length > 0 && workflowId !== null) {
    const grants = await transaction.query<{
      skill_version_id: string;
      step_path: string;
    }>(
      `select skill_version_id, step_path from bakery.skill_use_grants
        where organization_id = $1 and workflow_id = $2
          and skill_version_id = any($3::uuid[])`,
      [organizationId, workflowId, personalVersions],
    );
    for (const row of grants.rows) {
      live.add(`${row.step_path}#${row.skill_version_id}`);
    }
    const mine = skills.rows
      .filter((row) =>
        row.scope === "personal" && row.owner_principal_id === principalId
      )
      .map((row) => row.version_id);
    if (mine.length > 0) {
      // What a published version uses is read from its steps' skill lists, the
      // way a save reads them, never from the text of the whole definition.
      const specs = await transaction.query<{ definition: unknown }>(
        `select normalized_spec as definition from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [organizationId, workflowId],
      );
      const wanted = new Set(mine);
      for (const spec of specs.rows) {
        for (const ref of collectStepSkills(spec.definition)) {
          if (wanted.has(ref.versionId)) publishedUse.add(ref.versionId);
        }
      }
    }
  }
  const items = refs.map((ref) => {
    const row = byVersion.get(ref.versionId);
    const pointer = stepPointer(ref.segments);
    return {
      stepPath: pointer,
      skillVersionId: ref.versionId,
      skillName: row?.name ?? null,
      revision: row?.revision ?? null,
      scope: row?.scope ?? null,
      ownerDisplayName: row?.scope === "personal"
        ? row.owner_display_name
        : null,
      mine: row?.scope === "personal" &&
        row.owner_principal_id === principalId,
      status: workflowId === null && row?.scope === "personal" &&
          row.owner_active === true
        ? (row.owner_principal_id === principalId ? "available" : "unavailable")
        : statusOf(row, live.has(`${pointer}#${ref.versionId}`)),
      publishedVersionUsesIt: publishedUse.has(ref.versionId),
    };
  });
  items.sort(compareItems);
  return items;
}

/**
 * Findings for a definition that names a skill no one can use at its step: a
 * personal skill whose owner stopped it or never allowed it there, one that was
 * removed or switched off, or one whose owner left. Publishing and validating
 * refuse them, naming the step, so a step is never published with a hole in it.
 */
export async function stepSkillIssues(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    workflowId: string | null;
    definition: unknown;
  }>,
): Promise<readonly WorkflowValidationIssue[]> {
  const items = await resolveStepSkills(transaction, facts);
  return items.filter((item) => item.status !== "available").map((item) => {
    const code = item.status === "stopped"
      ? "step_skill_stopped"
      : item.status === "missing"
      ? "step_skill_slot_open"
      : "step_skill_unavailable";
    return Object.freeze({
      path: `${item.stepPath}/skills`,
      code,
      message: code.replaceAll("_", " "),
    });
  });
}

async function loadDefinition(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
  versionId: string,
): Promise<{ definition: unknown; draft: boolean }> {
  const published = await transaction.query<{ definition: unknown }>(
    `select normalized_spec as definition from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, versionId],
  );
  if (published.rows[0]) {
    return { definition: published.rows[0].definition, draft: false };
  }
  const draft = await transaction.query<{ definition: unknown }>(
    `select definition from bakery.workflow_drafts
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, workflowId, versionId],
  );
  if (draft.rows[0]) {
    return { definition: draft.rows[0].definition, draft: true };
  }
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}
