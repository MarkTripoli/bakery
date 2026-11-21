import { assert, assertEquals } from "@std/assert";
import { authorizeOrganizationAction } from "../../apps/server/src/modules/auth/application/authorize.ts";
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

/**
 * Every action must be authorizable by someone who is meant to reach it (#434). The
 * authority runner refuses an access level it does not know unless the action carries
 * its own guard, and refuses it for everyone, an Admin included. A registry can
 * assemble and still deny all callers, so this asks the real check, as an Admin, of
 * every action: none may be refused for want of a guard.
 */
Deno.test("an Admin is not refused for want of an authorization guard on any MCP action", () => {
  const registry = createMcpActionRegistry({} as never, {
    cursorSecret: "cursor-secret",
    secretsKey: undefined,
  });
  const admin = {
    subject: { principalId: "p", principalType: "human" },
    organizationId: "11111111-1111-4111-8111-111111111111",
    role: "admin",
    capabilities: [],
  };
  for (const action of registry.list()) {
    try {
      authorizeOrganizationAction(action, admin as never);
    } catch (error) {
      assert(false, `${action.name}: ${String(error)}`);
    }
  }
});
