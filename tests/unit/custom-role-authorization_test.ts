import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  OrganizationRole,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  authorize,
  effectivePermissions,
} from "../../apps/server/src/modules/auth/application/authorize.ts";
import {
  catalogPermissionKeys,
  isCatalogPermissionKey,
} from "../../apps/server/src/modules/auth/application/permissions.ts";
import type { OrganizationActor } from "../../apps/server/src/modules/auth/application/authority.ts";

const holder = (
  permissions: OrganizationActor["customRole"] extends infer R
    ? R extends { permissions: infer P } ? P : never
    : never,
  extra: Partial<OrganizationActor> = {},
): OrganizationActor => ({
  subject: {
    principalId: crypto.randomUUID() as never,
    principalType: PrincipalType.Human,
    displayName: "Holder",
  },
  organizationId: crypto.randomUUID() as never,
  role: OrganizationRole.Guest,
  customRole: { id: crypto.randomUUID(), key: "reader", permissions },
  capabilities: [],
  ...extra,
});

function failure(run: () => void): string {
  const error = assertThrows(run, StandardError);
  return (error as StandardError).code;
}

Deno.test("a custom role grants exactly its permissions on top of a guest membership", () => {
  const actor = holder(["principal:read"]);
  authorize(actor, "principal:read");
  assertEquals(
    failure(() => authorize(actor, "principal:manage")),
    "AUTH_FORBIDDEN",
  );
  assertEquals(
    failure(() => authorize(actor, "accessToken:read")),
    "RESOURCE_NOT_FOUND",
  );
  assertEquals(effectivePermissions(actor), ["principal:read"]);
});

Deno.test("a plain guest still answers every denial as not found", () => {
  const guest: OrganizationActor = { ...holder([]), customRole: undefined };
  assertEquals(
    failure(() => authorize(guest, "principal:manage")),
    "RESOURCE_NOT_FOUND",
  );
});

Deno.test("token scopes still narrow a custom role", () => {
  const actor = holder(["principal:read", "principal:manage"], {
    tokenScopes: ["bakery:read"],
  });
  authorize(actor, "principal:read");
  assertEquals(
    failure(() => authorize(actor, "principal:manage")),
    "INSUFFICIENT_SCOPE",
  );
  assertEquals(effectivePermissions(actor), ["principal:read"]);
});

Deno.test("a custom role never reaches a human without a membership", () => {
  const actor = holder(["principal:read"], { role: undefined });
  assertEquals(
    failure(() => authorize(actor, "principal:read")),
    "RESOURCE_NOT_FOUND",
  );
});

Deno.test("the catalog declares the custom-role permissions and rejects unknown keys", () => {
  assert(isCatalogPermissionKey("organizationRole:manage"));
  assert(isCatalogPermissionKey("organizationRole:read"));
  assert(!isCatalogPermissionKey("organizationRole:destroy"));
  assert(!isCatalogPermissionKey(42));
  assertEquals(
    new Set(catalogPermissionKeys).size,
    catalogPermissionKeys.length,
  );
});
