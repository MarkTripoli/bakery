import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { assertAnotherAdminRemains } from "../../apps/server/src/modules/auth/adapters/last-admin-postgres.ts";
import { openInstallationFixture } from "../helpers/installation-settings.ts";

async function membershipOf(
  f: Awaited<ReturnType<typeof openInstallationFixture>>,
  principalId: string,
) {
  const result = await f.pgDatabase.query<{ id: string }>(
    `select id from bakery.organization_memberships
     where organization_id = $1 and principal_id = $2`,
    [f.organizationId, principalId],
  );
  return result.rows[0].id;
}

Deno.test("assertAnotherAdminRemains blocks the last system admin and no one else", async () => {
  const f = await openInstallationFixture();
  try {
    const adminMembership = await membershipOf(f, f.adminId);
    const developerMembership = await membershipOf(f, f.developerId!);
    const check = (excluding: string) =>
      withPgTransaction(
        f.pgDatabase,
        (tx) => assertAnotherAdminRemains(tx, f.organizationId, excluding),
      );

    // Sole admin: removing or demoting them would leave none.
    const error = await assertRejects(
      () => check(adminMembership),
      StandardError,
    );
    assertEquals((error as StandardError).code, "STATE_CONFLICT");
    // Excluding a non-admin leaves the one admin standing.
    await check(developerMembership);

    // A scoped role never counts as an admin.
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'viewer'
       where id = $1`,
      [developerMembership],
    );
    await assertRejects(() => check(adminMembership), StandardError);

    // A second active human admin lets the first step down.
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
       where id = $1`,
      [developerMembership],
    );
    await check(adminMembership);

    // A disabled admin does not count.
    await f.pgDatabase.query(
      `update bakery.principals set disabled_at = current_timestamp
       where id = $1`,
      [f.developerId],
    );
    await assertRejects(() => check(adminMembership), StandardError);
  } finally {
    await f.finish();
  }
});
