import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { parseTraceparent } from "@bakery/config/telemetry-trace";
import {
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "../../packages/contracts/src/contracts.ts";
import { createMcpCatalogTools } from "../../apps/server/src/platform/mcp/catalog-tools.ts";
import { createMcpToolRunner } from "../../apps/server/src/platform/mcp/tools.ts";
import { McpTool } from "../../apps/server/src/platform/mcp/scopes.ts";
import { childSessionTraceparent } from "../../apps/server/src/modules/execution/attempt-trace.ts";

/**
 * AC2 of #739: one trace joins every call of a run. A tool call over MCP and a
 * session started beneath another both continue the trace they belong to
 * instead of starting one of their own.
 */

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER = `00-${TRACE}-00f067aa0ba902b7-01`;
const grant = {
  providerUserId: "provider-user",
  clientId: "client",
  organizationId: "11111111-1111-4111-8111-111111111111",
  principalId: "22222222-2222-4222-8222-222222222222",
  tokenScopes: [],
  consentScopes: [],
  scopes: [],
} as never;

function recordingRegistry() {
  const seen: { traceId: string; traceparent: string | null }[] = [];
  const registry = {
    execute: (_action: string, context: {
      traceId: string;
      request: Request;
    }) => {
      seen.push({
        traceId: context.traceId,
        traceparent: context.request.headers.get("traceparent"),
      });
      return Promise.resolve({});
    },
  } as unknown as ActionRegistry;
  return { registry, seen };
}

Deno.test("a fixed MCP tool call continues its caller's trace", async () => {
  const { registry, seen } = recordingRegistry();
  const runner = createMcpToolRunner({
    publicOrigin: "http://127.0.0.1:8788",
    registry,
    loadSubject: () => Promise.resolve({}),
  });
  await runner.run(McpTool.Whoami, grant, { traceparent: CALLER });
  assertEquals(seen, [{ traceId: TRACE, traceparent: CALLER }]);
});

Deno.test("a fixed MCP tool call with no usable caller trace starts its own, and a malformed header is never trusted", async () => {
  const { registry, seen } = recordingRegistry();
  const runner = createMcpToolRunner({
    publicOrigin: "http://127.0.0.1:8788",
    registry,
    loadSubject: () => Promise.resolve({}),
  });
  await runner.run(McpTool.Whoami, grant);
  await runner.run(McpTool.Whoami, grant, { traceparent: "not-a-trace" });
  await runner.run(McpTool.Whoami, grant, {
    traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
  });
  assertEquals(seen.length, 3);
  for (const call of seen) {
    assertEquals(call.traceparent, null, "a bad header is not forwarded");
    assertNotEquals(call.traceId, TRACE);
    assert(call.traceId.length > 0);
  }
  assertEquals(new Set(seen.map((call) => call.traceId)).size, 3);
});

Deno.test("a catalog MCP tool call reaches its operation inside the caller's trace", async () => {
  const handled: string[] = [];
  const registry = new ActionRegistry({
    run: (_action, context, _input, next) => next(context),
  });
  registry.register({
    name: "tasks.list",
    method: HttpMethod.Get,
    path: "/v1/tasks",
    input: contractSchemas.TaskQuery,
    output: contractSchemas["Page<Task>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context: { traceId: string }) => {
      handled.push(context.traceId);
      return { items: [], nextCursor: null };
    },
  } as never);
  const catalog = createMcpCatalogTools({
    publicOrigin: "http://127.0.0.1:8788",
    loadSubject: () => Promise.resolve({}),
    registries: [registry],
  });
  const tool = catalog.get("bakery_tasks_list");
  assert(tool !== undefined);
  await catalog.run(tool, grant, {}, { traceparent: CALLER });
  await catalog.run(tool, grant, {});
  assertEquals(handled.length, 2, "the operation ran both times");
  assertEquals(handled[0], TRACE);
  assertNotEquals(handled[1], TRACE);
});

Deno.test("a child session starts in its parent's trace with a span of its own", () => {
  const parent = parseTraceparent(CALLER)!;
  const child = parseTraceparent(childSessionTraceparent(CALLER) ?? "");
  assert(child !== undefined);
  assertEquals(child.traceId, parent.traceId);
  assertNotEquals(child.spanId, parent.spanId);
  assertEquals(child.sampled, parent.sampled);
  // A grandchild is still in the same trace.
  const grandchild = parseTraceparent(
    childSessionTraceparent(`00-${child.traceId}-${child.spanId}-01`) ?? "",
  );
  assertEquals(grandchild?.traceId, TRACE);
});

Deno.test("a parent with no usable trace gives its child none, never an invented root", () => {
  for (
    const parent of [
      undefined,
      null,
      "",
      "garbage",
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
    ]
  ) {
    assertEquals(childSessionTraceparent(parent), undefined);
  }
});
