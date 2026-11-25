import { assert, assertEquals } from "@std/assert";
import type { McpTransport } from "../../apps/server/src/modules/mcp/discovery-transport.ts";
import {
  adminRequest,
  closeWorkerScope,
  createWorkerScope,
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
  workflowId: string;
  runId: string;
  connectionId: string;
  snapshotId: string;
};

type ToolFeedItem = {
  kind: string;
  sequence: string;
  message: { body: string } | null;
  tool: {
    callId: string;
    name: string;
    phase: "started" | "completed" | "failed";
    ok: boolean | null;
  } | null;
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
    workflowId: seed.workflowId,
    runId: seed.runId,
    connectionId,
    snapshotId,
  };
}

async function bind(
  fixture: WorkerFixture,
  s: Session,
  owner: { stepKey?: string; seatKey?: string },
  tools: string[],
  options: {
    connectionId?: string;
    snapshotId?: string;
    actorRef?: string;
  } = {},
): Promise<string> {
  const bound = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.capability_bindings (organization_id, workflow_version_id, step_key, seat_key, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, false)
     returning id`,
    [
      fixture.organizationId,
      s.versionId,
      owner.stepKey ?? null,
      owner.seatKey ?? null,
      options.connectionId ?? s.connectionId,
      options.snapshotId ?? s.snapshotId,
      DIGEST,
      options.actorRef ?? null,
      JSON.stringify(tools),
    ],
  );
  return bound.rows[0]!.id;
}

/** Another snapshot of a connection, with the same digest unless given one. */
async function snapshot(
  fixture: WorkerFixture,
  connectionId: string,
  tools: unknown[],
  options: { digest?: string; observedAt?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, $6::timestamptz, '2026-07-28', $4::jsonb, $5)`,
    [
      id,
      fixture.organizationId,
      connectionId,
      JSON.stringify({ tools }),
      options.digest ?? DIGEST,
      options.observedAt ?? new Date().toISOString(),
    ],
  );
  return id;
}

/** A second enabled connection to the same server, with its own snapshot. */
async function secondConnection(
  fixture: WorkerFixture,
  s: Session,
  options: { ownerPrincipalId?: string } = {},
): Promise<{ connectionId: string; snapshotId: string }> {
  const db = fixture.pgDatabase;
  const connectionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.mcp_connections (id, organization_id, server_id, label, config, enabled_capabilities, status, version, owner_principal_id)
     select $1, organization_id, server_id, 'Docs two', '{}'::jsonb, '["search","create_note"]'::jsonb, 'enabled', 1, $4
       from bakery.mcp_connections where organization_id = $2 and id = $3`,
    [
      connectionId,
      fixture.organizationId,
      s.connectionId,
      options.ownerPrincipalId ?? null,
    ],
  );
  const snapshotId = await snapshot(fixture, connectionId, [
    SEARCH,
    CREATE_NOTE,
  ]);
  return { connectionId, snapshotId };
}

async function gatewayCalls(fixture: WorkerFixture, s: Session) {
  return (await fixture.pgDatabase.query<{ tool_name: string }>(
    `select tool_name from bakery.tool_gateway_calls
      where organization_id = $1 and attempt_id = $2`,
    [fixture.organizationId, s.assignment.attemptId],
  )).rows;
}

type Proof = {
  leaseToken?: string;
  fence?: string;
  workerSessionId?: string;
  workerSessionGeneration?: string;
};

/** The proof's session pair, only when the case names one. */
function sessionPair(proof: Proof) {
  return proof.workerSessionId === undefined ? {} : {
    workerSessionId: proof.workerSessionId,
    workerSessionGeneration: proof.workerSessionGeneration,
  };
}

/** The worker session the host holds now. */
async function hostSession(fixture: WorkerFixture, s: Session) {
  const found = await fixture.pgDatabase.query<
    { id: string; generation: string }
  >(
    `select worker_session_id as id, worker_session_generation::text as generation
       from bakery.worker_hosts where id = $1`,
    [s.assignment.workerHostId],
  );
  return found.rows[0]!;
}

function listTools(fixture: WorkerFixture, s: Session, proof: Proof = {}) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/effective-tools`,
    {
      leaseToken: proof.leaseToken ?? s.assignment.leaseToken,
      fence: proof.fence ?? s.assignment.fence,
      ...sessionPair(proof),
    },
  );
}

async function effectiveTools(fixture: WorkerFixture, s: Session) {
  const response = await listTools(fixture, s);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    tools: {
      name: string;
      toolName: string;
      readOnly: boolean;
      connectionId: string;
      description: string;
    }[];
    unavailable: { toolName: string; connectionId: string; reason: string }[];
  };
}

function invoke(
  fixture: WorkerFixture,
  s: Session,
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey: string = crypto.randomUUID(),
  options: Proof & { connectionId?: string } = {},
) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/tool-invocations`,
    {
      mcpConnectionId: options.connectionId ?? s.connectionId,
      leaseToken: options.leaseToken ?? s.assignment.leaseToken,
      fence: options.fence ?? s.assignment.fence,
      ...sessionPair(options),
      toolName,
      arguments: args,
    },
    { idempotencyKey },
  );
}

async function agentSessionId(
  fixture: WorkerFixture,
  s: Session,
): Promise<string> {
  const found = await fixture.pgDatabase.query<{ id: string }>(
    `select session.id
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.agent_sessions session
         on session.organization_id = job.organization_id
        and session.run_step_id = job.run_step_id
      where attempt.organization_id = $1 and attempt.id = $2
      order by session.created_at, session.id
      limit 1`,
    [fixture.organizationId, s.assignment.attemptId],
  );
  const id = found.rows[0]?.id;
  assert(typeof id === "string");
  return id;
}
async function postDiscussion(
  fixture: WorkerFixture,
  s: Session,
  body: string,
): Promise<void> {
  const sessionId = await agentSessionId(fixture, s);
  const conversation = await fixture.pgDatabase.query<
    { conversation_id: string }
  >(
    `select conversation_id from bakery.agent_sessions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, sessionId],
  );
  const response = await adminRequest(
    fixture,
    `/v1/conversations/${conversation.rows[0]!.conversation_id}/messages`,
    {
      body,
      clientMessageId: crypto.randomUUID(),
      intent: "discussion",
    },
    { idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(response.status, 201, await response.clone().text());
}

async function sessionFeed(
  fixture: WorkerFixture,
  s: Session,
): Promise<ToolFeedItem[]> {
  const response = await adminRequest(
    fixture,
    `/v1/sessions/${await agentSessionId(fixture, s)}/feed`,
    undefined,
    { method: "GET" },
  );
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json() as { items: ToolFeedItem[] }).items;
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
function withGatewayMessages(
  body: (
    fixture: WorkerFixture,
    server: ReturnType<typeof fakeServer>,
  ) => Promise<void>,
) {
  return withGateway(async (fixture, server) => {
    try {
      await body(fixture, server);
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.messages where organization_id = $1",
        [fixture.organizationId],
      );
    }
  });
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
    // The same key and arguments for another tool, or on another connection,
    // is not this call either: it is refused, not answered with this result.
    const otherTool = await invoke(
      fixture,
      s,
      "create_note",
      { query: "bakery" },
      key,
    );
    assertEquals(
      await problemCode(otherTool),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const other = await secondConnection(fixture, s);
    const otherConnection = await invoke(
      fixture,
      s,
      "search",
      { query: "bakery" },
      key,
      { connectionId: other.connectionId },
    );
    assertEquals(
      await problemCode(otherConnection),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    assertEquals(server.calls.length, 1);

    const recorded = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.tool_gateway_calls
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, s.assignment.attemptId],
    );
    assertEquals(recorded.rows.map((row) => row.status), ["completed"]);
  }));

Deno.test("a remote tool call appends ordered lifecycle items once (#435)", () =>
  withGatewayMessages(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    await postDiscussion(fixture, s, "before tool");

    const key = crypto.randomUUID();
    const called = await invoke(fixture, s, "search", { query: "bakery" }, key);
    assertEquals(called.status, 200, await called.clone().text());
    await postDiscussion(fixture, s, "after tool");

    const afterSuccess = await sessionFeed(fixture, s);
    assertEquals(afterSuccess.map((item) => item.kind), [
      "message",
      "tool",
      "tool",
      "message",
    ]);
    assertEquals(
      afterSuccess.map((item) => item.sequence),
      ["1", "2", "3", "4"],
    );

    const replay = await invoke(
      fixture,
      s,
      "search",
      { query: "bakery" },
      key,
    );
    assertEquals(replay.status, 200, await replay.clone().text());
    assertEquals(await sessionFeed(fixture, s), afterSuccess);
    assertEquals(server.calls.length, 1);

    server.answerWith(() => null);
    const failed = await invoke(
      fixture,
      s,
      "search",
      { query: "failure" },
      crypto.randomUUID(),
    );
    assertEquals(failed.status, 200, await failed.clone().text());

    server.answerWith(() => ({
      content: [{ type: "text", text: "tool error" }],
      isError: true,
    }));
    const toolError = await invoke(
      fixture,
      s,
      "search",
      { query: "tool error" },
      crypto.randomUUID(),
    );
    assertEquals(toolError.status, 200, await toolError.clone().text());

    const feed = await sessionFeed(fixture, s);
    assertEquals(
      feed.filter((item) => item.tool !== null).map((item) => ({
        name: item.tool!.name,
        phase: item.tool!.phase,
        ok: item.tool!.ok,
      })),
      [
        { name: "search", phase: "started", ok: null },
        { name: "search", phase: "completed", ok: true },
        { name: "search", phase: "started", ok: null },
        { name: "search", phase: "failed", ok: false },
        { name: "search", phase: "started", ok: null },
        { name: "search", phase: "completed", ok: false },
      ],
    );
    assertEquals(
      feed.map((item) => item.sequence),
      ["1", "2", "3", "4", "5", "6", "7", "8"],
    );
    assertEquals(server.calls.length, 3);
  }));

Deno.test("two calls at once with one key send once; the other is a replay, never a 500 (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    // Hold the connection row so the first call waits at its insert (the
    // foreign key check needs the row) with its row uncommitted, while the
    // second is already in flight with the same key. Today the attempt lock
    // queues the second behind the first; the insert's key conflict is
    // handled as a replay too, so neither order can answer a 500.
    const holder = await fixture.pgDatabase.connect();
    let open = false;
    try {
      await holder.query("begin");
      open = true;
      const pid = (await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      )).rows[0]!.pid;
      await holder.query(
        `select id from bakery.mcp_connections
          where organization_id = $1 and id = $2 for update`,
        [fixture.organizationId, s.connectionId],
      );
      const key = crypto.randomUUID();
      const pending = [
        invoke(fixture, s, "search", { query: "bakery" }, key),
        invoke(fixture, s, "search", { query: "bakery" }, key),
      ];
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = await fixture.pgDatabase.query<{ count: string }>(
          // The first waits on the held row; the second on the first's
          // uncommitted key (old code) or on the held row too.
          `select count(*)::text as count from pg_locks
            where not granted and cardinality(pg_blocking_pids(pid)) > 0
              and pid <> $1`,
          [pid],
        );
        if (Number(waiting.rows[0]!.count) >= 2) break;
        if (Date.now() > deadline) throw new Error("calls never queued");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await holder.query("commit");
      open = false;
      const responses = await Promise.all(pending);
      const answers = await Promise.all(responses.map(async (response) => ({
        status: response.status,
        body: await response.text(),
      })));
      // One call sends. The other replays its answer or, while the first
      // has not settled, says the outcome is not known yet.
      for (const answer of answers) {
        assert(
          answer.status === 200 ||
            (answer.status === 409 &&
              answer.body.includes("tool_call_outcome_unknown")),
          `${answer.status} ${answer.body}`,
        );
      }
      assertEquals(answers.filter((a) => a.status === 200).length >= 1, true);
    } finally {
      if (open) await holder.query("rollback");
      holder.release();
    }
    assertEquals(server.calls.length, 1);
    assertEquals((await gatewayCalls(fixture, s)).length, 1);
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
    assertEquals(
      (await sessionFeed(fixture, s)).map((item) => item.tool),
      [{
        callId,
        name: "create_note",
        phase: "started",
        ok: null,
      }],
    );
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
    assertEquals(
      (await sessionFeed(fixture, s)).map((item) => item.tool),
      [
        {
          callId,
          name: "create_note",
          phase: "started",
          ok: null,
        },
        {
          callId,
          name: "create_note",
          phase: "completed",
          ok: true,
        },
      ],
    );

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
    const audited = async (operation: string) =>
      (await fixture.pgDatabase.query<{ resource_id: string }>(
        `select resource_id from bakery.audit_events
          where organization_id = $1 and operation = $2`,
        [fixture.organizationId, operation],
      )).rows.map((row) => row.resource_id);
    // The refused wildcard left no row; the binding left exactly one.
    assertEquals(await audited("capabilityBindings.create"), [binding.id]);

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
    assertEquals(await audited("capabilityBindings.delete"), [binding.id]);

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
    // A refused withdrawal is not audited.
    assertEquals(await audited("capabilityBindings.delete"), [binding.id]);
  }));

/**
 * Each way a lease proof can be wrong, on both gateway routes. For the stale
 * worker session the attempt was claimed under an older generation than the
 * host's current one: the host check passes and only the attempt's own
 * session check refuses it.
 */
const BAD_PROOFS: readonly (readonly [
  string,
  (fixture: WorkerFixture, s: Session) => Promise<Proof>,
])[] = [
  [
    "a wrong lease token",
    () => Promise.resolve({ leaseToken: "not-the-lease" }),
  ],
  [
    "a wrong fence",
    (_fixture, s) =>
      Promise.resolve({ fence: String(BigInt(s.assignment.fence) + 1n) }),
  ],
  [
    "a stale worker session generation",
    async (fixture, s) => {
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set worker_session_generation = worker_session_generation - 1
          where id = $1`,
        [s.assignment.attemptId],
      );
      return {};
    },
  ],
  [
    // A real second session id: the worker names a session the host does not
    // hold, while the host and the attempt agree with each other.
    "a worker session the host does not hold",
    async (fixture, s) => {
      const held = await hostSession(fixture, s);
      return {
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: held.generation,
      };
    },
  ],
  [
    "a worker session generation the host has not reached",
    async (fixture, s) => {
      const held = await hostSession(fixture, s);
      return {
        workerSessionId: held.id,
        workerSessionGeneration: String(BigInt(held.generation) + 1n),
      };
    },
  ],
];

for (const [name, spoil] of BAD_PROOFS) {
  Deno.test(`${name} is refused on effective-tools and tool-invocations, and nothing is sent (#436)`, () =>
    withGateway(async (fixture, server) => {
      const s = await session(fixture);
      await bind(fixture, s, { stepKey: "worker" }, ["search"]);
      // The same session reaches its tool with the right proof first.
      assertEquals((await effectiveTools(fixture, s)).tools.length, 1);
      const proof = await spoil(fixture, s);
      const listed = await listTools(fixture, s, proof);
      assert(
        listed.status >= 400 && listed.status < 500,
        `listing served with ${name}: ${listed.status} ${await listed.text()}`,
      );
      const called = await invoke(
        fixture,
        s,
        "search",
        { query: "bakery" },
        crypto.randomUUID(),
        proof,
      );
      assert(
        called.status >= 400 && called.status < 500,
        `call served with ${name}: ${called.status} ${await called.text()}`,
      );
      assertEquals(server.calls.length, 0);
      assertEquals(await gatewayCalls(fixture, s), []);
    }));
}

Deno.test("a personal connection serves its owner, or a workflow it granted, and no one else (#436, O27)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    // A real second person, a member of this organization, owns the other
    // connection.
    const db = fixture.pgDatabase;
    const providerUserId = crypto.randomUUID();
    await db.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'Issue 436 owner', $2, true, now(), now())`,
      [providerUserId, `issue436-owner-${providerUserId}@example.test`],
    );
    const other = { principalId: crypto.randomUUID() };
    await db.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, 'Issue 436 owner', 'human')`,
      [other.principalId, providerUserId],
    );
    await db.query(
      `insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version)
       values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1)`,
      [crypto.randomUUID(), fixture.organizationId, other.principalId],
    );
    try {
      const mine = await secondConnection(fixture, s, {
        ownerPrincipalId: fixture.principalId,
      });
      const theirs = await secondConnection(fixture, s, {
        ownerPrincipalId: other.principalId,
      });
      await bind(fixture, s, { stepKey: "worker" }, ["search"], mine);
      await bind(fixture, s, { stepKey: "worker" }, ["create_note"], theirs);

      // The run's starter owns "mine": usable. "theirs" is someone else's.
      let listed = await effectiveTools(fixture, s);
      assertEquals(
        listed.tools.map((tool) => [tool.name, tool.connectionId]),
        [["search", mine.connectionId]],
      );
      assertEquals(listed.unavailable, [{
        toolName: "create_note",
        connectionId: theirs.connectionId,
        reason: "personal_not_usable",
      }]);
      const refused = await invoke(
        fixture,
        s,
        "create_note",
        { text: "x" },
        crypto.randomUUID(),
        { connectionId: theirs.connectionId },
      );
      assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
      assertEquals(server.calls.length, 0);

      // The owner grants this workflow the connection: now usable.
      const grant = await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.mcp_use_grants (organization_id, connection_id, workflow_id, granted_by)
         values ($1, $2, $3, $4) returning id`,
        [
          fixture.organizationId,
          theirs.connectionId,
          s.workflowId,
          other.principalId,
        ],
      );
      listed = await effectiveTools(fixture, s);
      assertEquals(
        listed.tools.map((tool) => tool.name).sort(),
        ["create_note", "search"],
      );
      assertEquals(listed.unavailable, []);
      const granted = await invoke(
        fixture,
        s,
        "create_note",
        { text: "x" },
        crypto.randomUUID(),
        { connectionId: theirs.connectionId },
      );
      assertEquals(granted.status, 200, await granted.clone().text());
      assertEquals(server.calls.length, 1);

      // A revoked grant is no grant.
      await fixture.pgDatabase.query(
        `update bakery.mcp_use_grants set revoked_at = now(), revoked_by = $2
          where id = $1`,
        [grant.rows[0]!.id, other.principalId],
      );
      listed = await effectiveTools(fixture, s);
      assertEquals(listed.unavailable.map((tool) => tool.reason), [
        "personal_not_usable",
      ]);
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.mcp_use_grants where organization_id = $1`,
        [fixture.organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.mcp_connections where organization_id = $1 and owner_principal_id = $2`,
        [fixture.organizationId, other.principalId],
      );
      await db.query(
        `delete from bakery.organization_memberships where principal_id = $1`,
        [other.principalId],
      );
      await db.query(`delete from bakery.principals where id = $1`, [
        other.principalId,
      ]);
      await db.query(`delete from public."user" where id = $1`, [
        providerUserId,
      ]);
    }
  }));

Deno.test("a reviewer session gets the bound read and not the bound write (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture, { role: "reviewer" });
    await bind(fixture, s, { seatKey: "reviewer" }, ["search", "create_note"]);
    const listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools.map((tool) => tool.name), ["search"]);
    assertEquals(listed.unavailable, [{
      toolName: "create_note",
      connectionId: s.connectionId,
      reason: "reviewer_read_only",
    }]);
    const refused = await invoke(fixture, s, "create_note", { text: "x" });
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
    assertEquals(server.calls.length, 0);
  }));

Deno.test("an offline run, or a disabled connection, lists nothing callable and calls nothing (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    assertEquals((await effectiveTools(fixture, s)).tools.length, 1);

    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set environment = 'offline'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, s.runId],
    );
    let listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools, []);
    assertEquals(listed.unavailable.map((tool) => tool.reason), ["offline"]);
    let refused = await invoke(fixture, s, "search", { query: "bakery" });
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");

    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set environment = 'live'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, s.runId],
    );
    await fixture.pgDatabase.query(
      `update bakery.mcp_connections set status = 'disabled'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, s.connectionId],
    );
    listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools, []);
    assertEquals(listed.unavailable.map((tool) => tool.reason), [
      "connection_off",
    ]);
    refused = await invoke(fixture, s, "search", { query: "bakery" });
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
    assertEquals(server.calls.length, 0);
  }));

Deno.test("a call naming a connection the tool is not bound on is refused, even with the same snapshot (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    // Enabled, same server, same snapshot digest, tool enabled; never bound.
    const unbound = await secondConnection(fixture, s);
    const refused = await invoke(
      fixture,
      s,
      "search",
      { query: "bakery" },
      crypto.randomUUID(),
      { connectionId: unbound.connectionId },
    );
    assertEquals(await problemCode(refused), "AUTH_FORBIDDEN");
    assertEquals(server.calls.length, 0);
    assertEquals(await gatewayCalls(fixture, s), []);
  }));

Deno.test("a revoked binding and a binding for one actor grant this session nothing (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    const revoked = await bind(fixture, s, { stepKey: "worker" }, ["search"]);
    await fixture.pgDatabase.query(
      `insert into bakery.capability_binding_revocations (organization_id, binding_id, revoked_by)
       values ($1, $2, $3)`,
      [fixture.organizationId, revoked, fixture.principalId],
    );
    await bind(fixture, s, { stepKey: "worker" }, ["create_note"], {
      actorRef: `principal:${fixture.principalId}`,
    });
    const listed = await effectiveTools(fixture, s);
    assertEquals(listed.tools, []);
    assertEquals(listed.unavailable, []);
    for (
      const [tool, args] of [["search", { query: "b" }], ["create_note", {
        text: "x",
      }]] as const
    ) {
      const refused = await invoke(fixture, s, tool, args);
      assertEquals(await problemCode(refused), "AUTH_FORBIDDEN", tool);
    }
    assertEquals(server.calls.length, 0);
  }));

Deno.test("the most specific binding wins whichever was made first (#436)", () =>
  withGateway(async (fixture) => {
    const s = await session(fixture, { role: "designer" });
    // A later observation with the same digest: the step pins it, the seat
    // pins the first. What the session sees tells which binding won.
    const later = await snapshot(fixture, s.connectionId, [
      { ...SEARCH, description: "search docs, step pin" },
      { ...CREATE_NOTE, description: "create a note, step pin" },
    ], { observedAt: new Date(Date.now() + 1000).toISOString() });
    await bind(fixture, s, { seatKey: "designer" }, ["search"]);
    await bind(fixture, s, { stepKey: "worker" }, ["search", "create_note"], {
      snapshotId: later,
    });
    await bind(fixture, s, { seatKey: "designer" }, ["create_note"]);
    const listed = await effectiveTools(fixture, s);
    assertEquals(
      listed.tools.map((tool) => [tool.name, tool.description]),
      [
        ["create_note", "create a note, step pin"],
        ["search", "search docs, step pin"],
      ],
    );
  }));

Deno.test("an Admin of another organization cannot settle this organization's call (#436)", () =>
  withGateway(async (fixture, server) => {
    const s = await session(fixture);
    await bind(fixture, s, { stepKey: "worker" }, ["create_note"]);
    server.answerWith(() => null);
    const first = await invoke(fixture, s, "create_note", { text: "x" });
    assertEquals(await problemCode(first), "STATE_CONFLICT");
    const sent = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.tool_gateway_calls
        where organization_id = $1 and attempt_id = $2 and status = 'sent'`,
      [fixture.organizationId, s.assignment.attemptId],
    );
    const callId = sent.rows[0]!.id;
    // A real second organization; its Admin acts there.
    const other = await createWorkerScope(fixture, "issue436-settle", {
      email: fixture.email,
      principalId: fixture.principalId,
      adminCookie: fixture.adminCookie,
    });
    try {
      const foreign = await adminRequest(
        fixture,
        `/v1/tool-gateway-calls/${callId}/settlement`,
        { status: "completed" },
        { idempotencyKey: crypto.randomUUID(), scope: other },
      );
      assertEquals(await problemCode(foreign), "RESOURCE_NOT_FOUND");
    } finally {
      await closeWorkerScope(fixture, other);
    }
    const still = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.tool_gateway_calls where id = $1`,
      [callId],
    );
    assertEquals(still.rows.map((row) => row.status), ["sent"]);
    const audit = await fixture.pgDatabase.query(
      `select 1 from bakery.audit_events
        where operation = 'toolGatewayCalls.settle' and resource_id = $1`,
      [callId],
    );
    assertEquals(audit.rows.length, 0);
  }));
