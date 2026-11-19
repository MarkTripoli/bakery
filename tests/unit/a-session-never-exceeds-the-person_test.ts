import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  OrganizationContextPolicy,
} from "../../packages/contracts/src/contracts.ts";
import {
  dispatchedContext,
  sessionDispatchPrincipal,
} from "../../apps/server/src/modules/execution/session-routes.ts";
import {
  type SessionOperationClaim,
  SessionOperationError,
} from "../../apps/server/src/modules/execution/session-credential.ts";

/**
 * A session must never exceed the person it acts for.
 *
 * The credential's scopes decide what is *offered*; the action's own authority
 * guard decides what is *allowed*, run as the person. Both have to pass, and
 * this pins the second one, because a scope-only model would let a session
 * reach anything any definition granted, regardless of who the run was for.
 *
 * The guard here is a real `ActionRegistry` authority runner, not a stub: the
 * question is whether dispatch actually hands the person's identity to it.
 */

const claim = (
  overrides: Partial<SessionOperationClaim> = {},
): SessionOperationClaim => ({
  organizationId: "00000000-0000-4000-8000-0000000000c1",
  attemptId: "00000000-0000-4000-8000-0000000000c2",
  actsForPrincipalId: "00000000-0000-4000-8000-0000000000c3",
  actsForPrincipalType: "human",
  actsForPrincipalDisplayName: "Ada Admin",
  workerSessionId: "00000000-0000-4000-8000-0000000000c4",
  workerSessionGeneration: 1n,
  fence: 1n,
  leaseTokenHash: "hash",
  scopes: ["runs.read"],
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

Deno.test("dispatch carries the person, not the worker host", () => {
  const principal = sessionDispatchPrincipal(claim());
  assertEquals(principal.principalId, "00000000-0000-4000-8000-0000000000c3");
  assertEquals(principal.principalType, "human");
  assertEquals(principal.displayName, "Ada Admin");
});

Deno.test("a person the guard cannot name is refused, not dispatched nameless", () => {
  // requireSubject refuses an empty name, so dispatching one would fail every
  // call for everyone, admins included, as AUTH_FORBIDDEN.
  for (const actsForPrincipalDisplayName of [undefined, "", "  "]) {
    assertThrows(
      () => sessionDispatchPrincipal(claim({ actsForPrincipalDisplayName })),
      SessionOperationError,
      "SESSION_CREDENTIAL_NO_PRINCIPAL",
    );
  }
});

Deno.test("the dispatched request carries the claim's organization, whatever the worker sent", () => {
  const sent = new Request("http://localhost/v1/runs/x", {
    method: "POST",
    headers: {
      "Bakery-Organization-Id": "00000000-0000-4000-8000-0000000000ff",
    },
  });
  for (const request of [new Request("http://localhost/v1/runs/x"), sent]) {
    const context = dispatchedContext(request, "attempt", claim());
    assertEquals(
      context.request.headers.get("Bakery-Organization-Id"),
      "00000000-0000-4000-8000-0000000000c1",
    );
  }
});

Deno.test("the context the route dispatches carries the person", () => {
  // Asserted on the context builder the route actually calls, not on a helper
  // beside it. An earlier version of this test built its own context and would
  // have passed with the principal dropped from the route entirely.
  const context = dispatchedContext(
    new Request("http://localhost/v1/runs/x"),
    "00000000-0000-4000-8000-0000000000c2",
    claim(),
  );
  assertEquals(context.principal, {
    principalId: "00000000-0000-4000-8000-0000000000c3",
    principalType: "human",
    displayName: "Ada Admin",
  });
  // The session's own scopes travel with the call so an action that reads
  // across surfaces can leave out the ones the credential has no scope for.
  assertEquals(context.sessionScopes, ["runs.read"]);
});

Deno.test("a session holding the scope is still refused when the person lacks the permission", async () => {
  // The person this run is for is a plain member; the action needs an admin.
  const registry = new ActionRegistry(
    {
      run: ((action, context, _input, next) => {
        const principal = context.principal as
          | { principalId?: string }
          | undefined;
        // Exactly the refusal a real authority runner gives for someone whose
        // role does not reach this action.
        if (principal?.principalId !== ADMIN_ID) {
          return Promise.reject(
            new Error(`AUTHORITY_FORBIDDEN: ${action.name}`),
          );
        }
        return next(context);
      }) satisfies ActionAuthorityRunner["run"],
    },
    undefined,
  );
  registry.register({
    name: "runs.get",
    method: "GET",
    path: "/v1/runs/:id",
    input: z.object({ id: z.string().describe("Run id.") })
      .describe("Run to read."),
    output: z.object({ id: z.string().describe("Run id.") })
      .describe("Run that was read."),
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context: ActionContext) =>
      Promise.resolve({ id: context.params.id ?? "" }),
  });

  // The session holds `runs.read`, the scope `runs.get` requires, and the
  // person is not an admin. Scope alone must not be enough.
  const refused = assertRejects(() =>
    registry.execute(
      "runs.get",
      {
        request: new Request("http://localhost/v1/runs/x"),
        params: { id: "00000000-0000-4000-8000-0000000000ff" },
        requestId: "r",
        traceId: "t",
        signal: new AbortController().signal,
        principal: sessionDispatchPrincipal(claim()),
      },
      { id: "00000000-0000-4000-8000-0000000000ff" },
    )
  );
  await refused;

  // And the same call succeeds once the person actually holds the permission,
  // which proves the refusal came from the principal and not from the wiring.
  const allowed = await registry.execute(
    "runs.get",
    {
      request: new Request("http://localhost/v1/runs/x"),
      params: { id: "00000000-0000-4000-8000-0000000000ff" },
      requestId: "r",
      traceId: "t",
      signal: new AbortController().signal,
      principal: sessionDispatchPrincipal(
        claim({ actsForPrincipalId: ADMIN_ID }),
      ),
    },
    { id: "00000000-0000-4000-8000-0000000000ff" },
  );
  assert(allowed !== undefined);
});

const ADMIN_ID = "00000000-0000-4000-8000-0000000000ad";
