import { assert, assertEquals } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { createMcpDiscoverer } from "../../apps/server/src/modules/mcp/connection-discovery.ts";
import type {
  McpHttpRequest,
  McpHttpResult,
  McpTransport,
} from "../../apps/server/src/modules/mcp/discovery-transport.ts";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

/**
 * #434 discovery against a real database, with a scripted server (no network).
 *
 * What only a database can show, and what these pin:
 *
 *  - discovery pins an immutable snapshot and moves only the connection's pointer:
 *    nothing is enabled, an earlier snapshot is never rewritten, and the same
 *    answer twice is one snapshot, even three racing at once;
 *  - the sealed credential is decrypted for the request and for nothing else: it
 *    reaches the server as a bearer token and appears in no snapshot, audit row or
 *    error;
 *  - a failure of any kind writes nothing, not even an audit row;
 *  - tenancy: discovery is an Admin's for an organization connection and the
 *    owner's alone for a personal one, which is absent to everyone else.
 */

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;
type Body = Record<string, unknown>;

const SECRET = "mcp_discovery_canary_token_0123456789";

async function keyFile() {
  const file = await Deno.makeTempFile({ prefix: "bakery-mcp-key-" });
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "mcp-discovery-key-1" };
}

async function send(
  f: Fixture,
  cookie: string,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const headers: Record<string, string> = { ...orgHeader(f.organizationId) };
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;
  const response = await call(f, method, path, cookie, {
    body: options.body,
    headers,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) as Body : {},
  };
}

const tool = (name: string, extra: Body = {}) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

const json = (result: unknown, id: number): McpHttpResult => ({
  kind: "response",
  status: 200,
  contentType: "application/json",
  sessionId: null,
  body: JSON.stringify({ jsonrpc: "2.0", id, result }),
});

/** A server that answers the exchange with these tools, and records what it saw. */
function server(tools: () => unknown[], fail?: () => McpHttpResult | null) {
  const seen: { headers: Record<string, string>; method: unknown }[] = [];
  const transport: McpTransport = (request: McpHttpRequest) => {
    const body = JSON.parse(request.body);
    seen.push({ headers: { ...request.headers }, method: body.method });
    const failure = fail?.();
    if (failure) return Promise.resolve(failure);
    if (body.method === "initialize") {
      return Promise.resolve(json({ protocolVersion: "2026-07-28" }, body.id));
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve({
        kind: "response" as const,
        status: 202,
        contentType: "",
        sessionId: null,
        body: "",
      });
    }
    return Promise.resolve(json({ tools: tools() }, body.id));
  };
  return { transport, seen };
}

function contextFor(
  f: Fixture,
  who: "admin" | "developer",
  transaction: unknown,
  id: string,
): ActionContext {
  const principalId = who === "admin" ? f.adminId : f.developerId!;
  return {
    transaction,
    params: { id },
    principal: { principalId },
    requestId: "request-1",
    traceId: "trace-1",
    authority: {
      organizationId: f.organizationId,
      role: who,
      subject: { principalId, principalType: "human" },
    },
    commandMetadata: {
      operation: "mcpConnections.discover",
      idempotencyKey: crypto.randomUUID(),
      target: id,
    },
  } as unknown as ActionContext;
}

/**
 * A sealed credential belongs to the organization, and the organization's key has no
 * cascade, so the fixture cannot delete the organization while one remains. Removes
 * what these tests wrote, in dependency order: a connection points at its secret and a
 * secret at its active version, so break the links before deleting either.
 */
async function removeMcpSecrets(f: Fixture) {
  const pg = f.pgDatabase;
  const org = f.organizationId;
  await pg.query(
    "delete from bakery.mcp_connections where organization_id = $1",
    [org],
  );
  await pg.query(
    "update bakery.secrets set active_version_id = null where organization_id = $1 and provider = 'mcp'",
    [org],
  );
  await pg.query(
    `delete from bakery.secret_versions where secret_id in
       (select id from bakery.secrets where organization_id = $1 and provider = 'mcp')`,
    [org],
  );
  await pg.query(
    "delete from bakery.secrets where organization_id = $1 and provider = 'mcp'",
    [org],
  );
}

async function withFixture(
  run: (
    f: Fixture,
    secretsKey: { file: string; keyId: string },
  ) => Promise<void>,
) {
  const secretsKey = await keyFile();
  const f = await openInstallationFixture(true, { secretsKey });
  try {
    await run(f, secretsKey);
  } finally {
    try {
      await removeMcpSecrets(f);
      await f.finish();
    } finally {
      await Deno.remove(secretsKey.file);
    }
  }
}

async function enabledServer(f: Fixture): Promise<string> {
  const created = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
    body: {
      slug: `s-${crypto.randomUUID().slice(0, 8)}`,
      name: "Docs",
      transport: "streamable_http",
      endpointTemplate: "https://{tenant}.mcp.example.com/mcp",
      configSchema: { type: "object" },
      requiredCapabilities: [],
      sourceRevision: "v1",
    },
  });
  const id = created.json.id as string;
  assertEquals(
    (await send(f, f.adminCookie, "PATCH", `/v1/mcp-servers/${id}`, {
      body: { enabled: true },
      ifMatch: '"1"',
    })).status,
    200,
  );
  return id;
}

async function makeConnection(
  f: Fixture,
  cookie: string,
  serverId: string,
  overrides: Body = {},
): Promise<string> {
  const made = await send(f, cookie, "POST", "/v1/mcp-connections", {
    body: {
      serverId,
      label: `Docs ${crypto.randomUUID().slice(0, 6)}`,
      config: { tenant: "acme" },
      enabledCapabilities: [],
      ...overrides,
    },
  });
  assert([200, 201].includes(made.status), JSON.stringify(made.json));
  return made.json.id as string;
}

const discoverAs = (
  f: Fixture,
  secretsKey: { file: string; keyId: string },
  transport: McpTransport,
  who: "admin" | "developer",
  id: string,
) =>
  withPgTransaction(
    f.pgDatabase,
    (transaction) =>
      createMcpDiscoverer({ secretsKey, transport })(
        contextFor(f, who, transaction, id),
      ),
  );

const snapshots = async (f: Fixture, id: string) =>
  (await f.pgDatabase.query<{ id: string; digest: string }>(
    `select id, digest from bakery.mcp_capability_snapshots
      where connection_id = $1 order by observed_at, id`,
    [id],
  )).rows;

Deno.test("mcp discovery: it pins an immutable snapshot, sends the sealed credential as a bearer token and records names only", async () => {
  await withFixture(async (f, secretsKey) => {
    const id = await makeConnection(f, f.adminCookie, await enabledServer(f), {
      secret: SECRET,
    });
    const { transport, seen } = server(
      () => [tool("search"), tool("read_page")],
    );
    const snapshot = await discoverAs(f, secretsKey, transport, "admin", id);
    assertEquals(
      (snapshot.manifest as { tools: { name: string }[] }).tools.map((t) =>
        t.name
      ),
      ["read_page", "search"],
    );
    assertEquals(snapshot.protocolVersion, "2026-07-28");
    assertEquals(JSON.stringify(snapshot).includes(SECRET), false);

    // The credential reached the server, decrypted for the request, as a bearer.
    assertEquals(seen.length, 3);
    for (const request of seen) {
      assertEquals(request.headers.authorization, `Bearer ${SECRET}`);
    }

    const connection = (await f.pgDatabase.query(
      `select current_snapshot_id, enabled_capabilities, version
         from bakery.mcp_connections where id = $1`,
      [id],
    )).rows[0];
    assertEquals(connection.current_snapshot_id, snapshot.id);
    // Discovery observes: nothing is enabled.
    assertEquals(connection.enabled_capabilities, []);
    assertEquals(connection.version, 2);

    const audit = (await f.pgDatabase.query<{ details: string }>(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpConnections.discover' and resource_id = $1`,
      [id],
    )).rows;
    assertEquals(audit.length, 1);
    assertEquals(audit[0].details.includes(SECRET), false);
    const details = JSON.parse(audit[0].details);
    assertEquals(details.added, ["read_page", "search"]);
    assertEquals(details.unchanged, false);
    // Never a schema or a description, only names.
    // The tools' descriptions are "<name> tool" and their schemas have an
    // "inputSchema"; neither may appear, only the names under added.
    assertEquals(audit[0].details.includes("search tool"), false);
    assertEquals(audit[0].details.includes("read_page tool"), false);
    assertEquals(audit[0].details.includes("inputSchema"), false);

    // The capabilities read shows the pin, over the real route.
    const read = await send(
      f,
      f.adminCookie,
      "GET",
      `/v1/mcp-connections/${id}/capabilities`,
    );
    assertEquals(read.status, 200);
    assertEquals(read.json.digest, snapshot.digest);
  });
});

Deno.test("mcp discovery: the same answer is one snapshot, a changed one is a new snapshot and the old one stays", async () => {
  await withFixture(async (f, secretsKey) => {
    const id = await makeConnection(f, f.adminCookie, await enabledServer(f));
    let tools: unknown[] = [tool("a"), tool("b")];
    const { transport } = server(() => tools);
    const first = await discoverAs(f, secretsKey, transport, "admin", id);
    const again = await discoverAs(f, secretsKey, transport, "admin", id);
    assertEquals(again.id, first.id);
    assertEquals((await snapshots(f, id)).length, 1);
    // Unchanged: the pointer did not move, so the version did not either.
    assertEquals(
      (await f.pgDatabase.query(
        "select version from bakery.mcp_connections where id = $1",
        [id],
      )).rows[0].version,
      2,
    );

    // A removed tool, an added one and a changed schema.
    tools = [
      tool("a", {
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }),
      tool("c"),
    ];
    const second = await discoverAs(f, secretsKey, transport, "admin", id);
    assert(second.id !== first.id);
    assert(second.digest !== first.digest);
    const rows = await snapshots(f, id);
    assertEquals(rows.length, 2);
    // The earlier snapshot is exactly what it was: a pin on it stays comparable.
    assertEquals(rows[0].id, first.id);
    assertEquals(rows[0].digest, first.digest);
    assertEquals(
      (await f.pgDatabase.query(
        "select current_snapshot_id from bakery.mcp_connections where id = $1",
        [id],
      )).rows[0].current_snapshot_id,
      second.id,
    );
    const details = (await f.pgDatabase.query<{ details: string }>(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpConnections.discover' and resource_id = $1
        order by created_at desc, id desc limit 1`,
      [id],
    )).rows[0].details;
    const change = JSON.parse(details);
    assertEquals(change.added, ["c"]);
    assertEquals(change.removed, ["b"]);
    assertEquals(change.changed, ["a"]);
    assertEquals(change.previousDigest, first.digest);

    // A sequence A, B, A is three observations: the second A is a new snapshot.
    tools = [tool("a"), tool("b")];
    const third = await discoverAs(f, secretsKey, transport, "admin", id);
    assert(third.id !== first.id);
    assertEquals(third.digest, first.digest);
    assertEquals((await snapshots(f, id)).length, 3);
  });
});

Deno.test("mcp discovery: three discoveries at once pin one snapshot", async () => {
  await withFixture(async (f, secretsKey) => {
    const id = await makeConnection(f, f.adminCookie, await enabledServer(f));
    const { transport } = server(() => [tool("a")]);
    const results = await Promise.all(
      [1, 2, 3].map(() => discoverAs(f, secretsKey, transport, "admin", id)),
    );
    assertEquals(new Set(results.map((r) => r.id)).size, 1);
    assertEquals((await snapshots(f, id)).length, 1);
  });
});

Deno.test("mcp discovery: a failure of any kind writes nothing, and names its reason", async () => {
  await withFixture(async (f, secretsKey) => {
    const id = await makeConnection(f, f.adminCookie, await enabledServer(f), {
      secret: SECRET,
    });
    const cases: [string, McpHttpResult, string][] = [
      ["401", {
        kind: "response",
        status: 401,
        contentType: "",
        sessionId: null,
        body: "",
      }, "auth_rejected"],
      ["a timeout", { kind: "timeout" }, "timeout"],
      ["a refused address", { kind: "refused" }, "refused_address"],
    ];
    for (const [name, answer, reason] of cases) {
      const { transport } = server(() => [tool("a")], () => answer);
      let error: unknown;
      try {
        await discoverAs(f, secretsKey, transport, "admin", id);
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof StandardError, name);
      assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", name);
      assertEquals((error.params as { reason: string }).reason, reason, name);
      assertEquals(JSON.stringify(error.params).includes(SECRET), false);
    }
    assertEquals((await snapshots(f, id)).length, 0);
    assertEquals(
      (await f.pgDatabase.query(
        "select current_snapshot_id from bakery.mcp_connections where id = $1",
        [id],
      )).rows[0].current_snapshot_id,
      null,
    );
    assertEquals(
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.audit_events where operation = 'mcpConnections.discover' and resource_id = $1",
        [id],
      )).rows[0].n,
      0,
    );
    // A config that leaves a placeholder unfilled never reaches the network.
    const bare = await makeConnection(
      f,
      f.adminCookie,
      await enabledServer(f),
      {
        config: {},
      },
    );
    const { transport, seen } = server(() => [tool("a")]);
    let missing: unknown;
    try {
      await discoverAs(f, secretsKey, transport, "admin", bare);
    } catch (caught) {
      missing = caught;
    }
    assert(missing instanceof StandardError);
    assertEquals(missing.code, "UNPROCESSABLE");
    assertEquals(seen.length, 0);
  });
});

Deno.test("mcp discovery: an organization connection is the Admin's and a personal one is its owner's alone", async () => {
  await withFixture(async (f, secretsKey) => {
    const serverId = await enabledServer(f);
    const org = await makeConnection(f, f.adminCookie, serverId);
    const mine = await makeConnection(f, f.developerCookie, serverId, {
      scope: "personal",
    });
    const theirs = await makeConnection(f, f.adminCookie, serverId, {
      scope: "personal",
    });
    const { transport } = server(() => [tool("a")]);
    const code = async (who: "admin" | "developer", id: string) => {
      try {
        await discoverAs(f, secretsKey, transport, who, id);
        return "ok";
      } catch (error) {
        return (error as StandardError).code;
      }
    };
    // A member may not discover an organization connection.
    assertEquals(await code("developer", org), "AUTH_FORBIDDEN");
    assertEquals(await code("admin", org), "ok");
    // A personal connection: the owner, and only the owner.
    assertEquals(await code("developer", mine), "ok");
    assertEquals(await code("admin", mine), "RESOURCE_NOT_FOUND");
    assertEquals(await code("admin", theirs), "ok");
    assertEquals(await code("developer", theirs), "RESOURCE_NOT_FOUND");
    // And the pin of someone else's personal connection is absent over the route too.
    assertEquals(
      (await send(
        f,
        f.adminCookie,
        "GET",
        `/v1/mcp-connections/${mine}/capabilities`,
      )).status,
      404,
    );
    assertEquals(
      (await send(
        f,
        f.developerCookie,
        "GET",
        `/v1/mcp-connections/${theirs}/capabilities`,
      )).status,
      404,
    );
    assertEquals(
      (await send(
        f,
        f.developerCookie,
        "GET",
        `/v1/mcp-connections/${mine}/capabilities`,
      )).status,
      200,
    );
    // Nothing was pinned for what was refused.
    assertEquals((await snapshots(f, theirs)).length, 1);
    assertEquals((await snapshots(f, mine)).length, 1);
  });
});

Deno.test("mcp discovery: a connection with nothing pinned has no capabilities, and a revoked or disabled one is not discovered", async () => {
  await withFixture(async (f, secretsKey) => {
    const serverId = await enabledServer(f);
    const id = await makeConnection(f, f.adminCookie, serverId);
    assertEquals(
      (await send(
        f,
        f.adminCookie,
        "GET",
        `/v1/mcp-connections/${id}/capabilities`,
      )).status,
      404,
    );
    const { transport, seen } = server(() => [tool("a")]);
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", `/v1/mcp-connections/${id}`, {
        body: { status: "disabled" },
        ifMatch: '"1"',
      })).status,
      200,
    );
    let error: unknown;
    try {
      await discoverAs(f, secretsKey, transport, "admin", id);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(seen.length, 0);
    // A disabled definition is not called either.
    const live = await makeConnection(f, f.adminCookie, serverId);
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", `/v1/mcp-servers/${serverId}`, {
        body: { enabled: false },
        ifMatch: '"2"',
      })).status,
      200,
    );
    let off: unknown;
    try {
      await discoverAs(f, secretsKey, transport, "admin", live);
    } catch (caught) {
      off = caught;
    }
    assert(off instanceof StandardError);
    assertEquals(off.code, "STATE_CONFLICT");
    assertEquals(seen.length, 0);
  });
});
