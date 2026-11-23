import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  createMcpConnectionCreator,
  createMcpConnectionUpdater,
} from "../../apps/server/src/modules/mcp/connection-commands.ts";
import { compileConfigSchema } from "../../apps/server/src/modules/mcp/server-commands.ts";

/**
 * MCP connections without a database (#434): who may register which scope, what a
 * connection may not carry yet, and that a refusal is made before anything is read
 * or written. The same handlers run against Postgres in the integration file,
 * where sealing, tenancy and the version check actually execute.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const dependencies = { secretsKey: undefined, cursorSecret: "cursor-secret" };

function stand(
  options: {
    role?: string;
    expectedVersion?: number | null;
    agent?: boolean;
  } = {},
) {
  const recorded: string[] = [];
  const transaction = {
    query: (sql: string) => {
      recorded.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const metadata: Record<string, unknown> = {
    operation: "mcpConnections.create",
    idempotencyKey: "k",
    target: "x",
  };
  if (options.expectedVersion !== null) {
    metadata.expectedVersion = options.expectedVersion ?? 1;
  }
  const context = {
    ...(options.agent ? { agentSession: { attemptId: "attempt" } } : {}),
    transaction,
    params: { id: "11111111-1111-4111-8111-111111111111" },
    // A person's own request: attribution reads the principal's type, and a
    // principal with none counts as an agent's.
    principal: { principalId: "p", principalType: "human" },
    requestId: "r",
    traceId: "t",
    authority: {
      organizationId: ORG,
      role: options.role ?? "developer",
      subject: { principalId: "p", principalType: "human" },
    },
    commandMetadata: metadata,
  } as unknown as ActionContext;
  return { recorded, context };
}

const valid = {
  serverId: SERVER,
  label: "Docs",
  config: {},
  enabledCapabilities: [] as string[],
};

async function refusedWith(
  run: () => Promise<unknown>,
  code: string,
  reason?: string,
) {
  const error = await assertRejects(run, StandardError);
  assertEquals(error.code, code);
  if (reason !== undefined) {
    const issues = (error.params as { issues?: { code: string }[] }).issues;
    assertEquals(issues?.[0]?.code, reason);
  }
}

Deno.test("only an Admin may register an organization connection; a developer may register a personal one", async () => {
  const create = createMcpConnectionCreator(dependencies);
  for (const scope of [undefined, "organization" as const]) {
    const { context, recorded } = stand({ role: "developer" });
    await refusedWith(
      () => create(context, { ...valid, ...(scope ? { scope } : {}) } as never),
      "AUTH_FORBIDDEN",
    );
    assertEquals(recorded, []);
  }
  // A personal registration by a developer passes the scope check and goes on to
  // read the server it names, which this stand-in does not have.
  const { context, recorded } = stand({ role: "developer" });
  await refusedWith(
    () => create(context, { ...valid, scope: "personal" } as never),
    "RESOURCE_NOT_FOUND",
  );
  assertEquals(recorded.length, 1);
});

Deno.test("a connection to a remote server carries no worker host, no integration connection and no tools yet", async () => {
  const create = createMcpConnectionCreator(dependencies);
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "an integration connection",
      { integrationConnectionId: SERVER },
      "integration_connection_not_supported_yet",
    ],
    [
      "enabled tools",
      { enabledCapabilities: ["search"] },
      "capabilities_need_discovery",
    ],
  ];
  for (const [name, extra, reason] of cases) {
    const { context, recorded } = stand({ role: "admin" });
    await refusedWith(
      () => create(context, { ...valid, ...extra } as never),
      "UNPROCESSABLE",
      reason,
    );
    assertEquals(recorded, [], `${name} reached the database`);
  }
});

Deno.test("an agent's connection is a personal draft: no secret, no organization scope, before anything is written", async () => {
  const create = createMcpConnectionCreator(dependencies);
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "a secret",
      { scope: "personal", secret: "sk-never-in-context" },
      "agent_connection_secret_stays_with_people",
    ],
    [
      "an organization scope",
      { scope: "organization" },
      "agent_connection_draft_is_personal",
    ],
  ];
  for (const [name, extra, reason] of cases) {
    const { context, recorded } = stand({ role: "admin", agent: true });
    await refusedWith(
      () => create(context, { ...valid, ...extra } as never),
      "UNPROCESSABLE",
      reason,
    );
    assertEquals(recorded, [], `${name} reached the database`);
  }
});

Deno.test("an update needs its version, names something to change, and never sets degraded", async () => {
  const update = createMcpConnectionUpdater(dependencies);
  {
    const { context, recorded } = stand({
      role: "admin",
      expectedVersion: null,
    });
    await refusedWith(
      () => update(context, { label: "x" }),
      "PRECONDITION_REQUIRED",
    );
    assertEquals(recorded, []);
  }
  {
    const { context, recorded } = stand({ role: "admin" });
    await refusedWith(
      () => update(context, {}),
      "UNPROCESSABLE",
      "mcp_connection_update_empty",
    );
    assertEquals(recorded, []);
  }
  {
    const { context, recorded } = stand({ role: "admin" });
    await refusedWith(
      () => update(context, { status: "degraded" }),
      "UNPROCESSABLE",
      "status_not_settable",
    );
    assertEquals(recorded, []);
  }
});

Deno.test("a config schema is enforced when it can be, and refused when it cannot", () => {
  const schema = compileConfigSchema({
    type: "object",
    properties: {
      region: { type: "string", enum: ["eu", "us"] },
      retries: { type: "integer", minimum: 0, maximum: 5 },
    },
    required: ["region"],
    additionalProperties: false,
  })!;
  assertEquals(schema.safeParse({ region: "eu" }).success, true);
  assertEquals(schema.safeParse({ region: "xx" }).success, false);
  assertEquals(schema.safeParse({ region: "eu", extra: 1 }).success, false);
  assertEquals(schema.safeParse({}).success, false);
  assertEquals(schema.safeParse({ region: "eu", retries: 9 }).success, false);
  // Not an object schema, or one that would have to be fetched: refused.
  assertEquals(compileConfigSchema([]), null);
  assertEquals(compileConfigSchema("object"), null);
  assertEquals(compileConfigSchema(null), null);
  assertEquals(
    compileConfigSchema({
      type: "object",
      properties: { a: { $ref: "https://evil.example/schema.json" } },
    }),
    null,
  );
  assertEquals(
    compileConfigSchema({ type: "object", $ref: "http://x.example/s" }),
    null,
  );
});

/** A transaction that answers the server and host reads of a connection create. */
function placementStand(
  server: { transport: string; required_capabilities: string[] },
  host: { capabilities: string[] } | null,
) {
  const { context } = stand({ role: "admin" });
  const statements: { sql: string; values: unknown[] }[] = [];
  (context as unknown as { transaction: unknown }).transaction = {
    query: (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes("from bakery.mcp_servers")) {
        return Promise.resolve({
          rows: [{
            enabled: true,
            config_schema: { type: "object" },
            ...server,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("from bakery.worker_hosts")) {
        return Promise.resolve({
          rows: host ? [host] : [],
          rowCount: host ? 1 : 0,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { context, statements };
}

Deno.test("a local stdio connection is placed on one host of the organization that meets the server's needs (#441)", async () => {
  const create = createMcpConnectionCreator(dependencies);
  const HOST = "55555555-5555-4555-8555-555555555555";
  const stdio = { transport: "stdio", required_capabilities: ["mcp-files"] };
  const cases: [
    string,
    { transport: string; required_capabilities: string[] },
    { capabilities: string[] } | null,
    Record<string, unknown>,
    string,
  ][] = [
    [
      "a remote server with a host",
      { transport: "streamable_http", required_capabilities: [] },
      null,
      { workerHostId: HOST },
      "worker_host_not_for_remote",
    ],
    ["a stdio server with no host", stdio, null, {}, "worker_host_required"],
    [
      "a host of another organization",
      stdio,
      null,
      { workerHostId: HOST },
      "worker_host_unknown",
    ],
    [
      "a host without the capability",
      stdio,
      { capabilities: ["git"] },
      { workerHostId: HOST },
      "worker_host_lacks_capabilities",
    ],
  ];
  for (const [name, server, host, extra, reason] of cases) {
    const { context, statements } = placementStand(server, host);
    await refusedWith(
      () => create(context, { ...valid, ...extra } as never),
      "UNPROCESSABLE",
      reason,
    );
    assertEquals(
      statements.filter((s) => s.sql.includes("insert into")).length,
      0,
      name,
    );
  }
  // A host that has it: the connection row names the host.
  const { context, statements } = placementStand(stdio, {
    capabilities: ["git", "mcp-files"],
  });
  await create(context, { ...valid, workerHostId: HOST } as never).catch(
    () => undefined, // the stand has no row to read back; the insert is what counts
  );
  const insert = statements.find((s) =>
    s.sql.includes("insert into bakery.mcp_connections")
  );
  assertEquals(insert?.values.at(-1), HOST);
});
