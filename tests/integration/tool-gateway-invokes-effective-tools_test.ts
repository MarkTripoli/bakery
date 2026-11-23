import { assert, assertEquals } from "@std/assert";
import type { McpTransport } from "../../apps/server/src/modules/mcp/discovery-transport.ts";
import {
  adminRequest,
  problemCode,
  registeredWorker,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * #436 on a real database: the worker tool gateway. A session lists exactly its
 * effective tools (bound by exact name to its step, its seat or its agent
 * version, enabled, on the pinned snapshot) through the lease-protected
 * effective-tools route, and calls one through worker.invokeTool
 * (/v1/worker/attempts/{id}/tool-invocations). A tool it was not granted is
 * refused before anything is sent; a replayed Idempotency-Key answers what
 * happened instead of sending again; a write whose outcome is unknown is never
 * sent twice.
 */

const DIGEST = "c".repeat(64);
const SEARCH = {
  name: "search",
  description: "search docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
};
const CREATE_NOTE = {
  name: "create_note",
  description: "create a note",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    additionalProperties: false,
  },
};
const PUBLISH = {
  name: "publish",
  description: "publish the note",
  inputSchema: { type: "object", additionalProperties: true },
};

type Answer = (params: Record<string, unknown>) => unknown;

/** A fake remote MCP server; `answer` returning null gives an unreadable reply. */
function fakeServer() {
  const calls: Record<string, unknown>[] = [];
  let answer: Answer = () => ({ content: [{ type: "text", text: "2 hits" }] });
  const transport: McpTransport = (request) => {
    const message = JSON.parse(request.body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    const reply = (status: number, body: string) =>
      Promise.resolve({
        kind: "response" as const,
        status,
        contentType: "application/json",
        sessionId: null,
        body,
      });
    if (message.method === "notifications/initialized") return reply(202, "");
    if (message.method === "tools/call") calls.push(message.params ?? {});
    const result = message.method === "initialize"
      ? { protocolVersion: "2026-07-28", capabilities: {} }
      : answer(message.params ?? {});
    if (result === null) return reply(200, "not json-rpc");
    return reply(
      200,
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
    );
  };
  return {
    calls,
    transport,
    answerWith(next: Answer) {
      answer = next;
    },
  };
}

type Session = {
  assignment: WorkerAssignment;
  credential: string;
  versionId: string;
  connectionId: string;
  snapshotId: string;
};

/** A claimed attempt in a workflow run, and an enabled MCP connection. */
async function session(
  fixture: WorkerFixture,
  options: { role?: string } = {},
): Promise<Session> {
  const db = fixture.pgDatabase;
  const org = fixture.organizationId;
  const worker = await registeredWorker(fixture, { slots: 1 });
  const seed = await seedEligibleNonmodelJob(db, org, fixture.principalId, {
    compilable: true,
  });
  if (options.role !== undefined) {
    await db.query(
      `update bakery.workflow_versions
          set normalized_spec = jsonb_set(normalized_spec, '{steps,0,role}', to_jsonb($3::text))
        where organization_id = $1 and id = $2`,
      [org, seed.workflowVersionId, options.role],
    );
  }
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  await db.query(
    `insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, version)
     values ($1, $2, $3, 'Docs', 'streamable_http', '{}'::jsonb, 'https://mcp.example.com/mcp', '{}'::jsonb, '[]'::jsonb, 'rev', true, 1)`,
    [serverId, org, `s-${serverId.slice(0, 8)}`],
  );
  await db.query(
    `insert into bakery.mcp_connections (id, organization_id, server_id, label, config, enabled_capabilities, status, version)
     values ($1, $2, $3, 'Docs', '{}'::jsonb, '["search","create_note"]'::jsonb, 'enabled', 1)`,
    [connectionId, org, serverId],
  );
  await db.query(
    `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, $5)`,
    [
      snapshotId,
      org,
      connectionId,
      JSON.stringify({ tools: [SEARCH, CREATE_NOTE, PUBLISH] }),
      DIGEST,
    ],
  );
  await db.query(
    `insert into bakery.mcp_tool_classifications (organization_id, connection_id, tool_name, effect_class, snapshot_digest, classified_by)
     values ($1, $2, 'search', 'read', $3, $4)`,
    [org, connectionId, DIGEST, fixture.principalId],
  );
  const assignment = await claimAssignment(fixture, worker);
  return {
    assignment,
    credential: worker.credential,
    versionId: seed.workflowVersionId,
    connectionId,
    snapshotId,
  };
}

async function bind(
  fixture: WorkerFixture,
  s: Session,
  owner: { stepKey?: string; seatKey?: string },
  tools: string[],
): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.capability_bindings (organization_id, workflow_version_id, step_key, seat_key, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required)
     values ($1, $2, $3, $4, $5, $6, $7, null, $8::jsonb, false)`,
    [
      fixture.organizationId,
      s.versionId,
      owner.stepKey ?? null,
      owner.seatKey ?? null,
      s.connectionId,
      s.snapshotId,
      DIGEST,
      JSON.stringify(tools),
    ],
  );
}

async function effectiveTools(fixture: WorkerFixture, s: Session) {
  const response = await workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/effective-tools`,
    { leaseToken: s.assignment.leaseToken, fence: s.assignment.fence },
  );
  assertEquals(response.status, 200);
  return await response.json() as {
    tools: { name: string; toolName: string; readOnly: boolean }[];
    unavailable: { toolName: string; connectionId: string; reason: string }[];
  };
}

function invoke(
  fixture: WorkerFixture,
  s: Session,
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/tool-invocations`,
    {
      mcpConnectionId: s.connectionId,
      leaseToken: s.assignment.leaseToken,
      fence: s.assignment.fence,
      toolName,
      arguments: args,
    },
    { idempotencyKey },
  );
}

function withGateway(
  body: (
    fixture: WorkerFixture,
    server: ReturnType<typeof fakeServer>,
  ) => Promise<void>,
) {
  const server = fakeServer();
  return withWorkerFixture(
    (fixture) => body(fixture, server),
    { mcpToolTransport: server.transport },
  );
}

Deno.test("a session lists only the tools its step binds and calls one through tool-invocations (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    const listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools.map((tool) => tool.name), ["search"]);
    assertEquals(listed.tools[0]!.readOnly, true);

    const key = crypto.randomUUID();
    const called = await invoke(fixture, s, "search", { query: "bakery" }, key);
    assertEquals(called.status, 200);
    const result = await called.json() as {
      toolName: string;
      content: unknown[];
      isError: boolean;
    };
    assertEquals(result.toolName, "search");
    assertEquals(result.isError, false);
    assertEquals(result.content, [{ type: "text", text: "2 hits" }]);
    assertEquals(server.calls.length, 1);

    // The same key answers what happened; nothing is sent again.
    const replayed = await invoke(
      fixture,
      s,
      "search",
      { query: "bakery" },
      key,
    );
    assertEquals(replayed.status, 200);
    assertEquals(server.calls.length, 1);
    // The same key with other arguments is not this call.
    const mismatch = await invoke(
      fixture,
      s,
      "search",
      { query: "other" },
      key,
    );
    assertEquals(await problemCode(mismatch), "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const recorded = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.tool_gateway_calls
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, s.assignment.attemptId],
    );
    assertEquals(recorded.rows.map((row) => row.status), ["completed"]);
  }));

Deno.test("a tool the session was not granted is refused before anything is sent (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    // Enabled on the connection and in the snapshot, but not bound.
    const refused = await invoke(fixture, s, "create_note", { text: "x" });
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
    // Bound to another step of the same version: not this session's.
    await bind(fixture, s, { stepKey: "elsewhere" }, ["create_note"]);
    assertEquals(
      (await effectiveTools(fixture, s)).tools.map((tool) => tool.name),
      ["search"],
    );
    assertEquals(server.calls.length, 0);
  }));

Deno.test("a seat binding reaches the steps that run as that seat and no other (#436)", () =>
  withGateway(async (fixture) => {
    const s = await session(fixture, { role: "designer" });
    await bind(fixture, s, { seatKey: "designer" }, ["create_note"]);
    await bind(fixture, s, { seatKey: "reviewer" }, ["search"]);
    const listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools.map((tool) => tool.name), ["create_note"]);
    assertEquals(listed.tools[0]!.readOnly, false);
  }));

Deno.test("a tool not enabled, or one whose server drifted, is listed as unavailable and not callable (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search", "publish"]);
    let listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools.map((tool) => tool.name), ["search"]);
    assertEquals(listed.unavailable, [{
      toolName: "publish",
      connectionId: s.connectionId,
      reason: "tool_not_enabled",
    }]);
    // The server changed what it advertises: nothing re-pins on its own.
    await fixture.pgDatabase.query(
      `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
       values ($1, $2, $3, now() + interval '1 second', '2026-07-28', $4::jsonb, $5)`,
      [
        crypto.randomUUID(),
        fixture.organizationId,
        s.connectionId,
        JSON.stringify({ tools: [SEARCH] }),
        "d".repeat(64),
      ],
    );
    listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools, []);
    assert(
      listed.unavailable.some((tool) =>
        tool.toolName === "search" && tool.reason === "update_available"
      ),
    );
    const refused = await invoke(fixture, s, "search", { query: "bakery" });
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
    assertEquals(server.calls.length, 0);
  }));

Deno.test("a write whose outcome is unknown is never sent a second time (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["create_note"]);
    server.answerWith(() => null);
    const key = crypto.randomUUID();
    const first = await invoke(fixture, s, "create_note", { text: "x" }, key);
    assertEquals(await problemCode(first), "STATE_CONFLICT");
    const again = await invoke(fixture, s, "create_note", { text: "x" }, key);
    assertEquals(await problemCode(again), "STATE_CONFLICT");
    assertEquals(server.calls.length, 1);
  }));

Deno.test("an Admin settles a write whose outcome is unknown, once, and it is audited (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["create_note"]);
    server.answerWith(() => null);
    const key = crypto.randomUUID();
    const first = await invoke(fixture, s, "create_note", { text: "x" }, key);
    assertEquals(await problemCode(first), "STATE_CONFLICT");
    const sent = await fixture.pgDatabase.query<{ id: string; status: string }>(
      `select id, status from bakery.tool_gateway_calls
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, s.assignment.attemptId],
    );
    assertEquals(sent.rows.map((row) => row.status), ["sent"]);
    const callId = sent.rows[0]!.id;
    const path = `/v1/tool-gateway-calls/${callId}/settlement`;

    // A completed settlement carries no failure code.
    const mixed = await adminRequest(fixture, path, {
      status: "completed",
      failureCode: "nope",
    }, { idempotencyKey: crypto.randomUUID() });
    assertEquals(await problemCode(mixed), "UNPROCESSABLE");
    const unknown = await adminRequest(
      fixture,
      `/v1/tool-gateway-calls/${crypto.randomUUID()}/settlement`,
      { status: "completed" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(await problemCode(unknown), "RESOURCE_NOT_FOUND");

    const settled = await adminRequest(fixture, path, { status: "completed" }, {
      idempotencyKey: crypto.randomUUID(),
    });
    assertEquals(settled.status, 201, await settled.clone().text());
    const call = await settled.json() as {
      id: string;
      status: string;
      failureCode: string | null;
      settledAt: string | null;
      toolName: string;
    };
    assertEquals(call.id, callId);
    assertEquals(call.status, "completed");
    assertEquals(call.failureCode, null);
    assertEquals(call.toolName, "create_note");
    assert(call.settledAt !== null);

    // Settled once: a second settlement, either way, is refused.
    const again = await adminRequest(fixture, path, { status: "failed" }, {
      idempotencyKey: crypto.randomUUID(),
    });
    assertEquals(await problemCode(again), "STATE_CONFLICT");

    const audit = await fixture.pgDatabase.query<
      { details: { status: string } }
    >(
      `select details from bakery.audit_events
        where organization_id = $1 and operation = 'toolGatewayCalls.settle'
          and resource_id = $2`,
      [fixture.organizationId, callId],
    );
    assertEquals(audit.rows.map((row) => row.details.status), ["completed"]);
    // Settling records the outcome; nothing is sent to the server again.
    assertEquals(server.calls.length, 1);
  }));

Deno.test("an Admin binds an agent version to exact tools, lists and withdraws it; a version's pins stay (#436)", () =>
  withGateway(async (fixture) => {
    const s = await session(fixture);
    // A model job brings an agent version to bind.
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const agent = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.agent_versions where organization_id = $1 limit 1`,
      [fixture.organizationId],
    );
    const agentVersionId = agent.rows[0]!.id;
    const wildcard = await adminRequest(fixture, "/v1/capability-bindings", {
      agentVersionId,
      mcpConnectionId: s.connectionId,
      allowedOperations: ["*"],
      required: false,
    }, { idempotencyKey: crypto.randomUUID() });
    assertEquals(await problemCode(wildcard), "UNPROCESSABLE");
    const created = await adminRequest(fixture, "/v1/capability-bindings", {
      agentVersionId,
      mcpConnectionId: s.connectionId,
      allowedOperations: ["search"],
      required: false,
    }, { idempotencyKey: crypto.randomUUID() });
    assertEquals(created.status, 201);
    const binding = await created.json() as {
      id: string;
      allowedOperations: string[];
    };
    assertEquals(binding.allowedOperations, ["search"]);

    const listed = await adminRequest(
      fixture,
      `/v1/capability-bindings?agentVersionId=${agentVersionId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(listed.status, 200);
    const page = await listed.json() as { items: { id: string }[] };
    assertEquals(page.items.map((item) => item.id), [binding.id]);

    const removed = await adminRequest(
      fixture,
      `/v1/capability-bindings/${binding.id}`,
      undefined,
      { method: "DELETE" },
    );
    assertEquals(removed.status, 204, await removed.clone().text());
    const after = await adminRequest(
      fixture,
      `/v1/capability-bindings?agentVersionId=${agentVersionId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals((await after.json() as { items: unknown[] }).items, []);

    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    const pin = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.capability_bindings
        where organization_id = $1 and workflow_version_id = $2`,
      [fixture.organizationId, s.versionId],
    );
    const kept = await adminRequest(
      fixture,
      `/v1/capability-bindings/${pin.rows[0]!.id}`,
      undefined,
      { method: "DELETE" },
    );
    assertEquals(await problemCode(kept), "STATE_CONFLICT");
  }));
