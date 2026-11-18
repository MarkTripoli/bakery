import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { ActionDefinition } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { authorizeOwnInboxWrite } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { OrganizationActor } from "../../apps/server/src/modules/auth/application/authority.ts";

/**
 * The own-inbox rule lets a member without notification:write change the
 * read state of their own notifications. It may only ever answer a permission
 * miss: any other refusal (a scope miss, a fault) is the real answer.
 */

const action = { name: "notifications.setRead" } as unknown as ActionDefinition;

function viewer(tokenScopes?: string[]): OrganizationActor {
  return {
    subject: {
      principalId: crypto.randomUUID(),
      principalType: "human",
      displayName: "Vic Viewer",
    },
    organizationId: crypto.randomUUID(),
    role: "viewer",
    capabilities: [],
    ...(tokenScopes ? { tokenScopes } : {}),
  } as unknown as OrganizationActor;
}

Deno.test("a permission miss falls back to the own-inbox rule", () => {
  const actor = viewer();
  for (const code of ["AUTH_FORBIDDEN", "RESOURCE_NOT_FOUND"] as const) {
    assertStrictEquals(
      authorizeOwnInboxWrite(action, actor, new StandardError({ code })),
      actor,
    );
  }
});

Deno.test("a non-permission error is passed on, never swallowed", () => {
  const fault = new Error("AUTHORITY_STORE_UNAVAILABLE");
  const thrown = assertThrows(() =>
    authorizeOwnInboxWrite(action, viewer(), fault)
  );
  assertStrictEquals(thrown, fault);
});

Deno.test("a scope miss stays INSUFFICIENT_SCOPE", () => {
  const scopeMiss = new StandardError({ code: "INSUFFICIENT_SCOPE" });
  const thrown = assertThrows(() =>
    authorizeOwnInboxWrite(action, viewer(["bakery:read"]), scopeMiss)
  );
  assertStrictEquals(thrown, scopeMiss);
  // And a permission miss on a token without the scope is a scope miss too.
  const viaToken = assertThrows(
    () =>
      authorizeOwnInboxWrite(
        action,
        viewer(["bakery:read"]),
        new StandardError({ code: "AUTH_FORBIDDEN" }),
      ),
    StandardError,
  );
  assertEquals((viaToken as StandardError).code, "INSUFFICIENT_SCOPE");
});
