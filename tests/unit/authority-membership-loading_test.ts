import { assert, assertEquals } from "@std/assert";
import { OrganizationRole } from "../../packages/contracts/src/contracts.ts";
import { membershipFromRow } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { MembershipRow } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import {
  catalogPermissionKeys,
  isCatalogPermissionKey,
} from "../../apps/server/src/modules/auth/application/permissions.ts";

/** The first valid catalog permission key, used for real-custom-role tests. */
const readPermission = catalogPermissionKeys[0];
assert(typeof readPermission === "string", "catalogPermissionKeys non-empty");

Deno.test("undefined custom-role columns produce no customRole", () => {
  // A pre-custom-role mock returns `undefined` for missing columns; the row is
  // cast defensively since `MembershipRow` declares the post-refactor shape.
  const authority = membershipFromRow({
    role: OrganizationRole.Guest,
    status: "active",
  } as unknown as MembershipRow);
  assertEquals(authority.customRole, undefined);
  assertEquals(authority.role, OrganizationRole.Guest);
});

Deno.test("null custom-role columns produce no customRole", () => {
  const row: MembershipRow = {
    role: OrganizationRole.Guest,
    status: "active",
    customRoleId: null,
    customRoleKey: null,
    customRolePermissions: null,
  };
  const authority = membershipFromRow(row);
  assertEquals(authority.customRole, undefined);
  assertEquals(authority.role, OrganizationRole.Guest);
});

Deno.test("a real custom role row builds a present customRole", () => {
  const row: MembershipRow = {
    role: OrganizationRole.Guest,
    status: "active",
    customRoleId: "00000000-0000-4000-8000-0000000000ff",
    customRoleKey: "reader",
    customRolePermissions: [readPermission],
  };
  const authority = membershipFromRow(row);
  assertEquals(authority.customRole, {
    id: "00000000-0000-4000-8000-0000000000ff",
    key: "reader",
    permissions: [readPermission],
  });
  assertEquals(authority.role, OrganizationRole.Guest);
});

Deno.test(
  "a custom role with an unknown key filters it from permissions",
  () => {
    const realKey = readPermission;
    const staleKey = "stale:delete";
    assert(
      !isCatalogPermissionKey(staleKey),
      "stale:delete must not be a real key",
    );
    const row: MembershipRow = {
      role: OrganizationRole.Guest,
      status: "active",
      customRoleId: "00000000-0000-4000-8000-0000000000ff",
      customRoleKey: "reader",
      customRolePermissions: [realKey, staleKey],
    };
    const authority = membershipFromRow(row);
    assertEquals(authority.customRole?.permissions, [realKey]);
  },
);

Deno.test("a row with customRoleId but no customRoleKey yields no customRole", () => {
  const row: MembershipRow = {
    role: OrganizationRole.Guest,
    status: "active",
    customRoleId: "00000000-0000-4000-8000-0000000000ff",
    customRoleKey: null,
    customRolePermissions: ["principal:read"],
  };
  const authority = membershipFromRow(row);
  assertEquals(authority.customRole, undefined);
});

Deno.test("an active membership with null role remains role-less", () => {
  const row: MembershipRow = {
    role: null,
    status: "active",
    customRoleId: null,
    customRoleKey: null,
    customRolePermissions: null,
  };
  const authority = membershipFromRow(row);
  assertEquals(authority.role, undefined);
  assertEquals(authority.customRole, undefined);
});
