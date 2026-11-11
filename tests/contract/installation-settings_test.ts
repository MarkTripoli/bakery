import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { createAuthActionRegistry } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import { OrganizationContextPolicy } from "../../packages/contracts/src/contracts.ts";
import { createNormalizedCommandMetadata } from "../../packages/contracts/src/http.ts";

Deno.test("installation catalog and shared HTTP/MCP registry require live administrator scope", () => {
  const registry = createAuthActionRegistry({
    database: {} as never,
    secret: "a".repeat(32),
  });
  const catalog = new Map(
    catalogActions.map((action) => [action.action, action]),
  );
  for (
    const name of [
      "installationSettings.get",
      "installationSettings.update",
      "installationAdministrators.list",
      "installationAdministrators.create",
      "installationAdministrators.revoke",
    ] as const
  ) {
    const action = registry.get(name);
    assertEquals(action.policy.access, "Installation administrator");
    assertEquals(
      action.policy.organizationContext,
      OrganizationContextPolicy.InstallationAdministratorScope,
    );
    assertEquals(
      catalog.get(name)?.organizationContext,
      OrganizationContextPolicy.InstallationAdministratorScope,
    );
    assertEquals(action.method, catalog.get(name)?.method);
    assert(catalog.get(name)?.mcp);
  }
  const capabilities = registry.get("installation.capabilities");
  assertEquals(capabilities.policy.access, "Public");
  assertEquals(capabilities.path, "/v1/installation/capabilities");
  assertEquals(
    registry.list().some((action) =>
      action.name === "featureAvailability.get" as string
    ),
    false,
  );
});

Deno.test("installation contract fields are described, exact and authority-free", () => {
  const schemas = generateContracts().schemas;
  for (
    const name of [
      "InstallationSettings",
      "InstallationSettingsUpdate",
      "InstallationCapabilities",
      "InstallationAdministratorCreate",
      "InstallationAdministrator",
    ] as const
  ) {
    const schema = toJsonSchema(schemas[name]) as {
      description?: string;
      properties: Record<string, { description?: string }>;
    };
    assert(schema.description?.trim());
    for (const [field, value] of Object.entries(schema.properties)) {
      assert(value.description?.trim(), `${name}.${field}`);
    }
  }
  const update = schemas.InstallationSettingsUpdate;
  assert(
    update.safeParse({
      registrationMode: "closed",
      organizationCreationPolicy: "any_user",
    }).success,
  );
  for (
    const extra of [{ bootstrap: true }, { unknownField: "secret" }, {
      updatedByPrincipalId: crypto.randomUUID(),
    }]
  ) {
    assertEquals(
      update.safeParse({
        registrationMode: "invitation",
        organizationCreationPolicy: "installation_admins",
        ...extra,
      }).success,
      false,
    );
  }
  const capabilities = toJsonSchema(schemas.InstallationCapabilities) as {
    properties: Record<string, unknown>;
  };
  assertEquals(Object.keys(capabilities.properties).sort(), [
    "organizationCreation",
    "registration",
    "ssoAvailable",
  ]);
});

Deno.test("administrator revoke metadata includes explicit DELETE CAS and stable idempotency", () => {
  const registry = createAuthActionRegistry({
    database: {} as never,
    secret: "a".repeat(32),
  });
  const id = crypto.randomUUID();
  const action = registry.get("installationAdministrators.revoke");
  const request = new Request(
    `http://test/v1/installation/administrators/${id}`,
    {
      method: "DELETE",
      headers: { "Idempotency-Key": "grant-revocation-1", "If-Match": '"v2"' },
    },
  );
  assertEquals(
    createNormalizedCommandMetadata(action, request, { id }).expectedVersion,
    2,
  );
  assertEquals(action.explicitIdempotency, "key-and-if-match");
});
