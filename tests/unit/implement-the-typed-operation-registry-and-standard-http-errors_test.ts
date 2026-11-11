import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ActionAuthorizationError,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  ActionRegistryError,
  assertRegisteredActions,
  coerceQueryInput,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  type CatalogActionName,
  contractSchemas,
  principalId as asPrincipalId,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { StandardError, toProblem } from "../../packages/contracts/src/http.ts";
import { englishCatalog } from "../../packages/i18n/src/index.ts";
import {
  BakeryException,
  ContractQualityError,
} from "../../packages/contracts/src/exceptions.ts";
import {
  IdentityResolutionError,
  resolvePrincipal,
} from "../../apps/server/src/modules/auth/application/identity.ts";

const definition: ActionDefinition = {
  name: "health.read" as CatalogActionName,
  method: HttpMethod.Get,
  path: "/v1/health",
  input: contractSchemas.CursorQuery,
  output: contractSchemas.Task,
  policy: { type: ActionKind.Query, access: ActionAccess.Developer },
  handler: () => ({}),
};
Deno.test("action registry rejects duplicates, invalid policy, and unknown contracts", () => {
  const registry = new ActionRegistry().register(definition);
  assertThrows(
    () => registry.register(definition),
    ActionRegistryError,
    "health.read",
  );
  assertThrows(
    () =>
      registry.register(
        { ...definition, name: "health.write", policy: undefined } as never,
      ),
    ActionRegistryError,
  );
  assertThrows(
    () =>
      registry.register({
        ...definition,
        name: "health.invalid-type",
        policy: { type: "stream", access: "Public" },
      } as never),
    ActionRegistryError,
    "valid policy",
  );
  assertThrows(
    () =>
      registry.register({
        ...definition,
        name: "health.invalid-access",
        policy: { type: "query", access: "not-a-catalog-policy" },
      } as never),
    ActionRegistryError,
    "valid policy",
  );
  assertThrows(
    () =>
      registry.register({
        ...definition,
        name: "health.other" as CatalogActionName,
        input: "Missing" as unknown as ActionDefinition["input"],
      }),
    ActionRegistryError,
  );
  assertThrows(
    () =>
      registry.register({
        ...definition,
        name: "health.alias" as CatalogActionName,
      }),
    ActionRegistryError,
  );
});
Deno.test("action registry rejects duplicate route shapes", () => {
  const registry = new ActionRegistry().register({
    ...definition,
    name: "health.path-one" as CatalogActionName,
    path: "/v1/resources/:id",
  });
  assertThrows(
    () =>
      registry.register({
        ...definition,
        name: "health.path-two" as CatalogActionName,
        path: "/v1/resources/:resourceId",
      }),
    ActionRegistryError,
    "health.path-two",
  );
});

function taskActionRegistry(): ActionRegistry {
  return createTaskActionRegistry({
    list: () => null as never,
    get: () => null as never,
    create: () => null as never,
    update: () => null as never,
    createDependency: () => null as never,
    deleteDependency: () => null as never,
    runsCreate: () => null as never,
    runsList: () => null as never,
    runsGet: () => null as never,
    runStepsList: () => null as never,
    workflowPresetsList: () => null as never,
    usageList: () => null as never,
    sync: () => null as never,
  });
}

Deno.test("task actions must match their catalog entries", () => {
  const mutations: [
    string,
    (action: ReturnType<ActionRegistry["list"]>[number]) => void,
  ][] = [
    ["method", (action) => action.method = HttpMethod.Post],
    ["path", (action) => action.path = "/v1/tasks/:id/extra"],
    ["input", (action) => action.input = contractSchemas.TaskUpdate],
    ["output", (action) => action.output = contractSchemas.Task],
    ["unknown", (action) => action.name = "tasks.unknown" as CatalogActionName],
  ];
  for (const [field, mutate] of mutations) {
    const registry = taskActionRegistry();
    const action = registry.get("tasks.list");
    mutate(action);
    assertThrows(
      () => assertRegisteredActions(registry),
      ActionRegistryError,
      `tasks.${field === "unknown" ? "unknown" : "list"}`,
    );
  }
});
Deno.test("catalog and executable access policies must match", () => {
  const registry = taskActionRegistry();
  registry.get("tasks.list").policy.access = "Admin";
  assertThrows(
    () => assertRegisteredActions(registry),
    ActionRegistryError,
    "tasks.list access mismatch",
  );
});
Deno.test("catalog and executable idempotency policies must match", () => {
  const registry = taskActionRegistry();
  registry.get("tasks.list").naturalIdempotency = true;
  assertThrows(
    () => assertRegisteredActions(registry),
    ActionRegistryError,
    "tasks.list natural idempotency mismatch",
  );
});
Deno.test("action registry parity preserves path parameter names", () => {
  const registry = taskActionRegistry();
  registry.get("tasks.get").path = "/v1/tasks/:taskId";
  assertThrows(
    () => assertRegisteredActions(registry),
    ActionRegistryError,
    "tasks.get path parameter names mismatch",
  );
});
Deno.test("problem mapping is stable and redacts unknown errors", () => {
  const problem = toProblem(new Error("secret sql"), {
    requestId: "req-1",
    traceId: "trace-1",
    publicBaseUrl: "https://bakery.example",
  });
  assertEquals(problem.code, "INTERNAL");
  assertEquals(problem.detail, englishCatalog["problems.INTERNAL.description"]);
  const domain = toProblem(
    new StandardError({ code: "STATE_CONFLICT", detail: "safe" }),
    {
      requestId: "req-1",
      traceId: "trace-1",
      publicBaseUrl: "https://bakery.example",
    },
  );
  assertEquals(domain.type, "https://bakery.example/problems/state-conflict");
  assertEquals(domain.status, 409);
  assertEquals(domain.code, "STATE_CONFLICT");
  assertEquals("reason" in domain, false);
});

Deno.test("a state conflict names its rule only with a safe slug", () => {
  const options = {
    requestId: "req-1",
    traceId: "trace-1",
    publicBaseUrl: "https://bakery.example",
  };
  const conflict = (params: Record<string, unknown>) =>
    toProblem(new StandardError({ code: "STATE_CONFLICT", params }), options);
  assertEquals(
    conflict({ reason: "approval_required" }).reason,
    "approval_required",
  );
  for (
    const reason of [
      "Approval Required",
      "approval-required",
      "1approval",
      "a".repeat(65),
      "drop table; --",
      "",
      42,
      null,
    ]
  ) {
    assertEquals(
      "reason" in conflict({ reason }),
      false,
      `reason ${JSON.stringify(reason)} must be dropped`,
    );
  }
  // Only STATE_CONFLICT carries a reason; other codes keep their own shape.
  const other = toProblem(
    new StandardError({ code: "UNPROCESSABLE", params: { reason: "x_y" } }),
    options,
  );
  assertEquals("reason" in other, false);
});

Deno.test("a state conflict carries bounded issues only when its params list them", () => {
  const options = {
    requestId: "req-1",
    traceId: "trace-1",
    publicBaseUrl: "https://bakery.example",
  };
  const listed = toProblem(
    new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: "ticket_not_ready",
        issues: [{
          path: ["checks", "x"],
          code: "y",
          message: "m".repeat(500),
        }],
      },
    }),
    options,
  );
  assertEquals(listed.reason, "ticket_not_ready");
  assertEquals(listed.issues, [
    { path: ["checks", "x"], message: "m".repeat(200), code: "y" },
  ]);
  const bare = toProblem(
    new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_not_ready", checks: [{ id: "secret" }] },
    }),
    options,
  );
  assertEquals("issues" in bare, false);
  assertEquals(JSON.stringify(bare).includes("secret"), false);
});

Deno.test("Bakery exceptions preserve inheritance and internal redaction", () => {
  const standard = new StandardError({ code: "STATE_CONFLICT" });
  const registry = new ActionRegistryError("registry");
  const authorization = new ActionAuthorizationError("authorization");
  assert(standard instanceof Error);
  assert(standard instanceof BakeryException);
  assert(registry instanceof Error);
  assert(registry instanceof BakeryException);
  assert(authorization instanceof Error);
  assert(authorization instanceof ActionRegistryError);
  assert(authorization instanceof BakeryException);

  for (
    const error of [
      new ContractQualityError("secret contract detail"),
      new BakeryException("secret internal detail"),
    ]
  ) {
    const problem = toProblem(error, {
      requestId: "req-1",
      traceId: "trace-1",
      publicBaseUrl: "https://bakery.example",
    });
    assertEquals(problem.status, 500);
    assertEquals(problem.code, "INTERNAL");
    assertEquals(
      problem.detail,
      englishCatalog["problems.INTERNAL.description"],
    );
    assert(!JSON.stringify(problem).includes("secret"));
  }
});

Deno.test("execute validates path params before adapter authorization", async () => {
  let called = false;
  const registry = new ActionRegistry().register({
    name: "task.direct" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/tasks/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      type: "query",
      access: "Developer",
      authorize: () => {
        called = true;
      },
    },
    handler: () => {
      called = true;
      return null;
    },
  });
  await assertRejects(
    () =>
      registry.execute("task.direct", {
        request: new Request("http://test"),
        params: { id: "invalid" },
        requestId: "r",
        traceId: "t",
        signal: new AbortController().signal,
      }, {}),
  );
  assertEquals(called, false);
});

Deno.test("execute rejects mismatched path fields and accepts matching fields", async () => {
  let calls = 0;
  const registry = new ActionRegistry().register({
    name: "task.match" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/tasks/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: () => {
      calls++;
      return null;
    },
  });
  const context = (id: string) => ({
    request: new Request("http://test"),
    params: { id },
    requestId: "r",
    traceId: "t",
    signal: new AbortController().signal,
  });
  await assertRejects(() =>
    registry.execute(
      "task.match",
      context("00000000-0000-4000-8000-000000000001"),
      {
        id: "00000000-0000-4000-8000-000000000002",
      },
    )
  );
  await registry.execute(
    "task.match",
    context("00000000-0000-4000-8000-000000000001"),
    {
      id: "00000000-0000-4000-8000-000000000001",
    },
  );
  assertEquals(calls, 1);
});

Deno.test("invalid StandardError status falls back to catalog status", () => {
  for (const status of [200, 302, 600, NaN, Infinity, -1]) {
    const problem = toProblem(
      new StandardError({
        code: "VALIDATION_FAILED",
        status,
        detail: "secret",
      }),
      { requestId: "r", traceId: "t", publicBaseUrl: "https://test" },
    );
    assertEquals(problem.status, 422);
    assertEquals(
      problem.detail,
      englishCatalog["problems.VALIDATION_FAILED.description"],
    );
  }
});

Deno.test("identity resolution requires one enabled principal", async () => {
  const principalId = asPrincipalId("00000000-0000-4000-8000-000000000001");
  assertEquals(
    await resolvePrincipal(
      {
        loadEnabledPrincipal: () =>
          Promise.resolve({
            principalId,
            principalType: PrincipalType.Human,
            displayName: " Bakery Admin ",
          }),
      },
      "provider-user",
    ),
    {
      principalId,
      principalType: PrincipalType.Human,
      displayName: "Bakery Admin",
    },
  );

  for (
    const principal of [
      null,
      { principalId, principalType: "person", displayName: "Bakery Admin" },
      { principalId, principalType: PrincipalType.Human, displayName: " " },
    ]
  ) {
    await assertRejects(
      () =>
        resolvePrincipal(
          { loadEnabledPrincipal: () => Promise.resolve(principal) } as never,
          "provider-user",
        ),
      IdentityResolutionError,
    );
  }
});

Deno.test("query coercion turns only exact boolean and numeric literals into typed values", () => {
  const schema = contractSchemas.IntegrationResourceQuery;
  assertEquals(
    coerceQueryInput(schema, {
      selected: "true",
      available: "false",
      limit: "5",
      kind: "repository",
    }),
    { selected: true, available: false, limit: 5, kind: "repository" },
  );
  for (const raw of ["TRUE", "1", "yes", "", "false "]) {
    const coerced = coerceQueryInput(schema, { selected: raw });
    assertEquals(coerced, { selected: raw }, raw);
    assert(!schema.safeParse(coerced).success, raw);
  }
  // A string field keeps its literal text.
  assertEquals(coerceQueryInput(schema, { kind: "true" }), { kind: "true" });
});
