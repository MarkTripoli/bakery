import { assertEquals } from "@std/assert";
import { createMcpActionRegistry } from "../../apps/server/src/modules/mcp/routes.ts";
import { mcpServerImplementedActions } from "../../packages/contracts/src/implemented-actions.ts";

/**
 * The registry must assemble (#434). Registering checks every action against the
 * catalog (its access, its organization-context policy, its input and output), and
 * does it when the application is built, so a mismatch is not a failing request but
 * a server that does not start. Nothing else in the unit lane builds a registry, so
 * this does, with no database: the registry only reads one when an action runs.
 */
Deno.test("the MCP action registry assembles against the catalog", () => {
  const registry = createMcpActionRegistry({} as never, {
    cursorSecret: "cursor-secret",
    secretsKey: undefined,
  });
  const names = registry.list().map((action) => action.name);
  for (const name of mcpServerImplementedActions) {
    assertEquals(names.includes(name), true, name);
  }
});
