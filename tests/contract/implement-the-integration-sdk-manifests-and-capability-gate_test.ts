import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  ActionAccess,
  assertDescribedJsonSchema,
  assertDescribedSchema,
  catalogActions,
} from "../../packages/contracts/src/contracts.ts";
import * as integrations from "../../packages/contracts/src/integrations.ts";
import {
  ActionReferenceSchema,
  formatActionReference,
  INTEGRATION_SCOPE_OPERATIONS,
  INTEGRATION_SCOPES,
  IntegrationScopeSchema,
  parseActionReference,
  ProviderPermissionLevelSchema,
  ResourceKindIdSchema,
} from "../../packages/contracts/src/integrations.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  activateDeployedIntegrations,
  computeConnectionCapabilities,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";

Deno.test("scope operation map keys equal the scope enum", () => {
  assertEquals(
    Object.keys(INTEGRATION_SCOPE_OPERATIONS).sort(),
    [...IntegrationScopeSchema.options].sort(),
  );
  assertStrictEquals(INTEGRATION_SCOPES.length, 12);
});

Deno.test("every mapped operation is a catalog action", () => {
  const known = new Set<string>(catalogActions.map((a) => a.action));
  for (const [scope, ops] of Object.entries(INTEGRATION_SCOPE_OPERATIONS)) {
    for (const op of ops) {
      assertStrictEquals(known.has(op), true, `${scope} -> ${op}`);
    }
  }
  assertEquals(INTEGRATION_SCOPE_OPERATIONS["tickets:ingest"], []);
  assertEquals(INTEGRATION_SCOPE_OPERATIONS["events:subscribe"], []);
});

Deno.test("integrationConnections.invoke needs Developer plus action grant", () => {
  const invoke = catalogActions.find((a) =>
    a.action === "integrationConnections.invoke"
  );
  assertStrictEquals(invoke?.access, ActionAccess.DeveloperAndActionGrant);
  assertStrictEquals(invoke?.permission, "integrationConnection:invoke");
});

Deno.test("exported schemas are described in zod and JSON schema", () => {
  const schemas: Record<string, z.ZodType> = {
    IntegrationScopeSchema,
    ActionReferenceSchema,
    ResourceKindIdSchema,
    ProviderPermissionLevelSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    assertDescribedSchema(schema as never, name);
    assertDescribedJsonSchema(z.toJSONSchema(schema), name);
  }
  for (const name of Object.keys(integrations)) {
    if (name.endsWith("Schema")) {
      assertStrictEquals(name in schemas, true, `${name} not covered`);
    }
  }
});

Deno.test("action references round trip and reject loose forms", () => {
  const ref = { id: "github.issue.comment.create", version: 1 };
  assertEquals(formatActionReference(ref), "github.issue.comment.create@1");
  assertEquals(parseActionReference("github.issue.comment.create@1"), ref);
  for (
    const bad of [
      "*",
      "github.*",
      "github.issue.comment.create",
      "github.issue.comment.create@latest",
      "github.issue.comment.create@0",
      "github.issue.comment.create@1.0",
      "@1",
      "github.issue.comment.create@01",
    ]
  ) {
    assertStrictEquals(parseActionReference(bad), null, bad);
  }
  assertThrows(() => formatActionReference({ id: "github.*", version: 1 }));
  assertThrows(() => formatActionReference({ id: "a.b", version: 0 }));
});

Deno.test("resource kind and permission level reject malformed values", () => {
  assertStrictEquals(
    ResourceKindIdSchema.safeParse("github.repository").success,
    true,
  );
  for (const bad of ["github", "github.*", "GitHub.repo", "a.b.c"]) {
    assertStrictEquals(ResourceKindIdSchema.safeParse(bad).success, false, bad);
  }
  assertStrictEquals(
    ProviderPermissionLevelSchema.safeParse("admin").success,
    false,
  );
});

Deno.test("gate capability entries parse with the transport IntegrationCapability contract", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const provider = registry.integrations[0]!;
  const org = "00000000-0000-4000-8000-000000000001";
  const actor = "00000000-0000-4000-8000-000000000002";
  const connection = "00000000-0000-4000-8000-000000000003";
  const resource = "00000000-0000-4000-8000-000000000004";
  const report = await computeConnectionCapabilities(registry, {
    load: () =>
      Promise.resolve({
        organizationId: org,
        actor: {
          principalId: actor,
          subjectType: "principal" as const,
          active: true,
          permissions: [],
        },
        install: {
          id: "i",
          providerId: provider.providerId,
          manifestDigest: provider.manifestDigest,
          enabled: true,
          approvedScopes: [],
        },
        connection: {
          id: connection,
          installId: "i",
          state: "active" as const,
          providerPermissions: {},
        },
        resource: {
          id: resource,
          kind: "github.repository",
          selected: true,
          available: true,
          binding: {},
        },
        grants: [],
        policyRevision: 1,
      }),
  }, {
    organizationId: org,
    actorRef: actor,
    connectionId: connection,
    resourceId: resource,
  });
  assertStrictEquals(report.actions.length, 1);
  for (const entry of report.actions) {
    const parsed = contractSchemas.IntegrationCapability.safeParse(entry);
    assertStrictEquals(parsed.success, true);
  }
  assertEquals(
    report.actions[0]!.unavailableReason,
    "provider_permission_missing",
  );
});

Deno.test("github integration schemas are described in zod and JSON schema", () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const provider = registry.integrations[0]!;
  for (const action of provider.actions) {
    for (
      const [label, schema] of [
        ["input", action.handler.input],
        ["output", action.handler.output],
      ] as const
    ) {
      assertDescribedJsonSchema(
        z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any" }),
        `${action.id}.${label}`,
      );
    }
  }
  for (const request of provider.definition.manifest.requests) {
    for (const schema of [request.input, request.body, request.response]) {
      if (!schema) continue;
      assertDescribedJsonSchema(
        z.toJSONSchema(schema, { unrepresentable: "any" }),
        request.id,
      );
    }
  }
});
