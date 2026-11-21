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

/**
 * A skill Bakery installs into an organization (scope global). It has no owner
 * and no copy lineage, and its source names Bakery as the publisher and the
 * bundled package as the locator, so where it came from is on the record.
 */
export type GlobalSkillIdentity = Readonly<{
  skillId: string;
  sourceId: string;
  slug: string;
  name: string;
  /** The bundled package this skill was installed from, e.g. `bakery-authoring`. */
  packageSlug: string;
}>;

/** The source locator of a bundled package, the same in every organization. */
export function bundledSkillSourceLocator(packageSlug: string): string {
  return `bakery://bundled-skills/${packageSlug}`;
}

/** The private local-bundle source a skill created in this installation has. */
export function localSkillSourceLocator(
  organizationId: string,
  skillId: string,
): string {
  return `bakery://organizations/${organizationId}/skills/${skillId}`;
}

type IdentityRow = Readonly<{
  skillId: string;
  sourceId: string;
  slug: string;
  name: string;
  scope: SkillScope;
  ownerPrincipalId: string | null;
  copiedFrom: LocalSkillIdentity["copiedFrom"];
  sourceLocator: string;
  publisher: string | null;
}>;

/**
 * Inserts a skill and its local-bundle source, with no version yet. The one
 * writer of a new skill row, whoever it is for.
 */
async function insertSkillIdentity<Row extends QueryResultRow>(
  transaction: PgTransactionClient,
  organizationId: string,
  identity: IdentityRow,
  returningColumns: string,
): Promise<Row | undefined> {
  await transaction.query(
    `insert into bakery.skill_sources (
       id, organization_id, source_type, locator, display_name,
       publisher, license, last_checked_at, enabled
     ) values ($1, $2, 'local_bundle', $3, $4, $5, null, null, true)`,
    [
      identity.sourceId,
      organizationId,
      identity.sourceLocator,
      identity.name,
      identity.publisher,
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

/**
 * Inserts a skill and its private local-bundle source, with no version yet.
 * The one writer of a new local skill, so a create and a copy cannot differ in
 * what a new skill starts as. Returns the skill row's columns.
 */
export function insertLocalSkillIdentity<Row extends QueryResultRow>(
  transaction: PgTransactionClient,
  organizationId: string,
  identity: LocalSkillIdentity,
  returningColumns: string,
): Promise<Row | undefined> {
  return insertSkillIdentity<Row>(transaction, organizationId, {
    ...identity,
    sourceLocator: localSkillSourceLocator(organizationId, identity.skillId),
    publisher: null,
  }, returningColumns);
}

/** Inserts a skill Bakery installs (scope global), with no version yet. */
export function insertGlobalSkillIdentity<Row extends QueryResultRow>(
  transaction: PgTransactionClient,
  organizationId: string,
  identity: GlobalSkillIdentity,
  returningColumns: string,
): Promise<Row | undefined> {
  return insertSkillIdentity<Row>(transaction, organizationId, {
    skillId: identity.skillId,
    sourceId: identity.sourceId,
    slug: identity.slug,
    name: identity.name,
    scope: "global",
    ownerPrincipalId: null,
    copiedFrom: null,
    sourceLocator: bundledSkillSourceLocator(identity.packageSlug),
    publisher: "Bakery",
  }, returningColumns);
}
