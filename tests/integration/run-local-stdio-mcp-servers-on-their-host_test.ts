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

type Json = Record<string, unknown>;

function asAdmin(
  fixture: WorkerFixture,
  method: string,
  path: string,
  body: unknown,
  ifMatch?: number,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
        ...(ifMatch === undefined ? {} : { "If-Match": '"' + ifMatch + '"' }),
      },
      body: JSON.stringify(body),
    }),
  ));
}

async function json(response: Response, status: number): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

async function problemField(response: Response): Promise<string[]> {
  const text = await response.text();
  assertEquals(response.status, 422, text);
  return text.match(/"[a-z_]+"/g)?.map((m) => m.slice(1, -1)) ?? [];
}

async function server(
  fixture: WorkerFixture,
  definition: Json,
): Promise<string> {
  const created = await json(
    await asAdmin(fixture, "POST", "/v1/mcp-servers", {
      slug: "f-" + crypto.randomUUID().slice(0, 8),
      name: "Files",
      configSchema: { type: "object" },
      requiredCapabilities: [],
      sourceRevision: "rev",
      ...definition,
    }),
    201,
  );
  await json(
    await asAdmin(
      fixture,
      "PATCH",
      "/v1/mcp-servers/" + created.id,
      { enabled: true },
      created.version as number,
    ),
    200,
  );
  return created.id as string;
}

async function placedConnection(
  fixture: WorkerFixture,
  hostId: string,
): Promise<string> {
  const serverId = await server(fixture, {
    transport: "stdio",
    launchSpec: LAUNCH,
  });
  const created = await json(
    await asAdmin(fixture, "POST", "/v1/mcp-connections", {
      serverId,
      label: "Files",
      config: {},
      enabledCapabilities: [],
      scope: "organization",
      workerHostId: hostId,
    }),
    201,
  );
  assertEquals(created.workerHostId, hostId);
  return created.id as string;
}

async function updateConnection(
  fixture: WorkerFixture,
  connectionId: string,
  patch: Json,
): Promise<Response> {
  const { version } = (await fixture.pgDatabase.query<{ version: number }>(
    "select version from bakery.mcp_connections where id = $1",
    [connectionId],
  )).rows[0]!;
  return await asAdmin(
    fixture,
    "PATCH",
    "/v1/mcp-connections/" + connectionId,
    patch,
    version,
  );
}

async function enableEcho(fixture: WorkerFixture, connectionId: string) {
  await json(
    await updateConnection(fixture, connectionId, {
      enabledCapabilities: ["echo"],
    }),
    200,
  );
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
  toolName = "echo",
) {
  return workerRequest(
    fixture,
    s.credential,
    `/v1/worker/attempts/${s.assignment.attemptId}/local-tool-calls`,
    {
      ...lease(s),
      mcpConnectionId: s.connectionId,
      toolName,
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
async function toolFeed(
  fixture: WorkerFixture,
  s: Local,
): Promise<{ phase: string; ok: boolean | null }[]> {
  const session = await fixture.pgDatabase.query<{ id: string }>(
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
  const response = await asAdmin(
    fixture,
    "GET",
    `/v1/sessions/${session.rows[0]!.id}/feed`,
    undefined,
  );
  const body = await json(response, 200);
  const items = body.items;
  assert(Array.isArray(items));
  return items.flatMap((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("tool" in item) ||
      item.tool === null
    ) return [];
    const tool = item.tool;
    assert(
      typeof tool === "object" &&
        "phase" in tool &&
        typeof tool.phase === "string" &&
        "ok" in tool &&
        (typeof tool.ok === "boolean" || tool.ok === null),
    );
    return [{ phase: tool.phase, ok: tool.ok }];
  });
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
    assertEquals(
      (await reportSnapshot(fixture, s)).snapshotId,
      pinned.snapshotId,
    );

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
    const pinned = await reportSnapshot(fixture, s);
    await enableEcho(fixture, s.connectionId);
    await bindStep(fixture, s, pinned);
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

    const refused = await openCall(fixture, s, { text: 5 });
    assertEquals(refused.status, 422);

    const key = crypto.randomUUID();
    const opened = await openCall(fixture, s, { text: "hi" }, key);
    assertEquals(opened.status, 200);
    const open = await opened.json() as { callId: string; status: string };
    assertEquals(open.status, "open");
    assertEquals(await toolFeed(fixture, s), [
      { phase: "started", ok: null },
      { phase: "failed", ok: false },
      { phase: "started", ok: null },
    ]);
    assertEquals((await openCall(fixture, s, { text: "hi" }, key)).status, 409);

    const settled = await settleCall(fixture, s, open.callId, {
      status: "completed",
      content: [{ type: "text", text: "hi" }],
      isError: true,
    });
    assertEquals(settled.status, 200);
    const lifecycle = [
      { phase: "started", ok: null },
      { phase: "failed", ok: false },
      { phase: "started", ok: null },
      { phase: "completed", ok: false },
    ];
    assertEquals(await toolFeed(fixture, s), lifecycle);
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
    assertEquals(await toolFeed(fixture, s), lifecycle);
    const otherTool = await openCall(fixture, s, { text: "hi" }, key, "probe");
    assertEquals(otherTool.status, 422);
    assertEquals(await problemCode(otherTool), "IDEMPOTENCY_PAYLOAD_MISMATCH");
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
    await enableEcho(fixture, s.connectionId);
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

Deno.test("create refuses a placement on an unknown host, a missing one, or a remote connection (#441)", () =>
  withLocal(async (fixture) => {
    const s = await local(fixture);
    const before = (await fixture.pgDatabase.query<{ version: number }>(
      "select version from bakery.mcp_connections where id = $1",
      [s.connectionId],
    )).rows[0]!.version;

    const stranger = crypto.randomUUID();
    const stdioServer = await server(fixture, {
      transport: "stdio",
      launchSpec: LAUNCH,
    });
    const stdioInput = {
      serverId: stdioServer,
      label: "Files",
      config: {},
      enabledCapabilities: [],
      scope: "organization",
    };
    assert(
      (await problemField(
        await asAdmin(fixture, "POST", "/v1/mcp-connections", {
          ...stdioInput,
          workerHostId: stranger,
        }),
      )).includes("worker_host_unknown"),
    );
    assert(
      (await problemField(
        await asAdmin(fixture, "POST", "/v1/mcp-connections", stdioInput),
      )).includes("worker_host_required"),
    );

    const remoteServer = await server(fixture, {
      transport: "streamable_http",
      endpointTemplate: "https://mcp.example.com/mcp",
    });
    const remoteInput = {
      serverId: remoteServer,
      label: "Docs",
      config: {},
      enabledCapabilities: [],
      scope: "organization",
    };
    assert(
      (await problemField(
        await asAdmin(fixture, "POST", "/v1/mcp-connections", {
          ...remoteInput,
          workerHostId: s.hostId,
        }),
      )).includes("worker_host_not_for_remote"),
    );
    const row = (await fixture.pgDatabase.query<{
      worker_host_id: string;
      version: number;
    }>(
      "select worker_host_id, version from bakery.mcp_connections where id = $1",
      [s.connectionId],
    )).rows[0]!;
    assertEquals(row, { worker_host_id: s.hostId, version: before });
  }));
