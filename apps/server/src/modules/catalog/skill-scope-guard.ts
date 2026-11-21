import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { isOrganizationAdministratorRole } from "../auth/application/authorize.ts";

/** Who a skill belongs to: Bakery, one organization, or one person. */
export type SkillScope = "global" | "organization" | "personal";

/**
 * The membership role the caller holds right now, read inside the request's
 * transaction so a role removed a moment ago does not authorise one more write.
 */
async function liveRole(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const rows = await transaction.query<{ role: string | null; status: string }>(
    `select role, status
       from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2`,
    [organizationId, principalId],
  );
  const row = rows.rows[0];
  if (row === undefined || row.status !== "active" || row.role === null) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return row.role;
}

/**
 * Refuses unless the caller may author this skill (create a version of it,
 * rename it, switch it off).
 *
 * A personal skill is its owner's: somebody else, even an Admin, gets not found
 * and learns nothing, because acting on it would be acting as its owner. An
 * organization skill changes what everybody in the organization can use, so it
 * is Admin authority; Developer is only the floor the access policy enforces.
 * A skill that comes with Bakery is never changed through the API.
 */
export async function assertMayAuthorSkill(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  skill: Readonly<{ scope: SkillScope; ownerPrincipalId: string | null }>,
): Promise<void> {
  if (skill.scope === "personal") {
    if (skill.ownerPrincipalId !== principalId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    return;
  }
  if (skill.scope === "global") {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "global_skill_is_read_only" },
    });
  }
  const role = await liveRole(transaction, organizationId, principalId);
  if (!isOrganizationAdministratorRole(role)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

/**
 * A person sees every shared skill and their own personal (Private) skills, and
 * nobody else's. The one place a personal skill reaches another person is a
 * workflow it is attached to; that path never goes through these reads.
 */
export const SKILL_VISIBLE_TO = (principalParam: string) =>
  `(scope <> 'personal' or owner_principal_id = ${principalParam}::uuid)`;
