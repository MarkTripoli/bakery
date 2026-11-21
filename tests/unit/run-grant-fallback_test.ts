import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { ActionDefinition } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { authorizeWithBindings } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { OrganizationActor } from "../../apps/server/src/modules/auth/application/authority.ts";

/**
 * A run grant is the last fallback when the role and the bindings refuse. It
 * widens a permission miss only, like the other fallbacks: any other denial is
 * the real answer, and the grant is not even looked up.
 */

const action = {
  name: "runs.get",
  policy: { type: "query", access: "Organization member" },
} as unknown as ActionDefinition;

function guest(tokenScopes?: string[]): OrganizationActor {
  return {
    subject: {
      principalId: crypto.randomUUID(),
      principalType: "human",
      displayName: "Grace Guest",
    },
    organizationId: crypto.randomUUID(),
    role: "guest",
    capabilities: [],
    ...(tokenScopes ? { tokenScopes } : {}),
  } as unknown as OrganizationActor;
}

const noTarget = () => Promise.resolve(undefined);

Deno.test("a permission miss is widened by a live run grant", async () => {
  const actor = guest();
  let asked = 0;
  const permitted = await authorizeWithBindings(action, actor, noTarget, () => {
    asked += 1;
    return Promise.resolve(true);
  });
  assertStrictEquals(permitted, actor);
  assertEquals(asked, 1);
});

Deno.test("without a grant the original refusal stands", async () => {
  const refused = await assertRejects(
    () =>
      authorizeWithBindings(
        action,
        guest(),
        noTarget,
        () => Promise.resolve(false),
      ),
    StandardError,
  );
  assertEquals((refused as StandardError).code, "RESOURCE_NOT_FOUND");
});

Deno.test("a denial that is not a permission miss is passed on and no grant is looked up", async () => {
  const scopeDenied = new StandardError({ code: "INSUFFICIENT_SCOPE" });
  let asked = 0;
  const actor = {
    ...guest(["bakery:read"]),
    bindings: [{
      resourceType: "repository",
      resourceId: crypto.randomUUID(),
      role: "editor",
    }],
  } as unknown as OrganizationActor;
  const refused = await assertRejects(
    () =>
      authorizeWithBindings(
        action,
        actor,
        () => Promise.reject(scopeDenied),
        () => {
          asked += 1;
          return Promise.resolve(true);
        },
      ),
  );
  // The next denial added to the role and binding path is the real answer; a
  // run grant never overrides it.
  assertStrictEquals(refused, scopeDenied);
  assertEquals(asked, 0);
});
