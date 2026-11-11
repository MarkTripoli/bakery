import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { descriptionDefectKind } from "../../../packages/contracts/src/description-quality.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../../packages/contracts/src/contracts.ts";
import {
  FAULTS,
  type ProblemCode,
} from "../../../packages/contracts/src/http.ts";
import {
  IntegrationsImplementedAction,
  integrationsImplementedActions,
} from "../../../packages/contracts/src/implemented-actions.ts";
import { createIntegrationsActionRegistry } from "../../../apps/server/src/modules/integrations/actions.ts";
import { GitHubAppPath } from "../../../apps/server/src/modules/integrations/github-app.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { createFakeGitHubApp } from "../fake-github-app.ts";

const ACTION = "intake.github";
const ACCESS =
  "Verified GitHub App raw-body signature; installation/resource routes to existing organization connection";

type GeneratedContracts = {
  actions: { action: string; implemented: boolean }[];
  implementedActions: string[];
  schemas: Record<string, {
    properties?: Record<string, { description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
    description?: string;
  }>;
};

async function generatedContracts(): Promise<GeneratedContracts> {
  return JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  );
}

function registry() {
  return createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
}

Deno.test("issue 71 contract: intake.github is implemented in the registry, the implemented list and the generated contracts", async () => {
  assertEquals(IntegrationsImplementedAction.IntakeGithub, ACTION);
  assert(integrationsImplementedActions.includes(ACTION));
  const action = registry().get(ACTION);
  assertEquals(action.method, "POST");
  assertEquals(action.path, GitHubAppPath.Webhook);
  assertEquals(action.path, "/v1/webhooks/github");
  assert(action.input === contractSchemas.GitHubWebhook);
  assert(action.output === contractSchemas.WebhookReceipt);
  assertEquals(action.policy.access, ACCESS);

  const generated = await generatedContracts();
  const entries = generated.actions.filter((entry) => entry.action === ACTION);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].implemented, true);
  assert(generated.implementedActions.includes(ACTION));
  assertFalse(
    generated.actions.some((entry) =>
      entry.action === "intake.external" && entry.implemented
    ),
    "the generic external webhook stays unimplemented",
  );
});

Deno.test("issue 71 contract: the action has no organization context, no session and no client idempotency key, only the verified-delivery guard", () => {
  const action = registry().get(ACTION);
  assertEquals(action.policy.organizationContext, undefined);
  assertEquals(action.policy.sessionOnly, undefined);
  assertEquals(action.policy.type, "command");
  assertEquals(action.policy.authorize !== undefined, true);
  assertEquals(action.explicitIdempotency, undefined);
  assertEquals(action.naturalIdempotency, undefined);
  assertEquals(action.successStatus, 202);
  const entry = catalogActions.find(({ action: name }) => name === ACTION)!;
  assertEquals(entry.access, ACCESS);
  assertEquals(entry.permission, null);
  assertFalse(
    "idempotencyKeyOptional" in entry && entry.idempotencyKeyOptional === true,
    "the catalog does not ask GitHub for an Idempotency-Key",
  );
  assert(
    /no client Idempotency-Key/.test(String(entry.idempotency)),
    "the catalog says no Idempotency-Key is expected",
  );
  assertEquals(entry.input, "GitHubWebhook");
  assertEquals(entry.output, "WebhookReceipt");
  assertEquals(entry.event, "intake.received");
});

Deno.test("issue 71 contract: the catalog lists the failures the receiver answers with their statuses", () => {
  const entry = catalogActions.find(({ action }) => action === ACTION)!;
  const expected: Record<string, number> = {
    AUTH_INVALID: 401,
    MALFORMED_REQUEST: 400,
    BODY_TOO_LARGE: 413,
    IDEMPOTENCY_PAYLOAD_MISMATCH: 422,
    DEPENDENCY_UNAVAILABLE: 503,
  };
  assertEquals([...entry.errors].sort(), Object.keys(expected).sort());
  for (const [code, status] of Object.entries(expected)) {
    assertEquals(FAULTS[code as ProblemCode][0], status, code);
  }
  // The receiver also answers these; each is a registered problem code.
  assertEquals(FAULTS.UNSUPPORTED_MEDIA_TYPE[0], 415);
  assertEquals(FAULTS.MALFORMED_JSON[0], 400);
  assertEquals(FAULTS.DEPENDENCY_TIMEOUT[0], 504);
  assertEquals(
    FAULTS.AUTH_INVALID[1],
    false,
    "a bad signature is not retryable",
  );
  assertEquals(FAULTS.DEPENDENCY_UNAVAILABLE[1], true, "a commit failure is");
});

Deno.test("issue 71 contract: WebhookReceipt is the four-field acknowledgement with described fields", async () => {
  const receipt = {
    eventId: crypto.randomUUID(),
    status: "accepted",
    taskId: null,
    receivedAt: "2026-10-31T10:00:00.123456Z",
  };
  for (const status of ["accepted", "duplicate", "ignored"]) {
    assertEquals(
      contractSchemas.WebhookReceipt.parse({ ...receipt, status }).status,
      status,
    );
  }
  assertThrows(() =>
    contractSchemas.WebhookReceipt.parse({ ...receipt, status: "rejected" })
  );
  assertThrows(() =>
    contractSchemas.WebhookReceipt.parse({ ...receipt, eventId: "not-a-uuid" })
  );
  assertThrows(() =>
    contractSchemas.WebhookReceipt.parse({ ...receipt, extra: "field" })
  );
  assertThrows(() => {
    const { taskId: _taskId, ...missing } = receipt;
    contractSchemas.WebhookReceipt.parse(missing);
  });
  assertEquals(
    contractSchemas.WebhookReceipt.parse({ ...receipt, taskId: null }).taskId,
    null,
  );

  const schemas = (await generatedContracts()).schemas;
  for (const name of ["WebhookReceipt", "GitHubWebhook"]) {
    const schema = schemas[name];
    assertEquals(descriptionDefectKind(schema.description, name), undefined);
    assertEquals(schema.additionalProperties, false, `${name} is closed`);
    for (const [field, child] of Object.entries(schema.properties ?? {})) {
      assertEquals(
        descriptionDefectKind(child.description, `${name}.${field}`),
        undefined,
        `${name}.${field}`,
      );
    }
  }
  assertEquals(
    Object.keys(schemas.WebhookReceipt.properties ?? {}).sort(),
    ["eventId", "receivedAt", "status", "taskId"],
  );
  assertEquals(
    [...(schemas.WebhookReceipt.required ?? [])].sort(),
    ["eventId", "receivedAt", "status", "taskId"],
  );
});

Deno.test("issue 71 contract: the verified-delivery envelope carries the delivery id, the event and a bounded payload", () => {
  const envelope = {
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    eventType: "issues",
    payload: { action: "opened" },
  };
  assertEquals(contractSchemas.GitHubWebhook.parse(envelope), envelope);
  assertThrows(() =>
    contractSchemas.GitHubWebhook.parse({
      ...envelope,
      deliveryId: "x".repeat(256),
    })
  );
  assertThrows(() =>
    contractSchemas.GitHubWebhook.parse({
      ...envelope,
      eventType: "e".repeat(101),
    })
  );
  assertThrows(() =>
    contractSchemas.GitHubWebhook.parse({
      ...envelope,
      payload: { text: "x".repeat(262_145) },
    })
  );
  assertThrows(() =>
    contractSchemas.GitHubWebhook.parse({ ...envelope, installationId: 1 })
  );
});
