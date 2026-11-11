import {
  type CatalogActionName,
  contractSchemas,
  generateContracts,
} from "../../packages/contracts/src/contracts.ts";
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { createExecutionRunControlApp } from "../../apps/server/src/modules/execution/control.ts";
import {
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import { englishCatalog } from "../../packages/i18n/src/index.ts";
import transportSchemas from "../../packages/contracts/generated/transport-schemas.ts";

function app() {
  const registry = new ActionRegistry().register({
    name: "health.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/health",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: { type: "query", access: "Public" },
    handler: () => ({ leaked: "never" }) as never,
  });
  registry.register({
    name: "health.write" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/health",
    input: contractSchemas.TaskCreate,
    output: contractSchemas.Task,
    policy: { type: "command", access: "Public" },
    handler: () => ({}) as never,
  });
  return createApiRouter({
    registry,
    maxBodyBytes: 8,
    publicBaseUrl: "https://bakery.example",
  });
}
Deno.test("HTTP boundary rejects method, media, malformed and oversized requests", async () => {
  const server = app();
  for (
    const request of [
      new Request("http://test/v1/health", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "text/plain" },
      }),
      new Request("http://test/v1/health", {
        method: "GET",
        headers: { "content-length": "99" },
      }),
    ]
  ) {
    const response = await server.fetch(request);
    assertEquals(
      response.headers.get("content-type"),
      "application/problem+json",
    );
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  }
  const malformed = await server.fetch(
    new Request("http://test/v1/health", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals((await malformed.json()).code, "MALFORMED_JSON");
});
Deno.test("HTTP accepts documented JSON media types with parameters", async () => {
  for (
    const contentType of [
      "APPLICATION/JSON; charset=utf-8",
      "application/merge-patch+json",
      "application/vnd.bakery+json; charset=utf-8",
    ]
  ) {
    const response = await app().fetch(
      new Request("http://test/v1/health", {
        method: "POST",
        body: "{}",
        headers: { "content-type": contentType },
      }),
    );
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "MALFORMED_REQUEST");
  }
});
Deno.test("HTTP rejects malformed structured JSON media types", async () => {
  for (const contentType of ["+json", "garbage+json", "application/+json"]) {
    const response = await app().fetch(
      new Request("http://test/v1/health", {
        method: "POST",
        body: "{}",
        headers: { "content-type": contentType },
      }),
    );
    assertEquals(response.status, 415);
    assertEquals((await response.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  }
});
Deno.test("invalid action output becomes a safe internal problem", async () => {
  const response = await app().fetch(new Request("http://test/v1/health"));
  const body = await response.json();
  assertEquals(response.status, 500);
  assertEquals(body.code, "INTERNAL");
  assertEquals(body.detail, englishCatalog["problems.INTERNAL.description"]);
});

Deno.test("query numbers are coerced and path params stay out of strict bodies", async () => {
  let seen: unknown;
  const registry = new ActionRegistry().register({
    name: "tasks.update-test" as CatalogActionName,
    method: HttpMethod.Patch,
    path: "/v1/tasks/:id",
    input: contractSchemas.TaskUpdate,
    output: contractSchemas.NoContent,
    policy: { type: "command", access: "Public" },
    handler: (context, input) => {
      seen = [context.params.id, input];
      return null;
    },
  });
  registry.register({
    name: "health.page-test" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/page-test",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: (_context, input) => {
      seen = input;
      return null;
    },
  });
  const server = createApiRouter({ registry });
  await server.fetch(
    new Request("http://test/v1/tasks/not-an-id", {
      method: "PATCH",
      body: JSON.stringify({
        priority: 3,
        id: "00000000-0000-4000-8000-000000000000",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(seen, undefined);
  const page = await server.fetch(
    new Request("http://test/v1/page-test?limit=7"),
  );
  assertEquals(page.status, 204);
  assertEquals(seen, { limit: 7 });
});

Deno.test("request and trace IDs are reused by action and problem response", async () => {
  const registry = new ActionRegistry().register({
    name: "health.fail" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/fail",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: () => {
      throw new Error("secret");
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/fail", {
      headers: {
        "x-request-id": "req-fixed",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    }),
  );
  const body = await response.json();
  assertEquals(body.requestId, "req-fixed");
  assertEquals(body.traceId, "0123456789abcdef0123456789abcdef");
});

Deno.test("HTTP context adapter forwards the resolved principal", async () => {
  const principal = { principalId: "principal-1" };
  let seen: unknown;
  const registry = new ActionRegistry().register({
    name: "identity.context-test" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/context-test",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: (context) => {
      seen = context.principal;
      return null;
    },
  });
  const response = await createApiRouter({
    registry,
    createContext: () => ({ principal }),
  }).fetch(new Request("http://test/v1/context-test"));
  assertEquals(response.status, 204);
  assertEquals(seen, principal);
});

Deno.test("path-only DELETE is bodyless and NoContent is an empty 204", async () => {
  let seen = "";
  const registry = new ActionRegistry().register({
    name: "health.delete-test" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/health/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: { type: "command", access: "Public" },
    handler: (context) => {
      seen = context.params.id;
      return null;
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/health/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
      headers: { "idempotency-key": "delete-1" },
    }),
  );
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
  assertEquals(seen, "00000000-0000-4000-8000-000000000001");
});

Deno.test("unknown URLs return resource not found", async () => {
  const response = await app().fetch(new Request("http://test/v1/missing"));
  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, "RESOURCE_NOT_FOUND");
});

Deno.test("GET allows implicit HEAD and DELETE with a body requires JSON", async () => {
  const registry = new ActionRegistry().register({
    name: "health.get-test" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/allow-test",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: () => null,
  });
  registry.register({
    name: "health.delete-test" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/allow-test",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: { type: "command", access: "Public" },
    handler: () => null,
  });
  const server = createApiRouter({ registry });
  const method = await server.fetch(
    new Request("http://test/v1/allow-test", {
      method: "OPTIONS",
    }),
  );
  assertEquals(method.status, 405);
  assertEquals(method.headers.get("allow"), "GET, HEAD, DELETE");
  const deleteWithBody = await server.fetch(
    new Request(
      "http://test/v1/allow-test",
      {
        method: "DELETE",
        body: "{}",
        headers: { "content-type": "text/plain" },
      },
    ),
  );
  assertEquals(deleteWithBody.status, 415);
});

Deno.test("Deno.serve preserves an empty DELETE body as bodyless", async () => {
  const registry = new ActionRegistry().register({
    name: "health.delete-live" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/live-delete/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: { type: "command", access: "Public" },
    handler: () => null,
  });
  const app = createApiRouter({ registry });
  const server = Deno.serve({ port: 0 }, app.fetch);
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.addr.port}/v1/live-delete/00000000-0000-4000-8000-000000000001`,
      { method: "DELETE", headers: { "idempotency-key": "delete-live" } },
    );
    assertEquals(response.status, 204);
    assertEquals(await response.text(), "");
  } finally {
    await server.shutdown();
  }
});

Deno.test("all path-only mutation methods validate supplied bodies", async () => {
  const calls: string[] = [];
  const registry = new ActionRegistry();
  for (const method of ["POST", "PATCH", "PUT"] as const) {
    registry.register({
      name: `path-only.${method.toLowerCase()}` as CatalogActionName,
      method,
      path: `/v1/path-only/${method.toLowerCase()}/:id`,
      input: contractSchemas.IdPath,
      output: contractSchemas.NoContent,
      policy: { type: "command", access: "Public" },
      handler: () => {
        calls.push(method);
        return null;
      },
    });
  }
  const server = createApiRouter({ registry, maxBodyBytes: 128 });
  const limited = createApiRouter({ registry, maxBodyBytes: 8 });
  for (const method of ["POST", "PATCH", "PUT"] as const) {
    const base =
      `http://test/v1/path-only/${method.toLowerCase()}/00000000-0000-4000-8000-000000000001`;
    const malformed = await server.fetch(
      new Request(base, {
        method,
        body: "{",
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(malformed.status, 400);
    const conflicting = await server.fetch(
      new Request(base, {
        method,
        body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000002" }),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(conflicting.status, 400);
    const oversized = await limited.fetch(
      new Request(base, {
        method,
        body: "x".repeat(100),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(oversized.status, 413);
    assertEquals((await oversized.json()).limit, 8);
  }
  assertEquals(calls, []);
});

Deno.test("path-only opaque identifiers preserve UUID-shaped casing", async () => {
  const opaqueId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  let seen: string | undefined;
  const registry = new ActionRegistry().register({
    name: "path-only.opaque" as CatalogActionName,
    method: HttpMethod.Put,
    path: "/v1/path-only/opaque/:key",
    input: z.object({
      key: z.string().describe("Opaque provider-owned route key."),
    }).describe("Opaque path-only command input."),
    output: contractSchemas.NoContent,
    policy: { type: "command", access: "Public" },
    handler: (_context, input) => {
      seen = input.key;
      return null;
    },
  });
  const server = createApiRouter({ registry });
  const response = await server.fetch(
    new Request(`http://test/v1/path-only/opaque/${opaqueId}`, {
      method: "PUT",
      body: JSON.stringify({ key: opaqueId }),
      headers: { "content-type": "application/json" },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(seen, opaqueId);
});

Deno.test("every task action has one fail-closed HTTP case", async () => {
  const calls: string[] = [];
  const handlers = {
    list: () => {
      calls.push("tasks.list");
      throw new Error("TASK_HANDLER_INVOKED");
    },
    get: () => {
      calls.push("tasks.get");
      throw new Error("TASK_HANDLER_INVOKED");
    },
    create: () => {
      calls.push("tasks.create");
      throw new Error("TASK_HANDLER_INVOKED");
    },
    update: () => {
      calls.push("tasks.update");
      throw new Error("TASK_HANDLER_INVOKED");
    },
    createDependency: () => null as never,
    deleteDependency: () => null as never,
    runsCreate: () => null as never,
    runsList: () => null as never,
    runsGet: () => null as never,
    runStepsList: () => null as never,
    workflowPresetsList: () => null as never,
    usageList: () => {
      calls.push("usage.list");
      throw new Error("TASK_HANDLER_INVOKED");
    },
    sync: () => {
      calls.push("sync.snapshot");
      throw new Error("TASK_HANDLER_INVOKED");
    },
  };
  const registry = createTaskActionRegistry(handlers);
  const id = "00000000-0000-4000-8000-000000000001";
  const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
  const httpCases = new Map<string, Request>([
    ["tasks.list", new Request("http://test/v1/tasks")],
    ["tasks.get", new Request(`http://test/v1/tasks/${id}`)],
    ["usage.list", new Request("http://test/v1/usage")],
    [
      "sync.snapshot",
      new Request(`http://test/v1/sync?scopeType=task&scopeId=${id}`),
    ],
    [
      "tasks.create",
      new Request("http://test/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          applicationId: id,
          taskType: "feature",
          title: "Contract test task",
        }),
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "tasks.update",
      new Request(`http://test/v1/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated contract test task" }),
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "taskDependencies.create",
      new Request(`http://test/v1/tasks/${id}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnTaskId: id, condition: "completed" }),
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "taskDependencies.delete",
      new Request(`http://test/v1/tasks/${id}/dependencies/${id}`, {
        method: "DELETE",
      }),
    ],
    [
      "runs.create",
      new Request(`http://test/v1/tasks/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: id,
          executionMode: "cloud_only",
        }),
        headers: { "content-type": "application/json" },
      }),
    ],
    ["runs.list", new Request(`http://test/v1/tasks/${id}/runs`)],
    ["runs.get", new Request(`http://test/v1/runs/${id}`)],
    ["runSteps.list", new Request(`http://test/v1/runs/${id}/steps`)],
    [
      "workflowPresets.list",
      new Request(`http://test/v1/workflow-presets?repositoryId=${id}`),
    ],
  ]);
  assertEquals(
    [...httpCases.keys()].sort(),
    registry.list().map(({ name }) => name).sort(),
  );

  const app = createApiRouter({ registry });
  for (const [name, request] of httpCases) {
    request.headers.set("x-request-id", `request-${name}`);
    request.headers.set("traceparent", traceparent);
    const response = await app.fetch(request);
    const body = await response.json();
    assertEquals(response.status, 403);
    assertEquals(
      response.headers.get("content-type"),
      "application/problem+json",
    );
    assertEquals(body.code, "AUTH_FORBIDDEN");
    assertEquals(
      body.detail,
      englishCatalog["problems.AUTH_FORBIDDEN.description"],
    );
    assertEquals(body.requestId, `request-${name}`);
    assertEquals(body.traceId, "0123456789abcdef0123456789abcdef");
    assertEquals(JSON.stringify(body).includes("TASK_HANDLER_INVOKED"), false);
  }
  assertEquals(calls, []);
});

Deno.test("RunControlCapability accepts only canonical control actions", () => {
  const valid = ["pause", "resume", "cancel", "interrupt"] as const;
  for (const action of valid) {
    assertEquals(
      contractSchemas.RunControlCapability.safeParse({
        action,
        canRequest: true,
        reason: "allowed",
      }).success,
      true,
    );
  }
  assertEquals(
    contractSchemas.RunControlCapability.safeParse({
      action: "harness.implement",
      canRequest: true,
      reason: "allowed",
    }).success,
    false,
  );
  const generated = generateContracts();
  const schemas = (generated.openapi.components as {
    schemas: Record<
      string,
      { properties?: Record<string, { enum?: string[] }> }
    >;
  }).schemas;
  assertEquals(schemas.RunControlCapability.properties?.action?.enum, [
    "pause",
    "resume",
    "cancel",
    "interrupt",
  ]);
  const workerActions = schemas.JobAssignment.properties?.action?.enum;
  assertEquals(workerActions, Object.keys(transportSchemas.workerActions));
  for (const action of valid) {
    assertEquals(workerActions?.includes(action), false);
  }
});

Deno.test("execution control registers the canonical generated route", async () => {
  const app = createExecutionRunControlApp({
    database: {} as never,
    browserSession: async (_context, next) => await next(),
    publicBaseUrl: "https://bakery.example",
    secret: "contract-test-secret",
  });
  const response = await app.fetch(
    new Request(
      "https://bakery.example/v1/runs/00000000-0000-4000-8000-000000000001/controls",
      { method: "OPTIONS" },
    ),
  );
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, HEAD, POST");
});
