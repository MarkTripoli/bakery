import { assert, assertEquals } from "@std/assert";
import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgDatabase } from "../../packages/persistence/src/postgres.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";

// #287: the authority used to refuse a session-only action only when an access
// token was in the context. An MCP tool call carries neither a token nor a
// browser session, so it passed on the absence of a token; the refusal now
// depends on where the call came from, not on what is missing.

const action = (sessionOnly: boolean): ActionDefinition =>
  ({
    name: "tasks.list",
    method: HttpMethod.Get,
    path: "/v1/tasks",
    input: contractSchemas.TaskQuery,
    output: contractSchemas["Page<Task>"],
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      sessionOnly,
    },
    handler: () => ({ items: [], nextCursor: null }),
  }) as unknown as ActionDefinition;

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000bb";
const SESSION_ID = "00000000-0000-4000-8000-0000000000ee";
const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000cc";

function context(over: Partial<ActionContext> = {}): ActionContext {
  return {
    // The organization header is what the policy reads; the principal is the
    // shape the authority validates before anything else.
    request: new Request("http://localhost/v1/tasks", {
      headers: { "Bakery-Organization-Id": ORGANIZATION_ID },
    }),
    params: {},
    requestId: "request-1",
    traceId: "trace-1",
    signal: new AbortController().signal,
    principal: {
      principalId: PRINCIPAL_ID,
      principalType: "human",
      displayName: "Ada Lovelace",
    },
    ...over,
  };
}

/** A database that fails loudly: the refusal must happen before any query. */
function untouchedDatabase(): PgDatabase {
  return new Proxy({}, {
    get: () => () => {
      throw new Error("the authority touched the database before refusing");
    },
  }) as unknown as PgDatabase;
}

const sessionOnlyRefusal = async (
  call: ActionContext,
): Promise<string | null> => {
  const runner = new PostgresAuthorityRunner(untouchedDatabase());
  let reached = false;
  try {
    await runner.run(action(true), call, {}, (_ctx) => {
      reached = true;
      return Promise.resolve("ran");
    });
  } catch (error) {
    if (error instanceof StandardError) return `${error.code}`;
    throw error;
  }
  return reached ? null : "not-reached";
};

Deno.test("a session-only action dispatched with an MCP principal is refused (#287)", async () => {
  assertEquals(
    await sessionOnlyRefusal(context({ transport: "mcp" })),
    "SESSION_REQUIRED",
  );
});

Deno.test("the rule asks for a session, so anything without one is refused (#287)", async () => {
  // A browser session is the only thing that satisfies a session-only action;
  // every other arrival shape lacks a session id and is refused before any work.
  for (
    const shape of [
      { transport: "mcp" as const },
      { transport: "http" as const },
      {},
      {
        accessToken: {
          id: "00000000-0000-4000-8000-0000000000dd",
          organizationId: ORGANIZATION_ID,
          scopes: [],
        },
      },
    ]
  ) {
    assertEquals(
      await sessionOnlyRefusal(context(shape)),
      "SESSION_REQUIRED",
      JSON.stringify(shape),
    );
  }
});

Deno.test("a real browser session is allowed through, and reaches its work (#287)", async () => {
  const runner = new PostgresAuthorityRunner(untouchedDatabase());
  const error = await runner.run(
    action(true),
    context({ transport: "http", sessionId: SESSION_ID }),
    {},
    () => Promise.resolve("ran"),
  ).then(() => undefined, (caught: unknown) => caught);
  // It gets as far as the database this test refuses to provide, which is the
  // proof it was not stopped by the session rule.
  assert(
    error instanceof Error && error.message.includes("touched the database"),
    "a browser session was refused a session-only action",
  );
});

Deno.test("a bearer token is still refused for a session-only action (#287)", async () => {
  assertEquals(
    await sessionOnlyRefusal(context({
      transport: "http",
      accessToken: {
        id: "00000000-0000-4000-8000-0000000000dd",
        organizationId: ORGANIZATION_ID,
        scopes: [],
      },
    })),
    "SESSION_REQUIRED",
  );
});

Deno.test("an action that is not session-only is not refused on either transport (#287)", async () => {
  const runner = new PostgresAuthorityRunner(untouchedDatabase());
  for (const transport of ["http", "mcp"] as const) {
    const error = await runner.run(
      action(false),
      context({ transport }),
      {},
      () => Promise.resolve("ran"),
    ).then(() => undefined, (caught: unknown) => caught);
    // It may fail later, on the database this test refuses to provide, but it
    // must not be a session refusal: the flag is what matters, not the transport.
    assert(
      !(error instanceof StandardError) || error.code !== "SESSION_REQUIRED",
      `${transport} refused a non-session action`,
    );
  }
});
