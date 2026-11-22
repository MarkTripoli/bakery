import { assert, assertEquals } from "@std/assert";
import { createDeliveryActionRegistry } from "../../apps/server/src/modules/delivery/actions.ts";
import { deliveryImplementedActions } from "../../packages/contracts/src/implemented-actions.ts";

/**
 * The delivery registry is checked against the API catalog when it is built:
 * access, organization context, method and path of every action must agree. A
 * deployment action that drifts from its catalog row fails here, without a
 * database, before any request is served (#43).
 */
Deno.test("the deployment actions are registered exactly as the catalog declares them", () => {
  const unused = () => Promise.reject(new Error("not called by this test"));
  const handlers = new Proxy({}, { get: () => unused }) as never;
  // Building the registry runs assertRegisteredActions against the catalog.
  createDeliveryActionRegistry({} as never, handlers);
  for (
    const name of [
      "deployments.list",
      "deployments.create",
      "deployments.rollback",
    ]
  ) {
    assert(
      (deliveryImplementedActions as readonly string[]).includes(name),
      `${name} is an implemented delivery action`,
    );
  }
  assertEquals(
    deliveryImplementedActions.filter((name) => name.startsWith("deployments."))
      .length,
    3,
  );
});
