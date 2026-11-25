import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

/**
 * #435 slice 2a against a real database and the production app: publishing a
 * workflow version pins the MCP tool each tool.call step calls (the connection,
 * the snapshot digest published against, the exact tool) in capability_bindings,
 * and refuses a version whose step names a tool the connection does not offer or
 * has not enabled.
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

const definition = (connectionId: string, toolName: string) => ({
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "pinned-tool",
  description: "Calls one pinned MCP tool.",
  inputs: { key: { type: "uuid", required: true } },
  steps: [{
    id: "lookup",
    uses: "tool.call",
    with: {
      connectionId,
      tool: toolName,
      arguments: { $literal: { query: "bakery" } },
    },
    effectKey: ["lookup", "$input.key"],
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
    step_key: string;
    mcp_connection_id: string;
    mcp_snapshot_digest: string;
    allowed_operations: string[];
    actor_ref: string | null;
  }>(
    `select step_key, mcp_connection_id, mcp_snapshot_digest, allowed_operations, actor_ref
       from bakery.capability_bindings where workflow_version_id = $1`,
    [versionId],
  )).rows;

Deno.test("publishing pins an MCP tool.call step to the connection, its snapshot digest and the exact tool (#435)", async () => {
  const f = await openInstallationFixture();
  try {
    const mcp = await connection(f, ["search"], ["search", "other"]);
    const { published, versionId } = await publish(
      f,
      definition(mcp.id, "search"),
    );
    assertEquals(published.status, 200, JSON.stringify(published.json));
    const bindings = await bindingsOf(f, versionId);
    assertEquals(bindings.length, 1);
    assertEquals(bindings[0].step_key, "lookup");
    assertEquals(bindings[0].mcp_connection_id, mcp.id);
    assertEquals(bindings[0].mcp_snapshot_digest, "digest-1");
    // The exact tool, never a wildcard; any actor, because who may run the step
    // is the workflow's rule and not the pin's.
    assertEquals(bindings[0].allowed_operations, ["search"]);
    assertEquals(bindings[0].actor_ref, null);
    // Rediscovery after publication moves the connection's snapshot, not the pin.
    await f.pgDatabase.query(
      `insert into bakery.mcp_capability_snapshots
         (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
       values ($1, $2, $3, now() + interval '1 second', '2026-07-28', $4::jsonb, 'digest-2')`,
      [
        crypto.randomUUID(),
        f.organizationId,
        mcp.id,
        JSON.stringify({ tools: [tool("search")] }),
      ],
    );
    assertEquals(
      (await bindingsOf(f, versionId))[0].mcp_snapshot_digest,
      "digest-1",
    );
  } finally {
    await f.finish();
  }
});

Deno.test("publishing freezes an async write's operation key and poll into its pin, which later classification edits leave alone (#439)", async () => {
  const f = await openInstallationFixture();
  try {
    const mcp = await connection(f, ["submit", "status"], ["submit", "status"]);
    const classify = (name: string, effectClass: string, more: unknown[]) =>
      f.pgDatabase.query(
        `insert into bakery.mcp_tool_classifications
           (organization_id, connection_id, tool_name, effect_class,
            effect_key_argument, paired_read_tool, snapshot_digest, classified_by)
         values ($1, $2, $3, $4, $5, $6, 'digest-1', $7)`,
        [f.organizationId, mcp.id, name, effectClass, ...more, f.adminId],
      );
    await classify("status", "read", [null, null]);
    await classify("submit", "write_async", ["query", "status"]);
    const { published, versionId } = await publish(
      f,
      definition(mcp.id, "submit"),
    );
    assertEquals(published.status, 200, JSON.stringify(published.json));
    const frozen = async () =>
      (await f.pgDatabase.query<
        { allowed_operations: string[]; mcp_async_form: unknown }
      >(
        `select allowed_operations, mcp_async_form
           from bakery.capability_bindings where workflow_version_id = $1`,
        [versionId],
      )).rows;
    const expected = [{
      allowed_operations: ["submit", "status"],
      mcp_async_form: {
        kind: "submit_poll_v1",
        effectKeyArgument: "query",
        pollTool: "status",
      },
    }];
    assertEquals(await frozen(), expected);
    await f.pgDatabase.query(
      `update bakery.mcp_tool_classifications
          set effect_class = 'write_opaque', effect_key_argument = null,
              paired_read_tool = null
        where organization_id = $1 and connection_id = $2
          and tool_name = 'submit'`,
      [f.organizationId, mcp.id],
    );
    assertEquals(await frozen(), expected);
  } finally {
    await f.finish();
  }
});

Deno.test("a tool the connection does not offer, or has not enabled, refuses publication and leaves no version or pin (#435)", async () => {
  const f = await openInstallationFixture();
  try {
    const mcp = await connection(f, ["search"], ["search", "create_issue"]);
    const unknown = await publish(f, definition(mcp.id, "nope"));
    assertEquals(
      unknown.published.status,
      422,
      JSON.stringify(unknown.published.json),
    );
    assert(
      JSON.stringify(unknown.published.json).includes("tool_call_tool_unknown"),
    );
    const notEnabled = await publish(f, definition(mcp.id, "create_issue"));
    assertEquals(notEnabled.published.status, 422);
    assert(
      JSON.stringify(notEnabled.published.json).includes(
        "tool_call_tool_not_enabled",
      ),
    );
    for (const { versionId } of [unknown, notEnabled]) {
      assertEquals((await bindingsOf(f, versionId)).length, 0);
      const published = await f.pgDatabase.query(
        `select 1 from bakery.workflow_versions where id = $1 and status = 'published'`,
        [versionId],
      );
      assertEquals(published.rows.length, 0);
    }
  } finally {
    await f.finish();
  }
});

Deno.test("a tool.call step over a connection that is not an MCP one pins nothing and still publishes (#435)", async () => {
  const f = await openInstallationFixture();
  try {
    const { published, versionId } = await publish(
      f,
      definition(crypto.randomUUID(), "github.issue.comment.create"),
    );
    assertEquals(published.status, 200, JSON.stringify(published.json));
    assertEquals((await bindingsOf(f, versionId)).length, 0);
  } finally {
    await f.finish();
  }
});

Deno.test("the application role may read and add a pin but never change or remove one (#435)", async () => {
  const f = await openInstallationFixture();
  try {
    const has = async (privilege: string) =>
      (await f.pgDatabase.query<{ ok: boolean }>(
        `select has_table_privilege('bakery_app', 'bakery.capability_bindings', $1) as ok`,
        [privilege],
      )).rows[0].ok;
    assertEquals(await has("select"), true);
    assertEquals(await has("insert"), true);
    assertEquals(await has("update"), false);
    assertEquals(await has("delete"), false);
  } finally {
    await f.finish();
  }
});
