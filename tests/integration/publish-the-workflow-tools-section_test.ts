import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

/**
 * #436 against a real database and the production app: publishing a version
 * pins its workflow tools section (25-one-engine.md 15.5). Each seat an entry
 * lists gets a binding for all the entry's tools, each step's references become
 * a binding for exactly the tools it names, and every binding is pinned to the
 * connection's snapshot. A section that allows a tool the server does not offer
 * or an Admin has not enabled refuses publication.
 */

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;
type Body = Record<string, unknown>;

async function send(
  f: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const headers: Record<string, string> = { ...orgHeader(f.organizationId) };
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;
  const response = await call(f, method, path, f.adminCookie, {
    body: options.body,
    headers,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) as Body : {},
  };
}

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: { query: {} } },
});

async function connection(f: Fixture, enabled: string[], tools: string[]) {
  const server = await send(f, "POST", "/v1/mcp-servers", {
    body: {
      slug: `s-${crypto.randomUUID().slice(0, 8)}`,
      name: "Docs",
      transport: "streamable_http",
      endpointTemplate: "https://mcp.example.com/mcp",
      configSchema: { type: "object" },
      requiredCapabilities: [],
      sourceRevision: "v1",
    },
  });
  await send(f, "PATCH", `/v1/mcp-servers/${server.json.id}`, {
    body: { enabled: true },
    ifMatch: '"1"',
  });
  const made = await send(f, "POST", "/v1/mcp-connections", {
    body: {
      serverId: server.json.id,
      label: "Docs",
      config: {},
      enabledCapabilities: [],
      scope: "organization",
    },
  });
  assert([200, 201].includes(made.status), JSON.stringify(made.json));
  const id = made.json.id as string;
  const snapshotId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.mcp_capability_snapshots
       (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, 'digest-1')`,
    [
      snapshotId,
      f.organizationId,
      id,
      JSON.stringify({ tools: tools.map(tool) }),
    ],
  );
  await f.pgDatabase.query(
    `update bakery.mcp_connections
        set current_snapshot_id = $2, enabled_capabilities = $3::jsonb
      where id = $1`,
    [id, snapshotId, JSON.stringify(enabled)],
  );
  return { id, snapshotId };
}

const definition = (connectionId: string, allow: string[]) => ({
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "tools-section",
  description: "Gives a seat and a step tools from one connection.",
  inputs: {},
  tools: {
    docs: { connectionId, allow, seats: ["designer"] },
  },
  steps: [{
    id: "draft",
    uses: "workflow.noop",
    role: "writer",
    tools: ["docs.search"],
  }],
});

async function publish(f: Fixture, body: unknown) {
  const slug = `wf-${crypto.randomUUID().slice(0, 8)}`;
  const created = await send(f, "POST", "/v1/workflows", {
    body: { slug, name: "Pinned", description: "" },
  });
  assertEquals(created.status, 201, JSON.stringify(created.json));
  const workflowId = created.json.id as string;
  const draft = await send(f, "POST", `/v1/workflows/${workflowId}/versions`, {
    body: { definition: body },
  });
  assertEquals(draft.status, 201, JSON.stringify(draft.json));
  const published = await send(
    f,
    "POST",
    `/v1/workflows/${workflowId}/versions/${draft.json.id}/publish`,
    { body: {}, ifMatch: '"1"' },
  );
  return { published, versionId: draft.json.id as string };
}

const bindingsOf = async (f: Fixture, versionId: string) =>
  (await f.pgDatabase.query<{
    step_key: string | null;
    seat_key: string | null;
    mcp_connection_id: string;
    mcp_snapshot_digest: string;
    allowed_operations: string[];
  }>(
    `select step_key, seat_key, mcp_connection_id, mcp_snapshot_digest, allowed_operations
       from bakery.capability_bindings where workflow_version_id = $1
      order by seat_key nulls last, step_key`,
    [versionId],
  )).rows;

Deno.test("publishing pins the tools section: a seat gets every allowed tool, a step exactly the ones it names (#436)", async () => {
  const f = await openInstallationFixture();
  try {
    const mcp = await connection(f, ["search", "create_note"], [
      "search",
      "create_note",
    ]);
    const { published, versionId } = await publish(
      f,
      definition(mcp.id, ["search", "create_note"]),
    );
    assertEquals(published.status, 200, JSON.stringify(published.json));
    const bindings = await bindingsOf(f, versionId);
    assertEquals(bindings.map((row) => [row.seat_key, row.step_key]), [
      ["designer", null],
      [null, "draft"],
    ]);
    assertEquals(bindings[0]!.allowed_operations, ["create_note", "search"]);
    assertEquals(bindings[1]!.allowed_operations, ["search"]);
    for (const row of bindings) {
      assertEquals(row.mcp_connection_id, mcp.id);
      assertEquals(row.mcp_snapshot_digest, "digest-1");
    }
  } finally {
    await f.finish();
  }
});

Deno.test("a section allowing a tool the server does not offer, or an Admin has not enabled, refuses publication (#436)", async () => {
  const f = await openInstallationFixture();
  try {
    const mcp = await connection(f, ["search"], ["search", "create_note"]);
    const notEnabled = await publish(
      f,
      definition(mcp.id, ["search", "create_note"]),
    );
    assertEquals(notEnabled.published.status, 422);
    assert(
      JSON.stringify(notEnabled.published.json).includes(
        "tools_tool_not_enabled",
      ),
    );
    const unknown = await publish(f, definition(mcp.id, ["search", "nope"]));
    assertEquals(unknown.published.status, 422);
    assert(
      JSON.stringify(unknown.published.json).includes("tools_tool_unknown"),
    );
    for (const { versionId } of [notEnabled, unknown]) {
      assertEquals((await bindingsOf(f, versionId)).length, 0);
    }
  } finally {
    await f.finish();
  }
});
