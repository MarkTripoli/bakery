import { assertEquals } from "@std/assert";
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
  });
  const names = registry.list().map((action) => action.name);
  for (const name of batchImplementedActions) {
    assertEquals(names.includes(name), true, name);
  }
  assertEquals(names.length, batchImplementedActions.length);
});
