import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import { INNGEST_EVENT_DEFINITIONS } from "../../packages/contracts/src/events.ts";
import { createIntegrationsActionRegistry } from "../../apps/server/src/modules/integrations/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { createFakeGitHubApp } from "../helpers/fake-github-app.ts";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import generated from "../../packages/contracts/generated/contracts.json" with {
  type: "json",
};

function registry() {
  return createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
}

Deno.test("AC4 contract: integrationDiscoveries.create is an Admin POST needing only Idempotency-Key and answering 202 with a queued receipt", () => {
  const action = registry().get("integrationDiscoveries.create");
  assertEquals(action.method, "POST");
  assertEquals(action.path, "/v1/integration-connections/:id/discoveries");
  assertEquals(action.policy.type, "command");
  assertEquals(action.policy.access, "Admin");
  assertEquals(
    action.policy.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(action.explicitIdempotency, "key");
  assertEquals(action.successStatus, 202);
  assertEquals(action.input, contractSchemas.IntegrationDiscoveryCreate);
  assertEquals(action.output, contractSchemas.IntegrationDiscoveryReceipt);
  const entry = catalogActions.find((candidate) =>
    candidate.action === "integrationDiscoveries.create"
  )!;
  assertEquals(entry.path, "/v1/integration-connections/{id}/discoveries");
  assertEquals(entry.event, "integration.discovery_requested");
  const receipt = contractSchemas.IntegrationDiscoveryReceipt;
  const valid = {
    discoveryId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    status: "queued",
  };
  assert(receipt.safeParse(valid).success);
  assert(!receipt.safeParse({ ...valid, status: "running" }).success);
  assert(!receipt.safeParse({ ...valid, token: "ghs_x" }).success);
  assert(
    !contractSchemas.IntegrationDiscoveryCreate.safeParse({ page: 2 })
      .success,
    "callers cannot steer the provider scan",
  );
});

Deno.test("AC4 contract: integration.discovery_requested reaches Inngest under the transport trigger name", () => {
  const definition =
    INNGEST_EVENT_DEFINITIONS["integration.discovery_requested"];
  const event = (transport.events as Record<
    string,
    { inngestTrigger: string | null; payloadFields: Record<string, string> }
  >)["integration.discovery_requested"];
  assertEquals(definition.name, event.inngestTrigger);
  assertEquals(definition.name, "bakery/integration.discovery.requested.v1");
  assertEquals(Object.keys(event.payloadFields).sort(), [
    "resourceId",
    "resourceVersion",
  ]);
  assert(
    definition.payload.safeParse({
      resourceId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      resourceVersion: 1,
    }).success,
  );
});

Deno.test("AC5 contract: installation reads are installation-administrator queries whose projection exposes only identity, lifecycle and counts", () => {
  const actions = registry();
  for (
    const [name, path] of [
      ["integrationInstallations.list", "/v1/integration-installations"],
      ["integrationInstallations.get", "/v1/integration-installations/:id"],
    ]
  ) {
    const action = actions.get(name);
    assertEquals(action.method, "GET");
    assertEquals(action.path, path);
    assertEquals(action.policy.type, "query");
    assertEquals(action.policy.access, "Installation administrator");
    assertEquals(
      action.policy.organizationContext,
      "installation_administrator_scope",
    );
  }
  const schema = (generated.schemas as unknown as Record<
    string,
    { properties: Record<string, unknown>; additionalProperties: unknown }
  >).IntegrationInstallation;
  assertEquals(schema.additionalProperties, false);
  assertEquals(Object.keys(schema.properties).sort(), [
    "authorizationRevision",
    "connectionCount",
    "createdAt",
    "enabledConnectionCount",
    "externalAccountId",
    "externalAuthorizationId",
    "grantedPermissions",
    "id",
    "lastCheckedAt",
    "organizationCount",
    "providerId",
    "providerRegistrationId",
    "status",
    "updatedAt",
    "version",
  ]);
});
