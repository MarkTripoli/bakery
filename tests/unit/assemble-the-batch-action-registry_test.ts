import { assert, assertEquals } from "@std/assert";
import { authorizeOrganizationAction } from "../../apps/server/src/modules/auth/application/authorize.ts";
import { createBatchActionRegistry } from "../../apps/server/src/modules/work/batch-routes.ts";
import { batchImplementedActions } from "../../packages/contracts/src/implemented-actions.ts";

/**
 * The registry must assemble (#58). Registering checks every action against the
 * catalog (its access, its organization-context policy, its input and output) when
 * the application is built, so a mismatch is not a failing request but a server that
 * does not start. Nothing else in the unit lane builds a registry, so this does, with
 * no database: the registry only reads one when an action runs.
 */
Deno.test("the batch action registry assembles against the catalog", () => {
  const registry = createBatchActionRegistry({} as never, {
    cursorSecret: "cursor-secret",
    budget: undefined,
  });
  const names = registry.list().map((action) => action.name);
  for (const name of batchImplementedActions) {
    assertEquals(names.includes(name), true, name);
  }
  assertEquals(names.length, batchImplementedActions.length);
});

/**
 * Every action must be authorizable by someone who is meant to reach it (#58). The
 * authority runner refuses an access level it does not know unless the action carries
 * its own guard, and refuses it for everyone, an Admin included. A registry can
 * assemble and still deny all callers, so this asks the real check, as an Admin, of
 * every action: none may be refused for want of a guard.
 */
Deno.test("an Admin is not refused for want of an authorization guard on any batch action", () => {
  const registry = createBatchActionRegistry({} as never, {
    cursorSecret: "cursor-secret",
    budget: undefined,
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
