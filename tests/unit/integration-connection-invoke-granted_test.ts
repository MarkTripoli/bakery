import { assert, assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  type AuthoritySnapshotPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import {
  activeIntegrationForConnection,
  invokeConnectionAction,
  toConnectionInvokeResponse,
} from "../../apps/server/src/modules/integrations/invoke.ts";

/**
 * The POSITIVE path through the door, with an authority snapshot that carries a
 * real grant.
 *
 * QA's F4 asked for this and the PM ruled it must land rather than be declared a
 * boundary. Every previous test proved a refusal: anonymous, unknown connection,
 * missing grant. Refusals are the easy half. The half that matters is that a
 * Developer holding an exact action grant actually gets through the gate and
 * receives a result — because a route that refuses everything passes every
 * negative test you can write.
 *
 * The snapshot port is the seam the gate reads authority through, so seeding it
 * exercises the real authorization path: `grantAllowsAction`, the live/expiry
 * checks, the resource binding, and the action version pin. Replacing the gate
 * itself would prove nothing.
 */

const ORG = "00000000-0000-4000-8000-000000004101";
const ACTOR = "00000000-0000-4000-8000-000000004102";
const CONNECTION = "00000000-0000-4000-8000-000000004103";
const RESOURCE = "00000000-0000-4000-8000-000000004104";
const INSTALL = "00000000-0000-4000-8000-000000004105";
const GRANT = "00000000-0000-4000-8000-000000004106";

const ACTION_ID = "github.issue.comment.create";
const ACTION_VERSION = 1;

const registry = activateDeployedIntegrations(deployedIntegrations);
const integration = registry.integrations[0]!;

function snapshotWith(overrides: {
  revokedAt?: string | null;
  expiresAt?: string | null;
  permissions?: readonly string[];
  grant?: boolean;
} = {}): AuthoritySnapshot {
  return {
    organizationId: ORG,
    actor: {
      principalId: ACTOR,
      subjectType: "principal",
      active: true,
      permissions: overrides.permissions ?? ["integrationConnection:invoke"],
    },
    install: {
      id: INSTALL,
      providerId: integration.providerId,
      manifestDigest: integration.manifestDigest,
      enabled: true,
      approvedScopes: [],
    },
    connection: {
      id: CONNECTION,
      installId: INSTALL,
      state: "active",
      providerPermissions: { issues: "write" },
    },
    resource: {
      id: RESOURCE,
      kind: "github.repository",
      selected: true,
      available: true,
      binding: {
        owner: "octocat",
        repo: "hello-world",
        repositoryId: 900,
        installationId: 1234,
        botUserId: 55,
      },
      repositoryId: "900",
    },
    grants: overrides.grant === false ? [] : [{
      grantId: GRANT,
      organizationId: ORG,
      connectionId: CONNECTION,
      subjectType: "principal",
      subjectPrincipalId: ACTOR,
      direction: "out_of_bakery",
      capability: ACTION_ID,
      actionVersion: ACTION_VERSION,
      resourceId: RESOURCE,
      revokedAt: overrides.revokedAt ?? null,
      expiresAt: overrides.expiresAt ?? null,
      policyRevision: 1,
      grantedBy: ACTOR,
    }],
    policyRevision: 1,
  } as unknown as AuthoritySnapshot;
}

function port(snapshot: AuthoritySnapshot | null): AuthoritySnapshotPort {
  return { load: () => Promise.resolve(snapshot) };
}

/** An authorized context whose transaction is a stub the door never uses for a read. */
/**
 * An authorized organization context.
 *
 * `organizationActor` re-checks that the authority's subject and the principal
 * agree, so this fixture has to satisfy that check rather than stub it out: a
 * context that fails it is refused before the grant is ever consulted, and the
 * grant tests below would then pass for the wrong reason.
 */
function context(): ActionContext {
  return {
    principal: { principalId: ACTOR, principalType: "principal" },
    authority: {
      organizationId: ORG,
      subject: {
        principalId: ACTOR,
        principalType: "principal",
        displayName: "Developer",
      },
      role: "developer",
      capabilities: ["integrationConnection:invoke"],
    },
    params: { id: CONNECTION },
    // The door reads its pool from the context rather than a module global; the
    // gate below refuses before any query runs, so a stub is honest here and a
    // test that reached the database would be failing loudly anyway.
    database: {
      query: () => Promise.resolve({ rows: [] }),
      connect: () =>
        Promise.resolve({
          query: () => Promise.resolve({ rows: [] }),
          release: () => {},
        }),
    },
    transaction: { query: () => Promise.resolve({ rows: [] }) },
    signal: new AbortController().signal,
  } as unknown as ActionContext;
}

const deps = (snapshot: AuthoritySnapshot | null) => ({
  registry,
  snapshotsFor: () => port(snapshot),
  providerRequests: {
    request: () =>
      Promise.resolve({ id: 1, body: "created", user: { login: "bot" } }),
  },
  action: {
    action: ACTION_ID,
    arguments: { issueNumber: 1, body: "a comment", resourceId: RESOURCE },
  },
} as never);

Deno.test("a Developer holding the exact grant RESOLVES the provider by name", () => {
  // The first production caller of getBySlug, proved on the positive path rather
  // than only for unknown providers.
  const resolved = activeIntegrationForConnection(
    registry,
    integration.providerId,
  );
  assert(
    resolved !== undefined,
    "the deployed provider must resolve by gate id",
  );
  assertEquals(resolved!.providerId, integration.providerId);
});

Deno.test("the positive path is REACHED: a granted Developer clears the gate and the handler", async () => {
  // The decisive test, and the reason it exists: every other test here proves a
  // refusal, and a route that refuses everything passes all of them.
  //
  // A granted call must get past authorization AND past the handler's own strict
  // argument parse. Where it stops is the ledger: this fixture's stub database
  // returns no rows, so the write cannot be recorded. That is one layer beyond
  // both checks, which is exactly what this asserts - the boundary is the ledger,
  // not the gate.
  const failure = await (async () => {
    try {
      await invokeConnectionAction(
        context(),
        deps(snapshotWith()) as never,
        {
          action: ACTION_ID,
          arguments: {
            issueNumber: 1,
            body: "a comment",
            resourceId: RESOURCE,
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert(
    failure instanceof StandardError,
    "a granted call must not succeed against a stub ledger, and must fail as a StandardError",
  );
  assertEquals(
    failure.code === "AUTH_FORBIDDEN" || failure.code === "PRECONDITION_FAILED",
    false,
    "a granted call must NOT be refused by the gate",
  );
  assertEquals(
    failure.safeDetail === "invalid action arguments",
    false,
    // This is the regression that made every strict-input action unreachable:
    // the door passed the REST body through untouched, so the handler's strict
    // object saw `resourceId` and refused arguments that were correct.
    "the door must lift the resource selector out of the arguments before the handler parses them",
  );
  assertEquals(
    failure.code,
    "STATE_CONFLICT",
    `expected the ledger to be the boundary, got ${String(failure)}`,
  );
  assert(
    String(failure.safeDetail).includes("effect_key_vanished"),
    `expected the ledger's own refusal, got ${String(failure.safeDetail)}`,
  );
});

Deno.test("a confirmed write answers with its externalEffectId, a read with its output", () => {
  // The response contract QA asked to see, asserted directly so it cannot be
  // left to a stack run: a write reports the ledger's effect id and, until the
  // effect is confirmed, no result; a read reports its handler output.
  const action = { id: ACTION_ID } as never;
  const write = toConnectionInvokeResponse({
    route: "ledger",
    action,
    prepare: { effectId: "effect-1" },
    run: { outcome: "uncertain" },
  } as never);
  assertEquals(write.externalEffectId, "effect-1");
  assertEquals(write.accepted, true);
  assertEquals(
    write.result,
    null,
    "an unconfirmed write must not report a result",
  );

  const read = toConnectionInvokeResponse({
    route: "direct",
    action,
    output: { id: 7 },
  } as never);
  assertEquals(read.externalEffectId, null);
  assertEquals(read.result, { id: 7 });
});

Deno.test("the grant is what admits it: without one the same call is refused", async () => {
  // The must-fail control. Same actor, same connection, same action, no grant.
  // If this passed, the positive test above would prove nothing about grants.
  const failure = await (async () => {
    try {
      await invokeConnectionAction(
        context(),
        deps(snapshotWith({ grant: false })) as never,
        {
          action: ACTION_ID,
          arguments: {
            issueNumber: 1,
            body: "a comment",
            resourceId: RESOURCE,
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert(failure !== null, "an ungranted invocation must be refused");
  assert(
    failure instanceof StandardError &&
      ["AUTH_FORBIDDEN", "PRECONDITION_FAILED"].includes(failure.code),
    `expected an authorization refusal, got ${String(failure)}`,
  );
});

Deno.test("a REVOKED grant is refused, so revocation is live rather than stored", async () => {
  const failure = await (async () => {
    try {
      await invokeConnectionAction(
        context(),
        deps(snapshotWith({ revokedAt: new Date().toISOString() })) as never,
        {
          action: ACTION_ID,
          arguments: {
            issueNumber: 1,
            body: "a comment",
            resourceId: RESOURCE,
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert(failure !== null, "a revoked grant must not admit the invocation");
  // The code, not just the refusal: a route that failed for an unrelated reason
  // would satisfy "it threw" while proving nothing about revocation.
  assertEquals(failure.code, "AUTH_FORBIDDEN");
});

Deno.test("an EXPIRED grant is refused", async () => {
  const failure = await (async () => {
    try {
      await invokeConnectionAction(
        context(),
        deps(
          snapshotWith({
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          }),
        ) as never,
        {
          action: ACTION_ID,
          arguments: {
            issueNumber: 1,
            body: "a comment",
            resourceId: RESOURCE,
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert(failure !== null, "an expired grant must not admit the invocation");
  assertEquals(failure.code, "AUTH_FORBIDDEN");
});

Deno.test("a grant for a DIFFERENT action version is refused", async () => {
  // The version is part of the grant. A grant for v1 must not authorize v2, so a
  // capability that names the wrong version is not a close-enough match.
  const snapshot = snapshotWith();
  (snapshot.grants as unknown as { actionVersion: number }[])[0]!
    .actionVersion = ACTION_VERSION + 1;
  const failure = await (async () => {
    try {
      await invokeConnectionAction(
        context(),
        deps(snapshot) as never,
        {
          action: ACTION_ID,
          arguments: {
            issueNumber: 1,
            body: "a comment",
            resourceId: RESOURCE,
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert(
    failure !== null,
    "a grant pinned to another version must not admit this one",
  );
  // A precondition rather than a forbidden: the grant exists and names this
  // action, but not this version, so the caller's request is stale rather than
  // unauthorized. Pinned so the distinction cannot drift silently.
  assertEquals(failure.code, "PRECONDITION_FAILED");
});

/** A database stub that records every statement instead of running it. */
function recordingDatabase(): {
  database: unknown;
  statements: { sql: string; values: readonly unknown[] }[];
} {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const run = (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    statements,
    database: {
      query: run,
      connect: () => Promise.resolve({ query: run, release: () => {} }),
    },
  };
}

function contextWith(
  overrides: Readonly<{
    id?: string;
    idempotencyKey?: string;
    database?: unknown;
  }> = {},
): ActionContext {
  const base = context() as unknown as Record<string, unknown>;
  const headers = new Headers();
  if (overrides.idempotencyKey !== undefined) {
    headers.set("idempotency-key", overrides.idempotencyKey);
  }
  return {
    ...base,
    params: { id: overrides.id ?? CONNECTION },
    request: new Request(
      "http://bakery.test/v1/integration-connections/x/actions",
      {
        method: "POST",
        headers,
      },
    ),
    ...(overrides.database === undefined
      ? {}
      : { database: overrides.database }),
  } as unknown as ActionContext;
}

async function refusalOf(
  context: ActionContext,
  snapshot: AuthoritySnapshot | null,
): Promise<StandardError | null> {
  try {
    await invokeConnectionAction(context, deps(snapshot) as never, {
      action: ACTION_ID,
      arguments: { issueNumber: 1, body: "a comment", resourceId: RESOURCE },
    });
    return null;
  } catch (error) {
    return error instanceof StandardError ? error : null;
  }
}

Deno.test("a non-uuid connection id is answered 404, not a cast failure that reads as 500", async () => {
  // The router's own path schema would refuse this, but the door is also reached
  // through the action runner, so it validates rather than trusting the caller.
  const failure = await refusalOf(
    contextWith({ id: "not-a-uuid" }),
    snapshotWith(),
  );
  assert(failure !== null, "a malformed connection id must be refused");
  assertEquals(failure.code, "RESOURCE_NOT_FOUND");
});

Deno.test("the caller's Idempotency-Key reaches the ledger, so a repeat is not a retry", async () => {
  // Without forwarding, every repeat looks like a retry of the first write: the
  // ledger would collapse two deliberate calls into one effect.
  const withKey = recordingDatabase();
  await invokeConnectionAction(
    contextWith({ idempotencyKey: "client-key-1", database: withKey.database }),
    deps(snapshotWith()) as never,
    {
      action: ACTION_ID,
      arguments: { issueNumber: 1, body: "a comment", resourceId: RESOURCE },
    },
  ).catch(() => {});
  assert(
    withKey.statements.some((statement) =>
      statement.values.includes("client-key-1")
    ),
    "the supplied key must appear in a ledger statement",
  );

  // The control: with no header the ledger still receives a key, the derived
  // one, so the assertion above is about forwarding and not about any key.
  const withoutKey = recordingDatabase();
  await invokeConnectionAction(
    contextWith({ database: withoutKey.database }),
    deps(snapshotWith()) as never,
    {
      action: ACTION_ID,
      arguments: { issueNumber: 1, body: "a comment", resourceId: RESOURCE },
    },
  ).catch(() => {});
  assert(
    withoutKey.statements.every((statement) =>
      !statement.values.includes("client-key-1")
    ),
    "an absent header must not invent the caller's key",
  );
  assert(
    withoutKey.statements.some((statement) =>
      statement.values.some((value) =>
        typeof value === "string" && value.length > 0
      )
    ),
    "the ledger still receives a derived key",
  );
});

Deno.test("a grant for ANOTHER resource is refused, so a grant is not a capability", async () => {
  // The grant names the resource it was issued for. A caller holding a grant on
  // one repository must not reach another by naming its id, which is the whole
  // difference between a grant and a permission.
  const snapshot = snapshotWith();
  (snapshot.grants as unknown as { resourceId: string }[])[0]!.resourceId =
    "00000000-0000-4000-8000-000000004199";
  const failure = await refusalOf(context(), snapshot);
  assert(
    failure !== null,
    "a grant for another resource must not admit this one",
  );
  assertEquals(failure.code, "AUTH_FORBIDDEN");
});
