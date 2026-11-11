import { assertEquals } from "@std/assert";
import {
  AgentVersionCreateConfigSchema,
  catalogActions,
  contractSchemas,
  workerActionCapabilities,
  workerActionCapabilityNames,
} from "../../packages/contracts/src/contracts.ts";
import {
  AgentImplementedAction,
  agentImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  type AgentsActionHandlers,
  createAgentsActionRegistry,
} from "../../apps/server/src/modules/agents/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import transport from "../../packages/contracts/generated/transport-schemas.ts";

const expectedActions = [
  "agentVersions.create",
  "agentVersions.list",
  "agents.activateVersion",
  "agents.create",
  "agents.get",
  "agents.list",
  "agents.update",
];
const expectedCapabilities = [
  "browser",
  "git",
  "mcp.host_local",
  "model",
  "paper",
  "reviewer",
  "secret.identity",
  "shell",
  "web",
];

Deno.test("agent registry implements exactly the seven catalog management actions", () => {
  const unavailable = () => Promise.reject(new Error("not called"));
  const registry = createAgentsActionRegistry(
    {} as PgDatabase,
    {
      listAgents: unavailable,
      getAgent: unavailable,
      createAgent: unavailable,
      updateAgent: unavailable,
      activateVersion: unavailable,
      createVersion: unavailable,
      listVersions: unavailable,
    } as unknown as AgentsActionHandlers,
  );
  assertEquals(
    registry.list().map(({ name }) => name).sort(),
    expectedActions,
  );
  assertEquals([...agentImplementedActions].sort(), expectedActions);
  assertEquals(Object.values(AgentImplementedAction).sort(), expectedActions);
  assertEquals(
    catalogActions.filter(({ action }) => expectedActions.includes(action))
      .map(({ organizationContext }) => organizationContext),
    Array(7).fill("required_authenticated_context"),
  );
});

Deno.test("agent capabilities are the unique generated worker-action capability union", () => {
  const generated = [
    ...new Set(
      Object.keys(transport.workerActions).flatMap((action) =>
        workerActionCapabilities(action)
      ),
    ),
  ].sort();
  assertEquals(workerActionCapabilityNames, expectedCapabilities);
  assertEquals(generated, expectedCapabilities);
  assertEquals(
    new Set(workerActionCapabilityNames).size,
    expectedCapabilities.length,
  );
});

Deno.test("agent config accepts every declared capability and rejects names outside the capability vocabulary", () => {
  assertEquals(
    AgentVersionCreateConfigSchema.safeParse({
      harness: "pi",
      allowedCapabilities: expectedCapabilities,
    }).success,
    true,
  );
  for (
    const invalid of [
      "harness.implement",
      "tasks.list",
      "agents.create",
      "arbitrary",
    ]
  ) {
    assertEquals(
      AgentVersionCreateConfigSchema.safeParse({
        harness: "pi",
        allowedCapabilities: [invalid],
      }).success,
      false,
      `${invalid} must not be accepted as an execution capability`,
    );
  }
  assertEquals(
    AgentVersionCreateConfigSchema.safeParse({
      harness: "pi",
      allowedCapabilities: ["git", "git"],
    }).success,
    false,
  );
});

Deno.test("agent caller contracts preserve revision, digest, strict config, and nullable description", () => {
  const digest = "a".repeat(64);
  assertEquals(
    contractSchemas.AgentVersionCreate.safeParse({
      revision: 7,
      config: { harness: "codex", allowedCapabilities: ["shell"] },
      digest,
    }).success,
    true,
  );
  assertEquals(
    contractSchemas.AgentVersionCreate.safeParse({
      revision: 7,
      config: { harness: "codex", unknown: true },
      digest,
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.DefinitionUpdate.safeParse({ description: null }).success,
    true,
  );
});

Deno.test("agent activation is an Admin command that needs a key, If-Match and a version id", () => {
  const entry = catalogActions.find(({ action }) =>
    action === "agents.activateVersion"
  );
  assertEquals(entry?.method, "POST");
  assertEquals(entry?.path, "/v1/agents/{id}/activations");
  assertEquals(entry?.access, "Admin");
  assertEquals(entry?.permission, "agent:manage");
  assertEquals(entry?.event, "agents.updated");
  assertEquals(entry?.idempotency, "Idempotency-Key and If-Match required");
  const version = crypto.randomUUID();
  assertEquals(
    contractSchemas.AgentVersionActivate.safeParse({ versionId: version })
      .success,
    true,
  );
  for (
    const invalid of [
      {},
      { versionId: "not-a-uuid" },
      { versionId: version, activeVersionId: version },
    ]
  ) {
    assertEquals(
      contractSchemas.AgentVersionActivate.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});
