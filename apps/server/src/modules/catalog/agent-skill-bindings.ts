import { unprocessable } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";

const MAX_SKILL_BINDINGS = 100;
const IMMUTABLE_SKILL_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SkillBindingRow = Readonly<{
  id: string;
  digest: string;
  status: string;
  skill_enabled: boolean;
  source_enabled: boolean;
}>;

export type ResolvedAgentSkillPin = Readonly<{
  versionId: string;
  digest: string;
}>;

function bindingError(bindingName: string | undefined, code: string): never {
  throw unprocessable(
    bindingName === undefined
      ? ["config", "skillBindings"]
      : ["config", "skillBindings", bindingName],
    code,
  );
}

/**
 * Resolves immutable skill-version selectors while locking their current
 * catalog authority until the surrounding agent-version transaction commits.
 */
export async function resolveAgentSkillBindings(
  transaction: PgTransactionClient,
  organizationId: string,
  skillBindings: Readonly<Record<string, string>> | undefined,
): Promise<readonly ResolvedAgentSkillPin[]> {
  const entries = Object.entries(skillBindings ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (entries.length > MAX_SKILL_BINDINGS) {
    bindingError(undefined, "skill_bindings_too_many");
  }
  if (entries.length === 0) return Object.freeze([]);

  const namesByVersion = new Map<string, string>();
  for (const [bindingName, versionId] of entries) {
    if (!IMMUTABLE_SKILL_VERSION_ID.test(versionId)) {
      bindingError(bindingName, "skill_binding_invalid");
    }
    if (namesByVersion.has(versionId)) {
      bindingError(bindingName, "skill_binding_duplicate");
    }
    namesByVersion.set(versionId, bindingName);
  }

  // One ordered locking query avoids cross-agent lock inversions. FOR UPDATE
  // makes enabled/status changes serialize before or after this admission;
  // authority cannot change between resolution and agent-version insertion.
  const result = await transaction.query<SkillBindingRow>(
    `select version.id, version.digest, version.status,
            skill.enabled as skill_enabled,
            source.enabled as source_enabled
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
       join bakery.skill_sources as source
         on source.organization_id = skill.organization_id
        and source.id = skill.source_id
      where version.organization_id = $1
        and version.id = any($2::uuid[])
      order by version.id
      for update of version, skill, source`,
    [organizationId, [...namesByVersion.keys()].sort()],
  );
  const rows = new Map(result.rows.map((row) => [row.id, row]));

  return Object.freeze(entries.map(([bindingName, versionId]) => {
    const row = rows.get(versionId);
    // Organization scope is part of the lookup, so foreign and absent IDs are
    // intentionally indistinguishable to callers.
    if (!row) bindingError(bindingName, "skill_binding_unavailable");
    if (row.status !== "published") {
      bindingError(bindingName, "skill_binding_not_published");
    }
    if (!row.skill_enabled || !row.source_enabled) {
      bindingError(bindingName, "skill_binding_revoked");
    }
    return Object.freeze({ versionId: row.id, digest: row.digest });
  }));
}
