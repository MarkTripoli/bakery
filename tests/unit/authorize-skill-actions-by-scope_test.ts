import { assertEquals, assertThrows } from "@std/assert";
import {
  ActionAccess,
  OrganizationRole,
} from "../../packages/contracts/src/contracts.ts";
import { authorizeOrganizationAction } from "../../apps/server/src/modules/auth/application/authorize.ts";

function actorWith(role: string) {
  return {
    subject: { principalType: "human" },
    role,
    capabilities: [],
    customRole: undefined,
    tokenScopes: undefined,
  } as never;
}

const scopedSkillActions = [
  ["skills.create", ActionAccess.DeveloperForPersonalAdminForOrganization],
  ["skills.update", ActionAccess.OwnerForPersonalAdminForOrganization],
  ["skillVersions.create", ActionAccess.OwnerForPersonalAdminForOrganization],
] as const;

Deno.test("a Developer and an Admin pass the role floor of a skill action that depends on its scope", () => {
  for (const [name, access] of scopedSkillActions) {
    const action = { name, policy: { access } } as never;
    for (const role of [OrganizationRole.Developer, OrganizationRole.Admin]) {
      authorizeOrganizationAction(action, actorWith(role));
    }
  }
});

Deno.test("a Viewer is refused a skill action that depends on its scope before any handler runs", () => {
  for (const [name, access] of scopedSkillActions) {
    const action = { name, policy: { access } } as never;
    const error = assertThrows(() =>
      authorizeOrganizationAction(action, actorWith(OrganizationRole.Viewer))
    ) as { code?: string };
    assertEquals(error.code, "AUTH_FORBIDDEN");
  }
});
