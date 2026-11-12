import { assertEquals } from "@std/assert";
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

function registryWith(sessionOnly: boolean): ActionRegistry {
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
      sessionOnly,
    },
    handler: () => ({ items: [], nextCursor: null }),
  } as never);
  return registry;
}

Deno.test("an access-management (session-only) action is never an MCP tool", () => {
  const options = {
    publicOrigin: "http://127.0.0.1:8788",
    loadSubject: () => Promise.resolve({}),
  };
  const exposed = createMcpCatalogTools({
    ...options,
    registries: [registryWith(false)],
  });
  assertEquals(exposed.tools.map((tool) => tool.name), ["bakery_tasks_list"]);
  const hidden = createMcpCatalogTools({
    ...options,
    registries: [registryWith(true)],
  });
  assertEquals(hidden.tools, []);
  assertEquals(hidden.get("bakery_tasks_list"), undefined);
});
