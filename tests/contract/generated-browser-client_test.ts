import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ApiProblemError,
  ApiTransportError,
  createBakeryClient,
} from "../../packages/contracts/src/client.ts";
import {
  ActionAccess,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import { createHealthApp } from "../../packages/contracts/src/health-app.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const INVITATION_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const DEPENDENCY_ID = "00000000-0000-4000-8000-000000000004";
Deno.test("client accepts typed readiness 503 responses from the real health router", async () => {
  const app = createHealthApp({
    service: "bakery-server",
    version: "test",
    config: { missingConfig: [] },
    dependencies: [{ name: "database", check: () => false }],
  });
  const client = createBakeryClient({
    baseUrl: "http://test",
    fetch: (input, init) => app.fetch(new Request(input, init)),
    createRequestId: () => REQUEST_ID,
  });

  assertEquals(await client.health.ready(), {
    service: "bakery-server",
    state: "unavailable",
    version: "test",
    dependencies: [{
      name: "database",
      state: "unavailable",
      reason: "DEPENDENCY_UNAVAILABLE",
    }],
  });
});

Deno.test("client serializes query input and validates real router output", async () => {
  let received: unknown;
  const registry = new ActionRegistry().register({
    name: "tasks.list",
    method: HttpMethod.Get,
    path: "/v1/tasks",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Task>"],
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    handler: (_context, input) => {
      received = input;
      return { items: [], nextCursor: null };
    },
  });
  const app = createApiRouter({ registry });
  let request: Request | undefined;
  const client = createBakeryClient({
    baseUrl: "http://test/",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    createRequestId: () => REQUEST_ID,
    fetch: (input, init) => {
      request = new Request(input, init);
      return app.fetch(request);
    },
  });

  assertEquals(await client.actions["tasks.list"]({ limit: 7 }), {
    items: [],
    nextCursor: null,
  });
  assertEquals(received, { limit: 7 });
  assertEquals(request?.url, "http://test/v1/tasks?limit=7");
  assertEquals(request?.credentials, "include");
  assertEquals(request?.headers.get("Bakery-Organization-Id"), ORGANIZATION_ID);
  assertEquals(request?.headers.get("X-Request-Id"), REQUEST_ID);
});

Deno.test("client serializes path-only deletes and declared concurrency headers", async () => {
  let receivedPath: string | undefined;
  const registry = new ActionRegistry().register({
    name: "organizationInvitations.cancel",
    method: HttpMethod.Delete,
    path: "/v1/organizations/:id/invitations/:invitationId",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    handler: (context) => {
      receivedPath = `${context.params.id}/${context.params.invitationId}`;
      return null;
    },
  });
  const app = createApiRouter({ registry });
  let request: Request | undefined;
  const client = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    fetch: (input, init) => {
      request = new Request(input, init);
      return app.fetch(request);
    },
  });

  const result = await client.actions["organizationInvitations.cancel"](
    { id: ORGANIZATION_ID, invitationId: INVITATION_ID },
    { ifMatch: '"revision-4"' },
  );
  assertEquals(result, undefined);
  assertEquals(receivedPath, `${ORGANIZATION_ID}/${INVITATION_ID}`);
  assertEquals(request?.headers.get("If-Match"), '"revision-4"');
  assertEquals(request?.body, null);
});

Deno.test("typed natural DELETEs omit keys unless explicitly overridden", async () => {
  const headers: Headers[] = [];
  const client = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    fetch: (_input, init) => {
      headers.push(new Headers(init?.headers));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });

  await client.actions["taskDependencies.delete"]({
    id: ORGANIZATION_ID,
    dependencyId: DEPENDENCY_ID,
  });
  await client.actions["taskDependencies.delete"](
    { id: ORGANIZATION_ID, dependencyId: DEPENDENCY_ID },
    { idempotencyKey: "dependency-delete-override" },
  );

  assertEquals(headers[0].get("Idempotency-Key"), null);
  assertEquals(headers[1].get("Idempotency-Key"), "dependency-delete-override");
});

Deno.test("client rejects invalid input and organization mismatches before network I/O", async () => {
  let calls = 0;
  const client = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    fetch: () => {
      calls += 1;
      throw new Error("must not run");
    },
  });

  const invalidInput = await assertRejects(() =>
    client.actions["tasks.list"]({ limit: 0 })
  );
  assertInstanceOf(invalidInput, ApiTransportError);
  assertEquals(invalidInput.kind, "protocol");

  const mismatch = await assertRejects(() =>
    client.actions["organizations.get"]({ id: INVITATION_ID })
  );
  assertInstanceOf(mismatch, ApiTransportError);
  assertEquals(mismatch.kind, "protocol");
  assertEquals(calls, 0);
});

Deno.test("client generates one idempotency key per logical command call", async () => {
  const keys: string[] = [];
  const problem = {
    type: "https://bakery.example/problems/state-conflict",
    title: "Conflict",
    status: 409,
    detail: "The requested state conflicts with the current state.",
    code: "STATE_CONFLICT",
    requestId: REQUEST_ID,
    retryable: false,
  };
  const client = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    fetch: (_input, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return Promise.resolve(Response.json(problem, {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }));
    },
  });
  const input = {
    applicationId: ORGANIZATION_ID,
    taskType: "feature" as const,
    title: "Generated client",
  };

  for (let index = 0; index < 2; index += 1) {
    const error = await assertRejects(() =>
      client.actions["tasks.create"](input)
    );
    assertInstanceOf(error, ApiProblemError);
    assertEquals(error.problem, {
      type: problem.type,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      retryable: problem.retryable,
      detail: problem.detail,
      requestId: problem.requestId,
    });
  }
  assert(keys.every((key) => key.length > 0));
  assertNotEquals(keys[0], keys[1]);
});

Deno.test("client classifies abort, network, malformed, HTML, and invalid success safely", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = createBakeryClient({
    baseUrl: "http://test",
    fetch: () => Promise.reject(new DOMException("secret", "AbortError")),
  });
  const abortError = await assertRejects(() =>
    aborted.health.live({ signal: controller.signal })
  );
  assertInstanceOf(abortError, ApiTransportError);
  assertEquals(abortError.kind, "aborted");
  assert(!abortError.message.includes("secret"));

  const network = createBakeryClient({
    baseUrl: "http://test",
    fetch: () => Promise.reject(new Error("provider secret")),
  });
  const networkError = await assertRejects(() => network.health.live());
  assertInstanceOf(networkError, ApiTransportError);
  assertEquals(networkError.kind, "network");
  assert(!networkError.message.includes("provider secret"));

  for (
    const response of [
      new Response("", { status: 500 }),
      new Response("<html>secret</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
      new Response("{", {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      }),
    ]
  ) {
    const malformed = createBakeryClient({
      baseUrl: "http://test",
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await assertRejects(() => malformed.health.live());
    assertInstanceOf(error, ApiTransportError);
    assertEquals(error.kind, "protocol");
    assert(!error.message.includes("secret"));
  }

  const invalidSuccess = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ORGANIZATION_ID }),
    fetch: () => Promise.resolve(Response.json({ items: [] })),
  });
  const successError = await assertRejects(() =>
    invalidSuccess.actions["tasks.list"]({})
  );
  assertInstanceOf(successError, ApiTransportError);
  assertEquals(successError.kind, "protocol");
});
