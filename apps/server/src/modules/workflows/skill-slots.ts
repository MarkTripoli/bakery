import type { PgTransactionClient } from "../../platform/database.ts";
import { collectStepSkills, stepPointer } from "../catalog/skill-use-grants.ts";

/** One step whose personal skill did not come along with a copy. */
export type SkillSlot = Readonly<{ stepPath: string; originalName: string }>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The object at `segments` inside the definition, or undefined. */
function stepAt(
  definition: unknown,
  segments: readonly (string | number)[],
): Record<string, unknown> | undefined {
  let node: unknown = definition;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[String(segment)];
  }
  return node !== null && typeof node === "object" && !Array.isArray(node)
    ? node as Record<string, unknown>
    : undefined;
}

/**
 * Takes every personal skill out of a definition that is about to be copied.
 * A copy is a new workflow, so it never inherits a use grant, and a personal skill
 * is visible to its owner alone: the copy keeps only a slot naming the step and the
 * skill's name, which is all the copier is allowed to learn.
 */
export async function stripPersonalSkills(
  transaction: PgTransactionClient,
  organizationId: string,
  definition: unknown,
): Promise<{ definition: unknown; slots: readonly SkillSlot[] }> {
  const refs = collectStepSkills(definition);
  if (refs.length === 0) return { definition, slots: [] };
  const personal = await transaction.query<
    { version_id: string; name: string }
  >(
    `select version.id as version_id, skill.name
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
      where version.organization_id = $1 and version.id = any($2::uuid[])
        and skill.scope = 'personal'`,
    [organizationId, [...new Set(refs.map((ref) => ref.versionId))]],
  );
  if (personal.rows.length === 0) return { definition, slots: [] };
  const names = new Map(personal.rows.map((row) => [row.version_id, row.name]));
  const copy = clone(definition);
  const slots = new Map<string, SkillSlot>();
  for (const ref of refs) {
    const name = names.get(ref.versionId);
    if (name === undefined) continue;
    const step = stepAt(copy, ref.segments);
    if (step === undefined || !Array.isArray(step.skills)) continue;
    const kept = step.skills.filter((id) => id !== ref.versionId);
    if (kept.length === 0) delete step.skills;
    else step.skills = kept;
    const pointer = stepPointer(ref.segments);
    // One slot per step: a step that named two personal skills keeps both names,
    // so the copier learns that each of them was dropped.
    const known = slots.get(pointer);
    if (known === undefined) {
      slots.set(pointer, { stepPath: pointer, originalName: name });
    } else if (!known.originalName.split(", ").includes(name)) {
      slots.set(pointer, {
        stepPath: pointer,
        originalName: `${known.originalName}, ${name}`,
      });
    }
  }
  return { definition: copy, slots: [...slots.values()] };
}

/** Records the slots of a new copy. */
export async function insertSkillSlots(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
  slots: readonly SkillSlot[],
): Promise<void> {
  for (const slot of slots) {
    await transaction.query(
      `insert into bakery.workflow_skill_slots (
         id, organization_id, workflow_id, step_path, original_name
       ) values ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        organizationId,
        workflowId,
        slot.stepPath,
        slot.originalName.slice(0, 200),
      ],
    );
  }
}

/** The slots still open on a workflow, in step order. */
export async function listOpenSkillSlots(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<readonly SkillSlot[]> {
  const rows = await transaction.query<{
    step_path: string;
    original_name: string;
  }>(
    `select step_path, original_name from bakery.workflow_skill_slots
      where organization_id = $1 and workflow_id = $2
      order by step_path`,
    [organizationId, workflowId],
  );
  return rows.rows.map((row) => ({
    stepPath: row.step_path,
    originalName: row.original_name,
  }));
}

/**
 * Closes the slots an author resolved by choosing another skill or removing the
 * step's skill. Naming a path that has no open slot is not an error: the save is
 * the author's statement that the step is settled.
 */
export async function resolveSkillSlots(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
  stepPaths: readonly string[] | undefined,
): Promise<void> {
  if (!stepPaths || stepPaths.length === 0) return;
  await transaction.query(
    `delete from bakery.workflow_skill_slots
      where organization_id = $1 and workflow_id = $2
        and step_path = any($3::text[])`,
    [organizationId, workflowId, [...stepPaths]],
  );
}
