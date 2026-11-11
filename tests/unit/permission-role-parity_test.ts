import { assertEquals } from "@std/assert";
import {
  type CatalogActionName,
  catalogActions,
  OrganizationRole,
} from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  organizationMinimumRole,
  roleSatisfies,
} from "../../apps/server/src/modules/auth/application/authority.ts";
import {
  permissionMinimumRole,
  roleHasPermission,
  type SystemRole,
} from "../../apps/server/src/modules/auth/application/permissions.ts";

Deno.test("permission role sets preserve implemented admin and developer decisions", () => {
  const implemented = new Set<CatalogActionName>(implementedActions);
  const roles = [
    { organizationRole: OrganizationRole.Admin, systemRole: "admin" },
    {
      organizationRole: OrganizationRole.Developer,
      systemRole: "developer",
    },
  ] as const satisfies readonly {
    organizationRole: typeof OrganizationRole[keyof typeof OrganizationRole];
    systemRole: SystemRole;
  }[];
  let decisions = 0;

  for (const action of catalogActions) {
    if (!implemented.has(action.action)) continue;
    const minimum = organizationMinimumRole(action.access);
    for (const role of roles) {
      const legacyDecision = minimum !== undefined &&
        roleSatisfies(role.organizationRole, minimum);
      const permissionDecision = action.permission !== null &&
        roleHasPermission(role.systemRole, action.permission);
      assertEquals(
        permissionDecision,
        legacyDecision,
        `${action.action}:${role.systemRole}`,
      );
      decisions += 1;
    }
  }

  assertEquals(decisions, implementedActions.length * roles.length);
});

Deno.test("attempt-level worker control stays admin-only", () => {
  assertEquals(permissionMinimumRole("worker:manage"), OrganizationRole.Admin);
  assertEquals(roleHasPermission("admin", "worker:manage"), true);
  for (const role of ["developer", "viewer", "guest"] as const) {
    assertEquals(roleHasPermission(role, "worker:manage"), false, role);
  }
});
