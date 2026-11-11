import {
  MembershipStatus,
  OrganizationRole,
  PrincipalType,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";

/**
 * The last-admin invariant: an organization always keeps at least one active,
 * enabled human holding the system `admin` role. Call this from every path
 * that removes, deactivates or demotes a membership (including custom-role
 * assignment and any future removal path) before applying the change, inside
 * the transaction that holds the organization lock. It locks the admin rows,
 * so two concurrent removals cannot each see "another admin remains".
 * Throws `STATE_CONFLICT` when no admin other than `excludingMembershipId`
 * would remain. Scoped bindings and custom roles never count as admins.
 */
export async function assertAnotherAdminRemains(
  client: PgTransactionClient,
  organizationId: string,
  excludingMembershipId: string,
): Promise<void> {
  const admins = await client.query<{ id: string }>(
    `select membership.id
    from bakery.organization_memberships as membership
    join bakery.principals as principal
      on principal.id = membership.principal_id
    where membership.organization_id = $1
      and membership.role = $2
      and membership.status = $3
      and principal.principal_type = $4
      and principal.disabled_at is null
      and membership.id <> $5
    order by membership.id
    for update of membership, principal`,
    [
      organizationId,
      OrganizationRole.Admin,
      MembershipStatus.Active,
      PrincipalType.Human,
      excludingMembershipId,
    ],
  );
  if (admins.rows.length === 0) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
}
