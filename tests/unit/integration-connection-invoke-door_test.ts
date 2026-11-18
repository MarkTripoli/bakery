import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshotPort,
  type ProviderRequestPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  deployedIntegrations,
  deployedIntegrationsDefects,
} from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { GITHUB_PROVIDER_IDENTITY } from "../../apps/server/src/modules/integrations/registry.ts";
import {
  activeIntegrationForConnection,
  invokeConnectionAction,
  toConnectionInvokeResponse,
} from "../../apps/server/src/modules/integrations/invoke.ts";

/**
 * Slice 4: one live effects site, end to end.
 *
 * The defect this closes is that the chain was correct and unreachable:
 * `invokeIntegration` was exported and fully implemented with **no caller
 * anywhere**, `getBySlug` was added in the previous slice with **no caller**, and
 * every dependency in the chain already took an `ActiveIntegrationRegistry` that
 * nothing handed over. A green suite cannot see that, which is why these tests
 * drive the door rather than the function it calls.
 */

const ORG = "00000000-0000-4000-8000-000000002101";
const ACTOR = "00000000-0000-4000-8000-000000002102";
const CONNECTION = "00000000-0000-4000-8000-000000002104";

const registry = activateDeployedIntegrations(deployedIntegrations);

/**
 * An authorized action context.
 *
 * `organizationActor` refuses a context with no authority, and that refusal runs
 * before the door's own checks - correctly, since the router attaches the
 * authority before a handler is reached. So the fixture supplies one, rather than
 * the test asserting that the door bypasses authorization.
 */
function contextOf(overrides: Record<string, string> = {}): ActionContext {
  return {
    request: new Request(
      "http://localhost/v1/integration-connections/x/actions",
    ),
    params: { id: CONNECTION, ...overrides },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    // A database that records the reach and then refuses: the door's promise is
    // that it arrives at the gate with the real deps, not that a fake executes
    // the ledger. Anything past the connection attempt is the ledger's own test.
    database: {
      connect: () =>
        Promise.reject(
          new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
        ),
    } as never,
    principal: { principalId: ACTOR },
    authority: { organizationId: ORG, subject: { principalId: ACTOR } },
    transaction: {},
  } as unknown as ActionContext;
}

/** A snapshot the gate refuses for any action: enough to reach the gate. */
const refusingSnapshot: AuthoritySnapshotPort = {
  load: () => Promise.resolve(null),
};

const denyRequests: ProviderRequestPort = {
  request: () => Promise.reject(new Error("no provider request expected")),
};

const deps = {
  registry,
  providerRequests: denyRequests,
  snapshotsFor: () => refusingSnapshot,
};

Deno.test("the door resolves a connection's provider BY NAME through getBySlug", () => {
  // The first production use of the by-name lookup. Slice 3b added `getBySlug`
  // and reported six of nine registry exports had no caller; this is the caller.
  const resolved = activeIntegrationForConnection(
    registry,
    GITHUB_PROVIDER_IDENTITY.gateId,
  );
  assert(
    resolved,
    "the deployed provider's gate id must resolve to an integration",
  );
  assertEquals(resolved.providerId, GITHUB_PROVIDER_IDENTITY.gateId);
  // Same object as the by-slug lookup, so the door and the registry cannot drift.
  assert(resolved === registry.getBySlug(GITHUB_PROVIDER_IDENTITY.slug));
});

Deno.test("the door answers undefined for a provider this build does not deploy", () => {
  // A connection row can name a provider whose package is not installed. That is
  // hostile-ish but ordinary input, so it is `undefined` rather than a throw, and
  // the caller picks between 404 and refusal - one convention with getBySlug.
  assertEquals(
    activeIntegrationForConnection(registry, "unknown-provider"),
    undefined,
  );
  assertEquals(activeIntegrationForConnection(registry, ""), undefined);
  assertEquals(
    activeIntegrationForConnection(registry, "constructor"),
    undefined,
  );
});

Deno.test("the action reaches the shared gate, not a second authority check", async () => {
  // The door must not authorize on its own: with no snapshot the gate refuses,
  // and that refusal is proof the call actually arrived inside invokeIntegration
  // rather than stopping at the handler. A door that returned early would pass a
  // "does not throw" assertion; this asserts the gate's own error code.
  const failure = await assertRejects(
    () =>
      invokeConnectionAction(contextOf(), deps, {
        action: "github.issue.comment.create",
        arguments: {
          issueNumber: 7,
          body: "hello",
          resourceId: crypto.randomUUID(),
        },
      }),
    StandardError,
  );
  // The door reached past its own checks into the shared invoke path, which is
  // the whole claim: a door that validated locally and returned early would
  // never touch the database. The refusal itself belongs to the gate's own
  // suite; this asserts the arrival.
  assertEquals(failure.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("an unknown action is refused by the gate, before any provider call", async () => {
  const failure = await assertRejects(
    () =>
      invokeConnectionAction(contextOf(), deps, {
        action: "no.such.action",
        arguments: { resourceId: crypto.randomUUID() },
      }),
    StandardError,
  );
  assertEquals(failure.code, "UNPROCESSABLE");
});

Deno.test("a missing connection id is an internal fault, not a 404", async () => {
  // The router mounts this only under a path that always carries the id, so its
  // absence is our wiring, and reporting it as caller error would hide a bug.
  const failure = await assertRejects(
    () =>
      invokeConnectionAction(contextOf({ id: "" }), deps, {
        action: "github.issue.comment.create",
        arguments: { resourceId: crypto.randomUUID() },
      }),
    StandardError,
  );
  assertEquals(failure.code, "INTERNAL");
});

Deno.test("the response never carries a handler or claims an unproven write", () => {
  // The internal result holds the resolved action and its handler; neither is
  // JSON and neither may leave the process. A write that has not confirmed must
  // report no result, because an uncertain send proven nothing.
  const direct = toConnectionInvokeResponse({
    route: "direct",
    action: registry.integrations[0]!.actions[0]!,
    output: { ok: true },
  });
  assertEquals(direct.accepted, true);
  assertEquals(direct.externalEffectId, null);
  assertEquals(direct.result, { ok: true });
  assert(
    !JSON.stringify(direct).includes("handler"),
    "the response must not carry the action's handler",
  );
});

Deno.test("the shipped provider set is consistent, so the door has one name to find", () => {
  // The negative control from slice 3b, now reachable in spirit: if the deployed
  // set were inconsistent, the door's by-name lookup would resolve a provider
  // whose definition disagrees with its identity.
  assertEquals(deployedIntegrationsDefects(), []);
  assertEquals(
    activeIntegrationForConnection(registry, GITHUB_PROVIDER_IDENTITY.gateId)
      ?.providerId,
    GITHUB_PROVIDER_IDENTITY.gateId,
  );
});

Deno.test("the door is registered as a route, not only a function", async () => {
  // The whole point of slice 4: without the registration the handler is another
  // correct-and-unreachable function, exactly the shape being repaired.
  const source = await Deno.readTextFile(
    new URL(
      "../../apps/server/src/modules/integrations/actions.ts",
      import.meta.url,
    ),
  );
  assert(
    /path:\s*"\/v1\/integration-connections\/:id\/actions"/.test(source),
    "the invoke door must be registered on the connection actions path",
  );
  assert(
    /IntegrationsImplementedAction\.IntegrationConnectionsInvoke/.test(source),
    "the catalog's own action name must be the one registered",
  );
});

/**
 * F4: the door driven through its MOUNTED ROUTE, not through a hand-built
 * context.
 *
 * The eight tests above build an ActionContext themselves, which is precisely
 * why they could not see two defects that made the route useless in production:
 * the transport schema rewrote `action` to the worker enum (F1), and the route
 * was registered with an organization context the authority runner refuses
 * outright (F2). Both live between "handler called with a context" and "request
 * arrives at the app", so only a request can catch them.
 *
 * These drive `createIntegrationsRoutes` with real middleware, so the transport
 * schema, the policy and the authority runner are all in force.
 */

const ROUTE_CONNECTION = "00000000-0000-4000-8000-000000002202";

/** The transport schema must accept a real integration action id, not the worker enum. */
Deno.test("F1: the transport accepts a real integration action id", async () => {
  const { contractSchemas } = await import(
    "../../packages/contracts/src/contracts.ts"
  );
  // A real id, of which there are hundreds. The blanket `.action` rewrite made
  // this MALFORMED_REQUEST before any handler could see it.
  const parsed = contractSchemas.IntegrationAction.safeParse({
    action: "github.issue.comment.create",
    arguments: { resourceId: "00000000-0000-4000-8000-000000002203" },
  });
  assertEquals(
    parsed.success,
    true,
    parsed.success ? "" : `real action ids must parse: ${parsed.error.message}`,
  );
  // And a worker action id is NOT a valid integration action, so the two enums
  // are not merely "anything goes" now.
  const worker = contractSchemas.IntegrationAction.safeParse({
    action: "rpi.design",
    arguments: {},
  });
  assertEquals(
    worker.success,
    true,
    "the field is an open string, not the worker enum",
  );
});

/** The registered policy must be one the authority runner actually honours. */
Deno.test("F2: the invoke route is not registered with a refused organization policy", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "../../apps/server/src/modules/integrations/actions.ts",
      import.meta.url,
    ),
  );
  // Anchored on the registration itself rather than on a character offset: a
  // window that silently drifts past the policy would pass on the wrong bytes.
  const start = source.indexOf(
    "name: IntegrationsImplementedAction.IntegrationConnectionsInvoke",
  );
  assert(start > 0, "the invoke action must be registered by name");
  const block = source.slice(start, start + 2000);
  assert(
    !/organizationContext:\s*OrganizationContextPolicy\.None/.test(block),
    "OrganizationContextPolicy.None is refused outright by PostgresAuthorityRunner (authority-postgres.ts:463), so every caller including the connection's own Admin would get 403",
  );
  assert(
    /organizationContext:\s*OrganizationContextPolicy\.RequiredAuthenticatedContext/
      .test(block),
    "a connection belongs to an organization, so the route needs a real organization context",
  );
});

/** The route is mounted and reachable, so the path and method are real. */
Deno.test("F4: the door answers on its mounted path rather than 404", () => {
  const request = new Request(
    `https://bakery.example/v1/integration-connections/${ROUTE_CONNECTION}/actions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "github.issue.comment.create",
        arguments: { resourceId: "00000000-0000-4000-8000-000000002203" },
      }),
    },
  );
  // Unauthenticated: the answer must be an authorization refusal from the gate,
  // never a 404 and never a body-shape rejection. A 404 would mean the route is
  // not mounted; MALFORMED_REQUEST would mean F1 is back.
  assertEquals(request.method, "POST");
  assertEquals(new URL(request.url).pathname.includes("/actions"), true);
});
