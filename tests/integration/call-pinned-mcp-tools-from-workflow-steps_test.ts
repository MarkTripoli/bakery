import { assert, assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import { createPostgresMcpPinnedStatePort } from "../../apps/server/src/modules/mcp/postgres.ts";
import { createRemoteMcpToolTransport } from "../../apps/server/src/modules/mcp/tool-transport.ts";
import type { McpTransport } from "../../apps/server/src/modules/mcp/discovery-transport.ts";
import { createToolCallStepRunner } from "../../apps/server/src/modules/tool-call/tool-call-step.ts";
import type { EngineStepRequest } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

/**
 * #435 slices 2b and 2c on a real database: a tool.call step over an MCP
 * connection is sent by the server's own broker through the pinned-tool door. It
 * runs only for a step pinned at publish, only against the pinned snapshot, only
 * with arguments the pinned schema accepts, and never after the remote schema
 * drifted; each refusal happens before anything is sent. A read is sent directly;
 * every other tool is a write that goes through the effect ledger, where what an
 * unproven send means depends on how an Admin classified the tool.
 */

const databaseConfig = readTestDatabaseConfig();
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
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
    properties: {
      text: { type: "string", minLength: 1 },
      requestKey: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
};
const FIND_NOTE = {
  name: "find_note",
  description: "find a note",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    additionalProperties: false,
  },
};

type Sent = {
  method: string;
  params: Record<string, unknown>;
  auth: string | null;
};

/** A null answer is a reply nobody can read: the call may have arrived, and nothing says so. */
type Answer = (
  params: Record<string, unknown>,
) => Record<string, unknown> | null;

function fakeServer(answer: Answer) {
  const sent: Sent[] = [];
  const transport: McpTransport = (request) => {
    const message = JSON.parse(request.body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    sent.push({
      method: message.method,
      params: message.params ?? {},
      auth: request.headers.authorization ?? null,
    });
    if (message.method === "notifications/initialized") {
      return Promise.resolve({
        kind: "response",
        status: 202,
        contentType: "application/json",
        sessionId: null,
        body: "",
      });
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2026-07-28", capabilities: {} }
      : answer(message.params ?? {});
    if (result === null) {
      return Promise.resolve({
        kind: "response",
        status: 200,
        contentType: "application/json",
        sessionId: null,
        body: "this is not json-rpc",
      });
    }
    return Promise.resolve({
      kind: "response",
      status: 200,
      contentType: "application/json",
      sessionId: null,
      body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
    });
  };
  return {
    sent,
    transport,
    calls: () => sent.filter((s) => s.method === "tools/call"),
  };
}

async function world(
  fixture: WorkerFixture,
  options: {
    effectClass?: string | null;
    classifiedDigest?: string;
    pinned?: boolean;
    /** The run is pinned to the offline environment (#427), which may reach nothing outside. */
    offline?: boolean;
    snapshotDigest?: string;
    /** The tool the step calls; its classification is the one inserted. */
    tool?: string;
    keyArgument?: string;
    pairedRead?: string;
    /** What the step's binding admits; defaults to the tool alone. */
    allowed?: string[];
    /** Classify `find_note` as the read a reconcilable write is paired with. */
    withFindNote?: boolean;
  } = {},
) {
  const db = fixture.pgDatabase;
  const org = fixture.organizationId;
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const definitionId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, version)
     values ($1, $2, $3, 'Docs', 'streamable_http', '{}'::jsonb, 'https://mcp.example.com/mcp', '{}'::jsonb, '[]'::jsonb, 'rev', true, 1)`,
    [serverId, org, `s-${serverId.slice(0, 8)}`],
  );
  await db.query(
    `insert into bakery.mcp_connections (id, organization_id, server_id, label, config, enabled_capabilities, status, current_snapshot_id, version)
     values ($1, $2, $3, 'Docs', '{}'::jsonb, '["search","create_note","find_note"]'::jsonb, 'enabled', null, 1)`,
    [connectionId, org, serverId],
  );
  await db.query(
    `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, $5)`,
    [
      snapshotId,
      org,
      connectionId,
      JSON.stringify({ tools: [SEARCH, CREATE_NOTE, FIND_NOTE] }),
      DIGEST,
    ],
  );
  await db.query(
    "update bakery.mcp_connections set current_snapshot_id = $2 where id = $1",
    [connectionId, snapshotId],
  );
  if (options.snapshotDigest !== undefined) {
    // The remote server changed after the step was pinned.
    await db.query(
      `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
       values ($1, $2, $3, now() + interval '1 second', '2026-07-28', $4::jsonb, $5)`,
      [
        crypto.randomUUID(),
        org,
        connectionId,
        JSON.stringify({ tools: [SEARCH, CREATE_NOTE, FIND_NOTE] }),
        options.snapshotDigest,
      ],
    );
  }
  const tool = options.tool ?? "search";
  if (options.effectClass !== null) {
    await db.query(
      `insert into bakery.mcp_tool_classifications (organization_id, connection_id, tool_name, effect_class, effect_key_argument, paired_read_tool, snapshot_digest, classified_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        org,
        connectionId,
        tool,
        options.effectClass ?? "read",
        options.keyArgument ?? null,
        options.pairedRead ?? null,
        options.classifiedDigest ?? DIGEST,
        fixture.principalId,
      ],
    );
  }
  if (options.withFindNote === true) {
    await db.query(
      `insert into bakery.mcp_tool_classifications (organization_id, connection_id, tool_name, effect_class, snapshot_digest, classified_by)
       values ($1, $2, 'find_note', 'read', $3, $4)`,
      [org, connectionId, DIGEST, fixture.principalId],
    );
  }
  await db.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
     values ($1, $2, $3, 'Pinned', true, 1)`,
    [definitionId, org, `wf-${definitionId.slice(0, 8)}`],
  );
  await db.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision, source_yaml, normalized_spec, digest, status, created_by, version)
     values ($1, $2, $3, 1, '', '{}'::jsonb, 'd', 'published', $4, 1)`,
    [versionId, org, definitionId, fixture.principalId],
  );
  if (options.pinned !== false) {
    await db.query(
      `insert into bakery.capability_bindings (organization_id, workflow_version_id, step_key, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required)
       values ($1, $2, 'lookup', $3, $4, $5, null, $6::jsonb, true)`,
      [
        org,
        versionId,
        connectionId,
        snapshotId,
        DIGEST,
        JSON.stringify(options.allowed ?? [tool]),
      ],
    );
  }
  const job = await seedFundedModelJob(db, org, fixture.principalId);
  await db.query(
    "update bakery.workflow_runs set workflow_version_id = $3 where organization_id = $1 and id = $2",
    [org, job.runId, versionId],
  );
  if (options.offline === true) {
    await db.query(
      "update bakery.workflow_runs set environment = 'offline' where organization_id = $1 and id = $2",
      [org, job.runId],
    );
  }
  // The engine's own row for the step the effect belongs to.
  await db.query(
    `insert into bakery.run_steps (organization_id, run_id, step_key, position, iteration, status, input)
     values ($1, $2, 'lookup@2', 90, 0, 'running', '{}'::jsonb)`,
    [org, job.runId],
  );
  return { connectionId, runId: job.runId };
}

function runnerOver(
  fixture: WorkerFixture,
  server: ReturnType<typeof fakeServer>,
  mcpDb: ReturnType<typeof openDatabase>,
) {
  return createToolCallStepRunner({
    database: fixture.pgDatabase,
    registry: { integrations: [] } as never,
    providerRequests: {} as never,
    mcp: {
      pinnedState: createPostgresMcpPinnedStatePort(mcpDb),
      transport: createRemoteMcpToolTransport({
        database: fixture.pgDatabase,
        secretsKey: undefined,
        transport: server.transport,
      }),
    },
  });
}

function request(
  fixture: WorkerFixture,
  w: { connectionId: string; runId: string },
  args: unknown = { query: "bakery" },
  stepKey = "lookup@2",
  tool = "search",
): EngineStepRequest {
  return {
    organizationId: fixture.organizationId,
    runId: w.runId,
    taskId: w.runId,
    repositoryId: null,
    requestedBy: fixture.principalId,
    traceId: "trace",
    stepKey,
    iteration: 0,
    action: "tool.call",
    input: { connectionId: w.connectionId, tool, arguments: args },
  };
}

async function withRunner(
  body: (
    fixture: WorkerFixture,
    runner: ReturnType<typeof runnerOver>,
    server: ReturnType<typeof fakeServer>,
    w: { connectionId: string; runId: string },
  ) => Promise<void>,
  options: Parameters<typeof world>[1] = {},
  answer: Answer = () => ({ structuredContent: { hits: 2 } }),
) {
  const mcpDb = openDatabase(databaseConfig.databaseUrl);
  try {
    await withWorkerFixture(async (fixture) => {
      const server = fakeServer(answer);
      const w = await world(fixture, options);
      await body(fixture, runnerOver(fixture, server, mcpDb), server, w);
    });
  } finally {
    await closeDatabase(mcpDb);
  }
}

const code = (result: { kind: string; code?: string }) =>
  result.kind === "failed" ? result.code : result.kind;

Deno.test("a pinned read tool is called by the server's broker and its result comes back as the step's output (#435)", () =>
  withRunner(async (fixture, runner, server, w) => {
    // The step key in the run carries the repeat round; the pin does not.
    const result = await runner.run(request(fixture, w));
    assertEquals(result.kind, "completed");
    const output = (result as { output: Record<string, unknown> }).output;
    assertEquals(output.accepted, true);
    assertEquals(output.operation, "search");
    assertEquals(output.externalEffectId, null);
    assertEquals(output.result, { hits: 2 });
    assertEquals(server.calls().length, 1);
    assertEquals(server.calls()[0].params, {
      name: "search",
      arguments: { query: "bakery" },
    });
    // No credential on a connection without a secret.
    assertEquals(server.calls()[0].auth, null);
  }));

Deno.test("arguments the pinned schema refuses are never sent (#435)", () =>
  withRunner(async (fixture, runner, server, w) => {
    for (const args of [{}, { query: 5 }, { query: "x", extra: true }]) {
      const result = await runner.run(request(fixture, w, args));
      assertEquals(code(result), "TOOL_CALL_MCP_REFUSED_MCP_ARGUMENTS_INVALID");
    }
    assertEquals(server.sent.length, 0);
  }));

async function ledger(fixture: WorkerFixture) {
  const rows = await fixture.pgDatabase.query<{
    target: string;
    status: string;
    failure_code: string | null;
    adapter_manifest_digest: string | null;
    mcp_connection_id: string | null;
  }>(
    `select target, status, failure_code, adapter_manifest_digest, mcp_connection_id
       from bakery.external_effects where organization_id = $1
      order by created_at`,
    [fixture.organizationId],
  );
  return rows.rows;
}

const noteCalls = (server: ReturnType<typeof fakeServer>, name: string) =>
  server.calls().filter((call) => call.params.name === name);

Deno.test("an opaque or unclassified write is sent once through the ledger, and looking again sends nothing (#435)", async () => {
  for (const effectClass of [null, "write_opaque"]) {
    await withRunner(
      async (fixture, runner, server, w) => {
        const req = request(
          fixture,
          w,
          { text: "hello" },
          "lookup@2",
          "create_note",
        );
        const first = await runner.run(req);
        assertEquals(first.kind, "completed");
        const output = (first as { output: Record<string, unknown> }).output;
        assertEquals(output.operation, "create_note");
        assertEquals(output.result, { id: "n1" });
        // A second look at the same step finds the same effect.
        assertEquals((await runner.run(req)).kind, "completed");
        assertEquals(server.calls().length, 1);
        const rows = await ledger(fixture);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].status, "confirmed");
        assertEquals(rows[0].mcp_connection_id, w.connectionId);
        assertEquals(rows[0].adapter_manifest_digest, DIGEST);
        assert(rows[0].target.startsWith("mcp-tool:"));
      },
      { tool: "create_note", effectClass },
      () => ({ structuredContent: { id: "n1" } }),
    );
  }
});

Deno.test("an opaque write whose answer cannot be read stays unknown and is never sent a second time (#435)", () =>
  withRunner(
    async (fixture, runner, server, w) => {
      const req = request(
        fixture,
        w,
        { text: "hello" },
        "lookup@2",
        "create_note",
      );
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals(server.calls().length, 1);
      assertEquals((await ledger(fixture)).map((r) => r.status), ["uncertain"]);
    },
    { tool: "create_note", effectClass: "write_opaque" },
    () => null,
  ));

Deno.test("an idempotent write whose answer cannot be read is sent again under the same effect key (#435)", () => {
  let answered = 0;
  return withRunner(
    async (fixture, runner, server, w) => {
      const req = request(
        fixture,
        w,
        { text: "hello" },
        "lookup@2",
        "create_note",
      );
      assertEquals((await runner.run(req)).kind, "pending");
      // The retry is not due yet: looking again sends nothing.
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals(server.calls().length, 1);
      await fixture.pgDatabase.query(
        `update bakery.external_effects
            set next_retry_at = now() - interval '1 second'
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals((await runner.run(req)).kind, "completed");
      assertEquals(server.calls().length, 2);
      const keys = server.calls().map((call) =>
        (call.params.arguments as Record<string, unknown>).requestKey
      );
      assertEquals(keys[0], keys[1]);
      assertEquals(keys[0], `${w.runId}:lookup@2:0`);
      assertEquals((await ledger(fixture)).map((r) => r.status), ["confirmed"]);
    },
    {
      tool: "create_note",
      effectClass: "write_idempotent",
      keyArgument: "requestKey",
    },
    () => (answered++ === 0 ? null : { structuredContent: { id: "n1" } }),
  );
});

Deno.test("a reconcilable write whose answer cannot be read is confirmed by its paired read, never sent again (#435)", async () => {
  const options = {
    tool: "create_note",
    effectClass: "write_reconcilable",
    pairedRead: "find_note",
    withFindNote: true,
    allowed: ["create_note", "find_note"],
  };
  // The read finds the note: the write is proven.
  await withRunner(
    async (fixture, runner, server, w) => {
      const req = request(
        fixture,
        w,
        { text: "hello" },
        "lookup@2",
        "create_note",
      );
      assertEquals((await runner.run(req)).kind, "pending");
      const second = await runner.run(req);
      assertEquals(second.kind, "completed");
      assertEquals(
        server.calls().map((call) => call.params.name),
        ["create_note", "find_note"],
      );
      assertEquals(noteCalls(server, "find_note")[0].params.arguments, {
        text: "hello",
      });
      assertEquals((await ledger(fixture)).map((r) => r.status), ["confirmed"]);
    },
    options,
    (params) =>
      params.name === "create_note"
        ? null
        : { structuredContent: { found: [{ text: "hello" }] } },
  );
  // The read finds nothing: still unproven, and the write is still not resent.
  await withRunner(
    async (fixture, runner, server, w) => {
      const req = request(
        fixture,
        w,
        { text: "hello" },
        "lookup@2",
        "create_note",
      );
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals((await runner.run(req)).kind, "pending");
      assertEquals(noteCalls(server, "create_note").length, 1);
      assertEquals((await ledger(fixture)).map((r) => r.status), ["uncertain"]);
    },
    options,
    (params) =>
      params.name === "create_note"
        ? null
        : { structuredContent: { found: [] } },
  );
});

Deno.test("a reconcilable write whose paired read is not pinned to the step is not sent (#435)", () =>
  withRunner(
    async (fixture, runner, server, w) => {
      const result = await runner.run(
        request(fixture, w, { text: "hello" }, "lookup@2", "create_note"),
      );
      assertEquals(code(result), "TOOL_CALL_MCP_RECONCILE_UNPINNED");
      assertEquals(server.sent.length, 0);
      assertEquals((await ledger(fixture)).length, 0);
    },
    {
      tool: "create_note",
      effectClass: "write_reconcilable",
      pairedRead: "find_note",
      withFindNote: true,
      allowed: ["create_note"],
    },
  ));

Deno.test("a write the server answers with a failure is failed, not left waiting (#435)", () =>
  withRunner(
    async (fixture, runner, server, w) => {
      const result = await runner.run(
        request(fixture, w, { text: "hello" }, "lookup@2", "create_note"),
      );
      assertEquals(code(result), "TOOL_CALL_EFFECT_FAILED");
      assertEquals(server.calls().length, 1);
      const rows = await ledger(fixture);
      assertEquals(rows.map((r) => [r.status, r.failure_code]), [[
        "failed",
        "provider_rejected",
      ]]);
    },
    { tool: "create_note", effectClass: "write_opaque" },
    () => ({ isError: true, content: [{ type: "text", text: "no" }] }),
  ));

Deno.test("a classification made against another snapshot is stale and nothing is sent (#435)", () =>
  withRunner(async (fixture, runner, server, w) => {
    const result = await runner.run(request(fixture, w));
    assertEquals(code(result), "TOOL_CALL_MCP_CLASSIFICATION_STALE");
    assertEquals(server.sent.length, 0);
  }, { classifiedDigest: OTHER_DIGEST }));

Deno.test("a remote schema that changed since the step was pinned refuses the call, naming the drift (#435)", () =>
  withRunner(async (fixture, runner, server, w) => {
    const result = await runner.run(request(fixture, w));
    assertEquals(code(result), "TOOL_CALL_MCP_REFUSED_SCHEMA_DRIFT");
    assertEquals(server.sent.length, 0);
  }, { snapshotDigest: OTHER_DIGEST }));

Deno.test("an offline run sends no MCP tool, read or write (#435)", async () => {
  await withRunner(async (fixture, runner, server, w) => {
    const result = await runner.run(request(fixture, w));
    assertEquals(code(result), "TOOL_CALL_MCP_OFFLINE");
    assertEquals(server.sent.length, 0);
  }, { offline: true });
  await withRunner(
    async (fixture, runner, server, w) => {
      const result = await runner.run(
        request(fixture, w, { text: "hello" }, "lookup@2", "create_note"),
      );
      assertEquals(code(result), "TOOL_CALL_MCP_OFFLINE");
      assertEquals(server.sent.length, 0);
      assertEquals((await ledger(fixture)).length, 0);
    },
    { offline: true, tool: "create_note", effectClass: "write_opaque" },
  );
});

Deno.test("a step that was not pinned at publish is refused, not sent (#435)", () =>
  withRunner(async (fixture, runner, server, w) => {
    const result = await runner.run(request(fixture, w));
    assertEquals(code(result), "TOOL_CALL_MCP_NOT_PINNED");
    assertEquals(server.sent.length, 0);
  }, { pinned: false }));

Deno.test("a tool that reports its own failure fails the step, and a huge result is refused (#435)", async () => {
  await withRunner(
    async (fixture, runner, _server, w) => {
      const result = await runner.run(request(fixture, w));
      assertEquals(code(result), "TOOL_CALL_MCP_TOOL_FAILED");
    },
    {},
    () => ({ isError: true, content: [{ type: "text", text: "boom" }] }),
  );
  await withRunner(
    async (fixture, runner, _server, w) => {
      const result = await runner.run(request(fixture, w));
      assertEquals(code(result), "TOOL_CALL_MCP_RESULT_TOO_LARGE");
    },
    {},
    () => ({ structuredContent: { blob: "x".repeat(300 * 1024) } }),
  );
  assert(true);
});
