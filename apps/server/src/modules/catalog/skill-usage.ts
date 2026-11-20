import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { SKILL_VISIBLE_TO } from "./skill-scope-guard.ts";

const USAGE_ORDERING = "createdAt:desc,id:desc";

type UsageRow = {
  kind: "workflow" | "agent";
  definition_id: string;
  definition_name: string;
  version_id: string;
  revision: number;
  skill_version_ids: string[];
  created_at: string;
  cursor_created_at: string;
};

/**
 * What uses a skill: the published workflow versions whose steps name one of its
 * versions, and the agent versions that bind one of them, newest first. A row is
 * one workflow or agent version and lists which versions of this skill it pins,
 * so a person can see what a new version of the skill would reach.
 *
 * A step uses a skill when it carries an action and a skills list naming the
 * version, the rule a save applies, never a match of the version id anywhere in
 * the definition. Only someone who can see the skill reads this: another
 * person's Private skill is not found.
 */
export async function listSkillUsage(
  context: ActionContext,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const skillId = context.params.id;
  if (!skillId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const visible = await transaction.query(
    `select 1 from bakery.skills
      where organization_id = $1 and id = $2 and ${SKILL_VISIBLE_TO("$3")}`,
    [organizationId, skillId, principalId],
  );
  if (visible.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const binding: CursorBinding = {
    action: "skills.usedBy",
    principalId,
    organizationId,
    ordering: USAGE_ORDERING,
    filters: await sha256Hex(canonicalJson({ skillId })),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<UsageRow>(
    `with used as (
       select 'workflow'::text as kind, definition.id as definition_id,
              definition.name as definition_name, version.id as version_id,
              version.revision, version.created_at,
              array(
                select skill_version.id
                  from bakery.skill_versions as skill_version
                 where skill_version.organization_id = version.organization_id
                   and skill_version.skill_id = $2
                   and exists (
                     select 1
                       from jsonb_path_query(
                         version.normalized_spec,
                         '$.** ? (@.action.type() == "string" && @.skills.type() == "array").skills[*]'
                       ) as named
                      where lower(named #>> '{}') = skill_version.id::text)
                 order by skill_version.revision
              ) as skill_version_ids
         from bakery.workflow_versions as version
         join bakery.workflow_definitions as definition
           on definition.organization_id = version.organization_id
          and definition.id = version.workflow_id
        where version.organization_id = $1 and version.status = 'published'
       union all
       select 'agent'::text, definition.id, definition.name, version.id,
              version.revision, version.created_at,
              array(
                select skill_version.id
                  from bakery.skill_versions as skill_version
                 where skill_version.organization_id = version.organization_id
                   and skill_version.skill_id = $2
                   and jsonb_typeof(version.config -> 'skillBindings') = 'object'
                   and exists (
                     select 1
                       from jsonb_each_text(version.config -> 'skillBindings')
                         as binding
                      where lower(binding.value) = skill_version.id::text)
                 order by skill_version.revision
              )
         from bakery.agent_versions as version
         join bakery.agent_definitions as definition
           on definition.organization_id = version.organization_id
          and definition.id = version.agent_id
        where version.organization_id = $1
     )
     select kind, definition_id, definition_name, version_id, revision,
            skill_version_ids,
            to_char(created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from used
      where cardinality(skill_version_ids) > 0
        and ($3::timestamptz is null
          or (created_at, version_id) < ($3, $4::uuid))
      order by created_at desc, version_id desc
      limit $5`,
    [
      organizationId,
      skillId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      kind: row.kind,
      definitionId: row.definition_id,
      definitionName: row.definition_name,
      versionId: row.version_id,
      revision: row.revision,
      skillVersionIds: row.skill_version_ids,
      createdAt: row.created_at,
    })),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.version_id,
      })
      : null,
  };
}
