import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  registeredWorker,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * #441 on a real database: local (stdio) MCP servers. A stdio connection is
 * placed on one worker host. Only that host lists it for discovery and may
 * report its snapshot; only sessions on that host see its tools, with the
 * pinned launch; and its calls are checked and recorded by the server through
 * local-tool-calls before the worker sends them, never sent by the broker.
 */

const LAUNCH = {
  command: "/usr/local/bin/mcp-files",
  args: ["--root", "/srv"],
  artifactDigest: "a".repeat(64),
};
const ECHO = {
  name: "echo",
  description: "Echoes text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

type Local = {
  assignment: WorkerAssignment;
  credential: string;
  hostId: string;
  versionId: string;
  connectionId: string;
};

async function placedConnection(
  fixture: WorkerFixture,
  hostId: string,
): Promise<string> {
  const db = fixture.pgDatabase;
  const org = fixture.organizationId;
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, version)
     values ($1, $2, $3, 'Files', 'stdio', $4::jsonb, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, 1)`,
    [serverId, org, `f-${serverId.slice(0, 8)}`, JSON.stringify(LAUNCH)],
  );
  await db.query(
    `insert into bakery.mcp_connections (id, organization_id, server_id, label, config, enabled_capabilities, status, worker_host_id, version)
     values ($1, $2, $3, 'Files', '{}'::jsonb, '["echo"]'::jsonb, 'enabled', $4, 1)`,
    [connectionId, org, serverId, hostId],
  );
  return connectionId;
}

async function local(fixture: WorkerFixture): Promise<Local> {
  const worker = await registeredWorker(fixture, { slots: 1 });
  const seed = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    { compilable: true },
  );
  const assignment = await claimAssignment(fixture, worker);
  const hostId = (await fixture.pgDatabase.query<{ worker_host_id: string }>(
    "select worker_host_id from bakery.job_attempts where id = $1",
    [assignment.attemptId],
  )).rows[0]!.worker_host_id;
  const connectionId = await placedConnection(fixture, hostId);
  return {
    assignment,
    credential: worker.credential,
    hostId,
    versionId: seed.workflowVersionId,
    connectionId,
  };
}

/**
 * The fixture removes worker hosts before the organization, and a placed
 * connection holds its host (on delete restrict), so a test unplaces its
 * connections on the way out.
 */
function withLocal(body: (fixture: WorkerFixture) => Promise<void>) {
  return withWorkerFixture(async (fixture) => {
    try {
      await body(fixture);
    } finally {
      await fixture.pgDatabase.query(
        `update bakery.mcp_connections set worker_host_id = null
          where organization_id = $1`,
        [fixture.organizationId],
      );
    }
  });
}

function discoveryRequest(
  fixture: WorkerFixture,
  credential: string,
  path: string,
  body: unknown,
) {
  return workerRequest(fixture, credential, path, body, {
    includeWorkerSession: false,
    headers: { "X-Bakery-Worker-Protocol-Version": "2" },
  });
}

async function reportSnapshot(fixture: WorkerFixture, s: Local) {
  const response = await discoveryRequest(
    fixture,
    s.credential,
    `/v1/worker/local-mcp-connections/${s.connectionId}/snapshots`,
    { protocolVersion: "2026-07-28", tools: [ECHO] },
  );
  assertEquals(response.status, 200);
  return await response.json() as { snapshotId: string; digest: string };
}

async function bindStep(fixture: WorkerFixture, s: Local, snapshot: {
  snapshotId: string;
  digest: string;
}) {
  await fixture.pgDatabase.query(
    `insert into bakery.capability_bindings (organization_id, workflow_version_id, step_key, seat_key, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required)
     values ($1, $2, 'worker', null, $3, $4, $5, null, '["echo"]'::jsonb, false)`,
    [
      fixture.organizationId,
      s.versionId,
      s.connectionId,
      snapshot.snapshotId,
      snapshot.digest,
    ],
  );
}

function lease(s: Local) {
  return { leaseToken: s.assignment.leaseToken, fence: s.assignment.fence };
}

function openCall(
  fixture: WorkerFixture,
  s: Local,
  args: Record<string, unknown>,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/local-tool-calls`,
    {
      ...lease(s),
      mcpConnectionId: s.connectionId,
      toolName: "echo",
      arguments: args,
    },
    { idempotencyKey },
  );
}

function settleCall(
  fixture: WorkerFixture,
  s: Local,
  callId: string,
  outcome: Record<string, unknown>,
) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/local-tool-calls/${callId}/outcome`,
    { ...lease(s), ...outcome },
  );
}

Deno.test("only the host a stdio connection is placed on discovers it and pins its snapshot (#441)", () =>
  withLocal(async (fixture) => {
    const s = await local(fixture);
    const listed = await discoveryRequest(
      fixture,
      s.credential,
      "/v1/worker/local-mcp-connections",
      {},
    );
    assertEquals(listed.status, 200);
    const page = await listed.json() as {
      items: { connectionId: string; launchSpec: unknown }[];
      nextCursor: string | null;
    };
    assertEquals(page.items, [{
      connectionId: s.connectionId,
      launchSpec: LAUNCH,
      currentDigest: null,
    }] as never);
    assertEquals(page.nextCursor, null);

    const pinned = await reportSnapshot(fixture, s);
    const row = (await fixture.pgDatabase.query<{
      current_snapshot_id: string;
    }>(
      "select current_snapshot_id from bakery.mcp_connections where id = $1",
      [s.connectionId],
    )).rows[0]!;
    assertEquals(row.current_snapshot_id, pinned.snapshotId);
    // The same answer again keeps the same snapshot.
    assertEquals(
      (await reportSnapshot(fixture, s)).snapshotId,
      pinned.snapshotId,
    );

    // Another host neither sees the connection nor may report for it.
    const other = await registeredWorker(fixture, { slots: 1 });
    const otherList = await discoveryRequest(
      fixture,
      other.credential,
      "/v1/worker/local-mcp-connections",
      {},
    );
    assertEquals((await otherList.json() as { items: unknown[] }).items, []);
    const otherReport = await discoveryRequest(
      fixture,
      other.credential,
      `/v1/worker/local-mcp-connections/${s.connectionId}/snapshots`,
      { protocolVersion: "2026-07-28", tools: [ECHO] },
    );
    assertEquals(otherReport.status, 404);

    // A malformed report is refused and pins nothing.
    const bad = await discoveryRequest(
      fixture,
      s.credential,
      `/v1/worker/local-mcp-connections/${s.connectionId}/snapshots`,
      { protocolVersion: "2026-07-28", tools: [ECHO, ECHO] },
    );
    assertEquals(bad.status, 422);
  }));

Deno.test("a local tool is listed with its launch, checked and recorded by local-tool-calls, and never sent by the broker (#441)", () =>
  withLocal(async (fixture) => {
    const s = await local(fixture);
    await bindStep(fixture, s, await reportSnapshot(fixture, s));
    const listed = await workerRequest(
      fixture,
      s.credential,
      `/v1/worker/attempts/${s.assignment.attemptId}/effective-tools`,
      lease(s),
    );
    assertEquals(listed.status, 200);
    const tools = (await listed.json() as {
      tools: { name: string; launchSpec: unknown }[];
    }).tools;
    assertEquals(tools.map((tool) => [tool.name, tool.launchSpec]), [[
      "echo",
      LAUNCH,
    ]]);

    // The broker's door refuses a local tool: it cannot reach the process.
    const brokered = await workerRequest(
      fixture,
      s.credential,
      `/v1/worker/attempts/${s.assignment.attemptId}/tool-invocations`,
      {
        ...lease(s),
        mcpConnectionId: s.connectionId,
        toolName: "echo",
        arguments: { text: "hi" },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(brokered.status, 422);

    // Arguments the pinned schema refuses are refused before the worker sends.
    const refused = await openCall(fixture, s, { text: 5 });
    assertEquals(refused.status, 422);

    const key = crypto.randomUUID();
    const opened = await openCall(fixture, s, { text: "hi" }, key);
    assertEquals(opened.status, 200);
    const open = await opened.json() as { callId: string; status: string };
    assertEquals(open.status, "open");
    // Opened but not settled: a replay must not send it again.
    assertEquals((await openCall(fixture, s, { text: "hi" }, key)).status, 409);

    const settled = await settleCall(fixture, s, open.callId, {
      status: "completed",
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
    assertEquals(settled.status, 200);
    // Once only.
    const again = await settleCall(fixture, s, open.callId, {
      status: "failed",
      failureCode: "late",
    });
    assertEquals(again.status, 409);
    assertEquals(await problemCode(again), "STATE_CONFLICT");

    const replay = await openCall(fixture, s, { text: "hi" }, key);
    assertEquals(replay.status, 200);
    const answered = await replay.json() as {
      status: string;
      result: { content: unknown[] };
    };
    assertEquals(answered.status, "completed");
    assertEquals(answered.result.content, [{ type: "text", text: "hi" }]);
    const calls = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.tool_gateway_calls
        where attempt_id = $1 order by created_at`,
      [s.assignment.attemptId],
    );
    assert(calls.rows.some((row) => row.status === "completed"));
  }));

Deno.test("a session on another host does not get a local tool placed elsewhere (#441)", () =>
  withLocal(async (fixture) => {
    const s = await local(fixture);
    const snapshot = await reportSnapshot(fixture, s);
    // Move the placement to another host of the organization.
    const other = await registeredWorker(fixture, { slots: 1 });
    const otherHost = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.worker_hosts
        where organization_id = $1 and id <> $2
        order by created_at desc limit 1`,
      [fixture.organizationId, s.hostId],
    )).rows[0]!.id;
    assert(other.credential !== s.credential);
    await fixture.pgDatabase.query(
      "update bakery.mcp_connections set worker_host_id = $2 where id = $1",
      [s.connectionId, otherHost],
    );
    await bindStep(fixture, s, snapshot);
    const listed = await workerRequest(
      fixture,
      s.credential,
      `/v1/worker/attempts/${s.assignment.attemptId}/effective-tools`,
      lease(s),
    );
    const body = await listed.json() as {
      tools: unknown[];
      unavailable: { toolName: string; reason: string }[];
    };
    assertEquals(body.tools, []);
    assertEquals(body.unavailable.map((u) => [u.toolName, u.reason]), [[
      "echo",
      "host_not_placed",
    ]]);
    assertEquals((await openCall(fixture, s, { text: "hi" })).status, 403);
  }));
