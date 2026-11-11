import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createApiRouter,
  StandardError,
} from "../../packages/contracts/src/http.ts";
import {
  type CatalogActionName,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import { z } from "zod";
import { englishCatalog } from "../../packages/i18n/src/index.ts";

Deno.test("output validation prevents secret projection leaks", async () => {
  const registry = new ActionRegistry().register({
    name: "safe.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/safe",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: { type: "query", access: "Public" },
    handler: () => ({ leaseTokenHash: "secret" }) as never,
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/safe"),
  );
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "INTERNAL");
});

Deno.test("protected actions fail closed without an authorization guard", async () => {
  const registry = new ActionRegistry().register({
    name: "protected.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/protected",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: { type: "query", access: "Developer" },
    handler: () => {
      throw new Error("must not run");
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/protected"),
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
});

Deno.test("unknown issue shaped errors remain internal and bounded", async () => {
  const error = { issues: [{ message: "password=secret".repeat(100) }] };
  const response = await createApiRouter({
    registry: new ActionRegistry().register({
      name: "unknown.issue" as CatalogActionName,
      method: HttpMethod.Get,
      path: "/v1/unknown-issue",
      input: contractSchemas.CursorQuery,
      output: contractSchemas.Task,
      policy: { type: "query", access: "Public" },
      handler: () => {
        throw error;
      },
    }),
  }).fetch(new Request("http://test/v1/unknown-issue"));
  const body = await response.json();
  assertEquals(body.code, "INTERNAL");
  assertEquals(body.detail, englishCatalog["problems.INTERNAL.description"]);
  assertEquals(body.issues, undefined);
  assertStringIncludes(
    JSON.stringify(body),
    englishCatalog["problems.INTERNAL.description"],
  );
});

Deno.test("deadline aborts a body read", async () => {
  let timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      clearTimeout(timer);
      return new Promise<void>(() => {});
    },
    start(controller) {
      timer = setTimeout(() => {
        try {
          controller.enqueue(new TextEncoder().encode("{}"));
        } catch {
          // The request deadline may cancel the stream first.
        }
      }, 100);
    },
  });
  const registry = new ActionRegistry().register({
    name: "slow.write" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/slow",
    input: contractSchemas.TaskCreate,
    output: contractSchemas.Task,
    policy: { type: "command", access: "Public" },
    handler: () => ({}) as never,
  });
  const response = await createApiRouter({ registry, deadlineMs: 1 }).fetch(
    new Request("http://test/v1/slow", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "content-type": "application/json" },
    } as RequestInit),
  );
  assertEquals(response.status, 504);
  assertEquals((await response.json()).code, "DEPENDENCY_TIMEOUT");
});

Deno.test("pre-aborted request signal is honored", async () => {
  const signal = new AbortController();
  signal.abort("client");
  const registry = new ActionRegistry().register({
    name: "aborted.write" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/aborted",
    input: contractSchemas.TaskCreate,
    output: contractSchemas.Task,
    policy: { type: "command", access: "Public" },
    handler: () => {
      throw new Error("must not run");
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/aborted", {
      method: "POST",
      body: "{}",
      signal: signal.signal,
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(response.status, 504);
});

Deno.test("pre-aborted GET does not call authorization or handler", async () => {
  const signal = new AbortController();
  signal.abort("client");
  let calls = 0;
  const registry = new ActionRegistry().register({
    name: "aborted.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/aborted-read",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: {
      type: "query",
      access: "Developer",
      authorize: () => {
        calls++;
      },
    },
    handler: () => {
      calls++;
      return {} as never;
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/aborted-read", { signal: signal.signal }),
  );
  assertEquals(response.status, 504);
  assertEquals(calls, 0);
});

Deno.test("cancellation after authorization prevents handler dispatch", async () => {
  let release!: () => void;
  const authorization = new Promise<void>((resolve) => release = resolve);
  let handlerCalls = 0;
  const registry = new ActionRegistry().register({
    name: "cancel.after-auth" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/cancel-after-auth",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: {
      type: "query",
      access: "Developer",
      authorize: () => authorization,
    },
    handler: () => {
      handlerCalls++;
      return {} as never;
    },
  });
  const controller = new AbortController();
  const responsePromise = createApiRouter({ registry, deadlineMs: 5 }).fetch(
    new Request("http://test/v1/cancel-after-auth", {
      signal: controller.signal,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const response = await responsePromise;
  assertEquals(response.status, 504);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(handlerCalls, 0);
});
Deno.test("synchronous authorization cancellation maps to timeout", async () => {
  const requestController = new AbortController();
  const registry = new ActionRegistry().register({
    name: "cancel.sync" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/cancel-sync",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.Task,
    policy: {
      type: "query",
      access: "Developer",
      authorize: (_context) => {
        requestController.abort("guard");
      },
    },
    handler: () => ({}) as never,
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/cancel-sync", {
      signal: requestController.signal,
    }),
  );
  assertEquals(response.status, 504);
});

Deno.test("non-UUID route slugs use string fallback validation", async () => {
  const SlugPath = z.object({
    slug: z.string().describe("A human-readable route slug."),
  }).describe("A route slug input.");
  let seen = "";
  const registry = new ActionRegistry().register({
    name: "slug.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/slugs/:slug",
    input: SlugPath,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Public" },
    handler: (context) => {
      seen = context.params.slug;
      return null;
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/slugs/my-slug"),
  );
  assertEquals(response.status, 204);
  assertEquals(seen, "my-slug");
});

Deno.test("path parameters are validated before authorization and handler", async () => {
  let authCalls = 0;
  let handlerCalls = 0;
  const registry = new ActionRegistry().register({
    name: "task.update-path" as CatalogActionName,
    method: HttpMethod.Patch,
    path: "/v1/tasks/:id",
    input: contractSchemas.TaskUpdate,
    output: contractSchemas.Task,
    policy: {
      type: "command",
      access: "Developer",
      authorize: () => {
        authCalls++;
      },
    },
    handler: () => {
      handlerCalls++;
      return {} as never;
    },
  });
  const response = await createApiRouter({ registry }).fetch(
    new Request("http://test/v1/tasks/not-a-uuid", {
      method: "PATCH",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(authCalls, 0);
  assertEquals(handlerCalls, 0);
});

Deno.test("standard error issues use the bounded public allowlist", async () => {
  const issueMessage = "x".repeat(1000);
  const response = await createApiRouter({
    registry: new ActionRegistry().register({
      name: "bounded.issue" as CatalogActionName,
      method: HttpMethod.Get,
      path: "/v1/bounded-issue",
      input: contractSchemas.CursorQuery,
      output: contractSchemas.Task,
      policy: { type: "query", access: "Public" },
      handler: () => {
        throw new StandardError({
          code: "VALIDATION_FAILED",
          params: {
            issues: [{
              path: [issueMessage, 1],
              message: issueMessage,
              code: issueMessage,
              secret: issueMessage,
            }],
            secret: issueMessage,
          },
        });
      },
    }),
  }).fetch(new Request("http://test/v1/bounded-issue"));
  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(Object.keys(body.issues[0]).sort(), ["code", "message", "path"]);
  assertEquals(body.issues[0].path[0].length, 200);
  assertEquals(body.issues[0].message.length, 200);
  assertEquals(body.issues[0].code.length, 64);
  assertEquals(
    body.detail,
    englishCatalog["problems.VALIDATION_FAILED.description"],
  );
  assertEquals(JSON.stringify(body).includes("secret"), false);
});

Deno.test("provider fault issues are redacted", async () => {
  const response = await createApiRouter({
    registry: new ActionRegistry().register({
      name: "provider.fail" as CatalogActionName,
      method: HttpMethod.Get,
      path: "/v1/provider-fail",
      input: contractSchemas.CursorQuery,
      output: contractSchemas.Task,
      policy: { type: "query", access: "Public" },
      handler: () => {
        throw new StandardError({
          code: "PROVIDER_QUOTA_EXCEEDED",
          params: { issues: [{ message: "provider-secret" }], limit: 99 },
        });
      },
    }),
  }).fetch(new Request("http://test/v1/provider-fail"));
  const body = await response.json();
  assertEquals(body.issues, undefined);
  assertEquals(body.limit, undefined);
  assertEquals(JSON.stringify(body).includes("provider-secret"), false);
});
