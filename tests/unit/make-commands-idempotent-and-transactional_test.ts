import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  ActionAuthorizationError,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  ActionRegistryError,
  HttpMethod,
  isEncodedSuccessResponse,
  normalizeRegisteredRouteTarget,
  validateEncodedSuccessResponse,
} from "../../packages/contracts/src/action-registry.ts";
import {
  type CatalogActionName,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  createNormalizedCommandMetadata,
  parseIdempotencyKey,
  parseStrongIfMatch,
  StandardError,
} from "../../packages/contracts/src/http.ts";

const Phase1CommandInput = z.object({
  message: z.string().min(1).describe(
    "Validated command message for Phase 1 tests.",
  ),
}).describe("Input used to exercise the Phase 1 command boundary.");
const Phase1CommandOutput = z.object({
  message: z.string().min(1).describe(
    "Returned command message for Phase 1 tests.",
  ),
}).describe("Output used to exercise the Phase 1 command boundary.");

const id = "00000000-0000-4000-8000-000000000001";
const context = {
  request: new Request("http://test"),
  params: { id },
  requestId: "request-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};
const metadata = {
  operation: "phase1.command",
  idempotencyKey: "command-1",
  target: `/v1/commands/${id}`,
  expectedVersion: 3,
};
const expectedMetadata = { ...metadata };

Deno.test("command runner receives validated metadata after authorization", async () => {
  const calls: string[] = [];
  const registry = new ActionRegistry(undefined, {
    run: async ({ input, metadata: receivedMetadata, invokeAndEncode }) => {
      calls.push("runner");
      assertEquals(input, { message: "accepted" });
      assertEquals(receivedMetadata, expectedMetadata);
      return await invokeAndEncode();
    },
  }).register({
    name: "phase1.command" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/commands/:id",
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: {
      type: ActionKind.Command,
      access: "Developer",
      authorize: (_context, input) => {
        calls.push("authorize");
        assertEquals(input, { message: "accepted" });
      },
    },
    handler: (_context, input) => {
      calls.push("handler");
      return input;
    },
  });

  const result = await registry.execute(
    "phase1.command",
    context,
    { message: "accepted" },
    metadata,
  );
  assertEquals(calls, ["authorize", "runner", "handler"]);
  assert(isEncodedSuccessResponse(result));
  assertEquals(result.status, 201);
  assertEquals(new TextDecoder().decode(result.body), '{"message":"accepted"}');
});

Deno.test("command UUID canonicalization follows contract types", async () => {
  const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const connectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const providerRepoId = applicationId.toUpperCase();
  const expectedInput = {
    applicationId,
    slug: "bakery",
    integrationConnectionId: connectionId,
    providerRepoId,
    owner: "Bakery",
    name: "bakery",
    defaultBranch: "main",
  };
  const actionName = "phase1.uuid-canonicalization" as CatalogActionName;
  const registry = new ActionRegistry(undefined, {
    run: async ({ input, invokeAndEncode }) => {
      assertEquals(input, expectedInput);
      return await invokeAndEncode();
    },
  }).register({
    name: actionName,
    method: HttpMethod.Post,
    path: "/v1/repositories/:providerRepoId",
    input: contractSchemas.RepositoryCreate,
    output: Phase1CommandOutput,
    policy: {
      type: ActionKind.Command,
      access: "Developer",
      authorize: (_context, input) => assertEquals(input, expectedInput),
    },
    handler: (_context, input) => {
      assertEquals(input, expectedInput);
      return { message: "accepted" };
    },
  });

  const result = await registry.execute(
    actionName,
    { ...context, params: { providerRepoId } },
    {
      ...expectedInput,
      applicationId: applicationId.toUpperCase(),
      integrationConnectionId: connectionId.toUpperCase(),
    },
    {
      operation: actionName,
      idempotencyKey: "uuid-canonicalization",
      target: `/v1/repositories/${providerRepoId}`,
    },
  );
  assert(isEncodedSuccessResponse(result));
  assertEquals(result.status, 201);
});

Deno.test("query execution remains on the direct handler path", async () => {
  let runnerCalls = 0;
  const registry = new ActionRegistry(undefined, {
    run: () => {
      runnerCalls++;
      throw new Error("query must not enter the command runner");
    },
  }).register({
    name: "phase1.query" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/query/:id",
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: { type: ActionKind.Query, access: "Public" },
    handler: () => ({ message: "query" }),
  });

  assertEquals(
    await registry.execute("phase1.query", context, { message: "query" }),
    { message: "query" },
  );
  assertEquals(runnerCalls, 0);
});

Deno.test("authorization rejects before command metadata validation or runner access", async () => {
  let runnerCalls = 0;
  let metadataCalls = 0;
  const registry = new ActionRegistry(undefined, {
    run: () => {
      runnerCalls++;
      throw new Error("denied command must not run");
    },
  }).register({
    name: "phase1.denied" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/commands/:id",
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: {
      type: ActionKind.Command,
      access: "Developer",
      authorize: () => {
        throw new ActionAuthorizationError("denied");
      },
    },
    handler: () => ({ message: "never" }),
  });

  await assertRejects(
    () =>
      registry.execute(
        "phase1.denied",
        context,
        { message: "accepted" },
        () => {
          metadataCalls++;
          return { ...metadata, operation: "phase1.other" };
        },
      ),
    ActionAuthorizationError,
  );
  assertEquals(runnerCalls, 0);
  assertEquals(metadataCalls, 0);
});

Deno.test("strong If-Match and bounded idempotency keys are normalized", async () => {
  assertEquals(parseIdempotencyKey("  command-1  "), "command-1");
  assertEquals(parseStrongIfMatch('"task-v3"'), 3);
  assertEquals(parseStrongIfMatch('"3"'), 3);
  assertEquals(parseStrongIfMatch('"2147483647"'), 2147483647);
  assertEquals(
    createNormalizedCommandMetadata(
      {
        name: "phase1.command" as CatalogActionName,
        method: HttpMethod.Post,
        path: "/v1/commands/:id",
        input: Phase1CommandInput,
      },
      new Request(
        `http://test/v1/commands/${id}?ignored=query`,
        {
          headers: {
            "idempotency-key": " command-1 ",
            "if-match": '"task-v9"',
          },
        },
      ),
      { id },
    ),
    {
      operation: "phase1.command",
      idempotencyKey: "command-1",
      target: `/v1/commands/${id}`,
    },
  );
  assertEquals(
    normalizeRegisteredRouteTarget("/v1/resources/:id", { id }),
    `/v1/resources/${id}`,
  );
  assertEquals(
    normalizeRegisteredRouteTarget("/v1/resources/{id}", { id }),
    `/v1/resources/${id}`,
  );
  const braceRegistry = new ActionRegistry().register({
    name: "phase1.brace" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/resources/{id}",
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => ({ message: "never" }),
  });
  await assertRejects(
    () =>
      braceRegistry.execute(
        "phase1.brace",
        { ...context, params: { id: "not-a-uuid" } },
        { message: "accepted" },
        {
          operation: "phase1.brace",
          idempotencyKey: "brace-1",
          target: "/v1/resources/not-a-uuid",
        },
      ),
    z.ZodError,
  );
  assertThrows(
    () => parseIdempotencyKey("k".repeat(256)),
    StandardError,
  );
  for (
    const value of [
      "",
      'W/"3"',
      "3",
      '"3", "4"',
      '"2147483648"',
    ]
  ) {
    assertThrows(() => parseStrongIfMatch(value), StandardError);
  }
});

Deno.test("recipient natural keys include each validated invitation", () => {
  const acceptAction = {
    name: "organizationInvitations.recipientAccept" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/api/auth/organization/accept-invitation",
    input: contractSchemas.OrganizationInvitationRecipientAction,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "invitationId",
  };
  const rejectAction = {
    name: "organizationInvitations.recipientReject" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/api/auth/organization/reject-invitation",
    input: contractSchemas.OrganizationInvitationRecipientAction,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "invitationId",
  };
  const invitationA = "00000000-0000-4000-8000-000000000002";
  const invitationB = "00000000-0000-4000-8000-000000000003";
  const request = new Request("http://test", { method: "POST" });
  const inputA = contractSchemas.OrganizationInvitationRecipientAction.parse({
    invitationId: invitationA,
  });
  const inputB = contractSchemas.OrganizationInvitationRecipientAction.parse({
    invitationId: invitationB,
  });

  const acceptA = createNormalizedCommandMetadata(
    acceptAction,
    request,
    {},
    inputA,
  );
  const acceptB = createNormalizedCommandMetadata(
    acceptAction,
    request,
    {},
    inputB,
  );
  assert(acceptA.idempotencyKey !== acceptB.idempotencyKey);
  assert(
    acceptA.idempotencyKey.endsWith(`:invitationId:${invitationA}`),
  );
  const rejectA = createNormalizedCommandMetadata(
    rejectAction,
    request,
    {},
    inputA,
  );
  assert(rejectA.idempotencyKey !== acceptA.idempotencyKey);

  const explicit = createNormalizedCommandMetadata(
    acceptAction,
    new Request("http://test", {
      method: "POST",
      headers: { "Idempotency-Key": "explicit-recipient-key" },
    }),
    {},
    inputA,
  );
  assertEquals(explicit.idempotencyKey, "explicit-recipient-key");
});
Deno.test("natural keys canonicalize UUID route identities", () => {
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const dependencyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const action = {
    name: "taskDependencies.delete" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/tasks/:id/dependencies/:dependencyId",
    input: contractSchemas.DependencyPath,
    naturalIdempotency: true,
  };
  const request = new Request("http://test", { method: "DELETE" });
  const lower = createNormalizedCommandMetadata(
    action,
    request,
    { id: taskId, dependencyId },
    contractSchemas.DependencyPath.parse({ id: taskId, dependencyId }),
  );
  const upper = createNormalizedCommandMetadata(
    action,
    request,
    { id: taskId.toUpperCase(), dependencyId: dependencyId.toUpperCase() },
    contractSchemas.DependencyPath.parse({
      id: taskId.toUpperCase(),
      dependencyId: dependencyId.toUpperCase(),
    }),
  );

  assertEquals(upper, lower);
  assertEquals(
    lower.target,
    `/v1/tasks/${taskId}/dependencies/${dependencyId}`,
  );
});

Deno.test("natural identity fields fail closed", () => {
  const action = {
    name: "phase1.natural" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/natural",
    input: Phase1CommandInput,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "message" as const,
  };
  const request = new Request("http://test", { method: "POST" });
  assertEquals(
    createNormalizedCommandMetadata(action, request, {}, {
      message: "accepted",
    }).idempotencyKey,
    "natural:phase1.natural:/v1/natural:message:accepted",
  );
  const opaqueUuidLookingMessage = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  assertEquals(
    createNormalizedCommandMetadata(action, request, {}, {
      message: opaqueUuidLookingMessage,
    }).idempotencyKey,
    `natural:phase1.natural:/v1/natural:message:${opaqueUuidLookingMessage}`,
  );
  assertThrows(
    () => createNormalizedCommandMetadata(action, request, {}, {}),
    StandardError,
  );
  assertThrows(
    () =>
      createNormalizedCommandMetadata(
        { ...action, naturalIdempotencyInputField: "" },
        request,
        {},
        { message: "accepted" },
      ),
    StandardError,
  );
  const definition = {
    ...action,
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: { type: ActionKind.Command, access: "Public" as const },
    handler: () => ({ message: "natural" }),
  };
  new ActionRegistry().register(definition);
  assertThrows(
    () =>
      new ActionRegistry().register({
        ...definition,
        name: "phase1.bad-field" as CatalogActionName,
        naturalIdempotencyInputField: "missing",
      } as unknown as ActionDefinition),
    ActionRegistryError,
  );
  const invalidNaturalInputs = [
    [
      "numeric",
      z.object({
        message: z.number().describe("Numeric identity test field."),
      }).describe("Numeric natural identity input."),
    ],
    [
      "optional",
      z.object({
        message: z.string().optional().describe(
          "Optional identity test field.",
        ),
      }).describe("Optional natural identity input."),
    ],
    [
      "nullable",
      z.object({
        message: z.string().nullable().describe(
          "Nullable identity test field.",
        ),
      }).describe("Nullable natural identity input."),
    ],
  ] as const;
  for (const [kind, input] of invalidNaturalInputs) {
    assertThrows(
      () =>
        new ActionRegistry().register({
          ...definition,
          name: `phase1.bad-${kind}` as CatalogActionName,
          input,
        } as unknown as ActionDefinition),
      ActionRegistryError,
    );
  }
  assertThrows(
    () =>
      new ActionRegistry().register({
        ...definition,
        name: "phase1.bad-kind" as CatalogActionName,
        naturalIdempotency: false,
      }),
    ActionRegistryError,
  );
  const routeOnly = createNormalizedCommandMetadata(
    {
      name: "phase1.routeOnly" as CatalogActionName,
      method: HttpMethod.Delete,
      path: "/v1/resources/:id",
      input: Phase1CommandInput,
      naturalIdempotency: true,
    },
    request,
    { id },
    {},
  );
  assertEquals(
    routeOnly.idempotencyKey,
    `natural:phase1.routeOnly:/v1/resources/${id}`,
  );
});

Deno.test("task titles reject whitespace-only transport values", () => {
  assertEquals(
    contractSchemas.TaskCreate.safeParse({
      applicationId: id,
      taskType: "feature",
      title: " ",
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.TaskUpdate.safeParse({ title: "\t\n" }).success,
    false,
  );
  assertEquals(
    contractSchemas.TaskUpdate.safeParse({ title: " Renamed " }).success,
    true,
  );
});

Deno.test("encoded success validation preserves bytes and rejects non-stable headers", () => {
  const registry = new ActionRegistry().register({
    name: "phase1.encoded" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/encoded",
    input: Phase1CommandInput,
    output: Phase1CommandOutput,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => ({ message: "encoded" }),
  });
  const action = registry.get("phase1.encoded");
  const body = new TextEncoder().encode('{"message":"é"}');
  const response = validateEncodedSuccessResponse(action, {
    status: 201,
    body,
    headers: {
      "content-type": "application/json",
      location: "/v1/encoded/1",
      etag: '"v1"',
    },
  });
  assert(response.body === body);
  assertThrows(
    () =>
      validateEncodedSuccessResponse(action, {
        ...response,
        headers: { "x-secret": "must not be emitted" },
      }),
    ActionRegistryError,
  );
  assertThrows(
    () =>
      validateEncodedSuccessResponse(action, {
        ...response,
        body: new Uint8Array(),
      }),
    ActionRegistryError,
  );
  assertThrows(
    () =>
      validateEncodedSuccessResponse(action, {
        ...response,
        body: new Uint8Array(1024 * 1024 + 1),
      }),
    ActionRegistryError,
  );
});
