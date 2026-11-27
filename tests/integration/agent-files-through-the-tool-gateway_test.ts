import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { createSessionApi } from "../../packages/cli/src/session-call.ts";
import { bakeryFilesTools } from "../../apps/worker/src/files-gateway-tools.ts";
import {
  answerGatewayMessage,
  type ToolGatewayBackend,
} from "../../apps/worker/src/tool-gateway.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

async function asPerson(
  fixture: Fixture,
  method: string,
  path: string,
  body: unknown,
  status: number,
): Promise<Json> {
  const response = await fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

async function agentFilesTools(
  fixture: Fixture,
  name: string,
  writeFolderId: string | null,
) {
  const worker = await registeredWorker(fixture, { name, slots: 1 });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  if (writeFolderId !== null) {
    await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
      workflowId: job.workflowId,
      folderId: writeFolderId,
      access: "write",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, 201);
  }
  const assignment = await claimAssignment(fixture, worker) as
    & Awaited<ReturnType<typeof claimAssignment>>
    & { sessionCredential?: string };
  assert(assignment.sessionCredential, "the claim mints a session credential");
  const session = createSessionApi(
    {
      baseUrl: fixture.config.publicBaseUrl,
      sessionToken: assignment.sessionCredential,
    },
    (input, init) =>
      Promise.resolve(fixture.app.fetch(new Request(input, init))),
  );
  return {
    attemptId: assignment.attemptId,
    tools: await bakeryFilesTools(session),
  };
}

const noMcp: ToolGatewayBackend = {
  listTools: () => Promise.resolve([]),
  invokeTool: () => Promise.reject(new Error("no MCP tools in this test")),
};

async function gatewayCall(
  tools: Awaited<ReturnType<typeof agentFilesTools>>["tools"],
  name: string,
  args: Json,
): Promise<unknown> {
  const answer = await answerGatewayMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    [],
    noMcp,
    undefined,
    tools,
  ) as { result: { content: { text: string }[]; isError: boolean } };
  assertEquals(answer.result.isError, false, answer.result.content[0].text);
  return JSON.parse(answer.result.content[0].text);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("an agent writes and reads Bakery Files through the tool gateway, and the step records both", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await asPerson(fixture, "POST", "/v1/storage/folders", {
      path: "/shared/gateway-451",
    }, 201);
    const agent = await agentFilesTools(
      fixture,
      "gateway-451-writer",
      folder.id as string,
    );
    const names = agent.tools.map((tool) => tool.name);
    for (
      const expected of [
        "bakery_files_list",
        "bakery_files_read",
        "bakery_files_write",
      ]
    ) {
      assert(names.includes(expected), `${expected} is listed: ${names}`);
    }

    const listed = await answerGatewayMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      [],
      noMcp,
      undefined,
      agent.tools,
    ) as { result: { tools: { name: string }[] } };
    assertEquals(
      listed.result.tools.map((tool) => tool.name),
      names,
      "tools/list shows the Bakery Files tools",
    );

    const bytes = new TextEncoder().encode("gateway bytes");
    const written = await gatewayCall(agent.tools, "bakery_files_write", {
      path: "/shared/gateway-451/notes.md",
      mediaType: "text/markdown",
      content: btoa("gateway bytes"),
    }) as Json;
    const read = await gatewayCall(agent.tools, "bakery_files_read", {
      id: written.id,
    });
    assertEquals(read, btoa("gateway bytes"));

    const writes = await fixture.pgDatabase.query<
      { op: string; new_version_id: string | null }
    >(
      `select op, new_version_id from bakery.step_write_set
        where organization_id = $1 and attempt_id = $2 and entry_id = $3`,
      [fixture.organizationId, agent.attemptId, written.id],
    );
    assertEquals(writes.rows.map((row) => row.op), ["put"]);
    const reads = await fixture.pgDatabase.query<
      { version_id: string | null; sha256: string }
    >(
      `select version_id, sha256 from bakery.step_read_set
        where organization_id = $1 and attempt_id = $2 and entry_id = $3`,
      [fixture.organizationId, agent.attemptId, written.id],
    );
    assertEquals(reads.rows, [{
      version_id: writes.rows[0].new_version_id,
      sha256: await sha256Hex(bytes),
    }]);
  }));

Deno.test("the gateway lists no write tool for a step its grants do not let write", () =>
  withWorkerFixture(async (fixture) => {
    const agent = await agentFilesTools(fixture, "gateway-451-reader", null);
    const names = agent.tools.map((tool) => tool.name);
    assert(!names.includes("bakery_files_write"), `${names}`);
    assert(!names.includes("bakery_files_mkdir"), `${names}`);
  }));
