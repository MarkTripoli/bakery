import { assert, assertEquals } from "@std/assert";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import { createAuthActionRegistry } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";

/** Permission resource stems that name who-has-access resources. */
const ACCESS_STEMS = [
  "member",
  "invitation",
  "token",
  "principal",
  "grant",
  "binding",
  "role",
  "sso",
  "scim",
] as const;
/** Resources that contain a stem but are not access control. */
const NOT_ACCESS = new Set(["projectrole"]);

type Entry = { action: string; method: string; permission: string | null };

function isAccessResource(permission: string): boolean {
  const resource = permission.split(":")[0].toLowerCase();
  return !NOT_ACCESS.has(resource) &&
    ACCESS_STEMS.some((stem) => resource.includes(stem));
}

/** Registered access-management mutations that lack the sessionOnly policy flag. */
export function missingSessionOnly(
  catalog: readonly Entry[],
  policyFlag: (action: string) => boolean | undefined,
): string[] {
  return catalog
    .filter((entry) =>
      entry.method.toUpperCase() !== "GET" && entry.permission !== null &&
      isAccessResource(entry.permission) &&
      policyFlag(entry.action) === false
    )
    .map((entry) => entry.action)
    .sort();
}

Deno.test("every registered access-management mutation is sessionOnly", () => {
  const registry = createAuthActionRegistry({
    database: {} as never,
    secret: "a".repeat(32),
  });
  const flags = new Map(
    registry.list().map((
      action,
    ) => [action.name as string, action.policy.sessionOnly === true]),
  );
  const missing = missingSessionOnly(catalogActions, (a) => flags.get(a));
  assertEquals(
    missing,
    [],
    `add sessionOnly: true to these action policies: ${missing.join(", ")}`,
  );
  assert(flags.get("organizationInvitations.create") === true);
  assert(flags.get("accessTokens.create") === true);
});

Deno.test("the rail reports an access-management mutation without the flag", () => {
  const catalog = [
    { action: "tokens.mint", method: "POST", permission: "accessToken:manage" },
    { action: "tokens.list", method: "GET", permission: "accessToken:read" },
    { action: "roles.edit", method: "PATCH", permission: "projectRole:manage" },
    {
      action: "orgs.update",
      method: "PATCH",
      permission: "organization:manage",
    },
  ];
  assertEquals(missingSessionOnly(catalog, () => false), ["tokens.mint"]);
  assertEquals(missingSessionOnly(catalog, () => true), []);
  // An action no registry knows is not this rail's concern.
  assertEquals(missingSessionOnly(catalog, () => undefined), []);
});
