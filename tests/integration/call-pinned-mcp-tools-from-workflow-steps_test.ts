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
 * #435 slice 2b on a real database: a tool.call step over an MCP connection is
 * sent by the server's own broker through the pinned-tool door. It runs only for
 * a step pinned at publish, only for a tool classified a read against the pinned
 * snapshot, only with arguments the pinned schema accepts, and never after the
 * remote schema drifted; each refusal happens before anything is sent.
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

type Sent = {
  method: string;
  params: Record<string, unknown>;
  auth: string | null;
};

function fakeServer(
  answer: (params: Record<string, unknown>) => Record<string, unknown>,
) {
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
    snapshotDigest?: string;
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
     values ($1, $2, $3, 'Docs', '{}'::jsonb, '["search"]'::jsonb, 'enabled', null, 1)`,
    [connectionId, org, serverId],
  );
  await db.query(
    `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, $5)`,
    [
      snapshotId,
      org,
      connectionId,
      JSON.stringify({ tools: [SEARCH] }),
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
        JSON.stringify({ tools: [SEARCH] }),
        options.snapshotDigest,
      ],
    );
  }
  if (options.effectClass !== null) {
    await db.query(
      `insert into bakery.mcp_tool_classifications (organization_id, connection_id, tool_name, effect_class, snapshot_digest, classified_by)
       values ($1, $2, 'search', $3, $4, $5)`,
      [
        org,
        connectionId,
        options.effectClass ?? "read",
        options.classifiedDigest ?? DIGEST,
        fixture.principalId,
      ],
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
       values ($1, $2, 'lookup', $3, $4, $5, null, '["search"]'::jsonb, true)`,
      [org, versionId, connectionId, snapshotId, DIGEST],
    );
  }
  const job = await seedFundedModelJob(db, org, fixture.principalId);
  await db.query(
    "update bakery.workflow_runs set workflow_version_id = $3 where organization_id = $1 and id = $2",
    [org, job.runId, versionId],
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
    input: { connectionId: w.connectionId, tool: "search", arguments: args },
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
  answer: (params: Record<string, unknown>) => Record<string, unknown> =
    () => ({
      structuredContent: { hits: 2 },
    }),
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

Deno.test("a tool that is a write, or classified at all, is not sent until the ledger path exists (#435)", async () => {
  for (const effectClass of ["write_idempotent", "write_opaque", null]) {
    await withRunner(async (fixture, runner, server, w) => {
      const result = await runner.run(request(fixture, w));
      assertEquals(code(result), "TOOL_CALL_MCP_WRITE_UNAVAILABLE");
      assertEquals(server.sent.length, 0);
    }, { effectClass });
  }
});

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
