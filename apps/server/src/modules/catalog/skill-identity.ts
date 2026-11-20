import type { QueryResultRow } from "pg";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { SkillScope } from "./skill-scope-guard.ts";

/** What a new local skill is: its ids, its owner and, for a copy, its source. */
export type LocalSkillIdentity = Readonly<{
  skillId: string;
  sourceId: string;
  slug: string;
  name: string;
  scope: Exclude<SkillScope, "global">;
  /** The person a personal skill belongs to; null for an organization skill. */
  ownerPrincipalId: string | null;
  /** The skill and exact version a copy started from; null when not a copy. */
  copiedFrom: Readonly<{ skillId: string; versionId: string }> | null;
}>;

/** The private local-bundle source a skill created in this installation has. */
export function localSkillSourceLocator(
  organizationId: string,
  skillId: string,
): string {
  return `bakery://organizations/${organizationId}/skills/${skillId}`;
}

/**
 * Inserts a skill and its private local-bundle source, with no version yet.
 * The one writer of a new local skill, so a create and a copy cannot differ in
 * what a new skill starts as. Returns the skill row's columns.
 */
export async function insertLocalSkillIdentity<Row extends QueryResultRow>(
  transaction: PgTransactionClient,
  organizationId: string,
  identity: LocalSkillIdentity,
  returningColumns: string,
): Promise<Row | undefined> {
  await transaction.query(
    `insert into bakery.skill_sources (
       id, organization_id, source_type, locator, display_name,
       publisher, license, last_checked_at, enabled
     ) values ($1, $2, 'local_bundle', $3, $4, null, null, null, true)`,
    [
      identity.sourceId,
      organizationId,
      localSkillSourceLocator(organizationId, identity.skillId),
      identity.name,
    ],
  );
  const inserted = await transaction.query<Row>(
    `insert into bakery.skills (
       id, organization_id, source_id, slug, name, active_version_id,
       enabled, scope, owner_principal_id,
       copied_from_skill_id, copied_from_version_id
     ) values ($1, $2, $3, $4, $5, null, true, $6, $7, $8, $9)
     returning ${returningColumns}`,
    [
      identity.skillId,
      organizationId,
      identity.sourceId,
      identity.slug,
      identity.name,
      identity.scope,
      identity.ownerPrincipalId,
      identity.copiedFrom?.skillId ?? null,
      identity.copiedFrom?.versionId ?? null,
    ],
  );
  return inserted.rows[0];
}
