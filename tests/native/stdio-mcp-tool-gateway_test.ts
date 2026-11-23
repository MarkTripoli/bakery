import { assert, assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createToolGatewayFactory,
  type GatewayTool,
} from "../../apps/worker/src/tool-gateway.ts";
import { discoverLocalMcpServers } from "../../apps/worker/src/local-mcp-discovery.ts";
import {
  launchStdioMcpServer,
  type StdioIsolation,
} from "../../apps/worker/src/stdio-mcp.ts";

/**
 * #441 with a real local server under bubblewrap: a session's gateway calls a
 * local (stdio) tool only after the server opened the call, launches the pinned
 * server on that first call (sandboxed unless allowlisted), and reports how it
 * ended; the host discovers its placed servers and reports what they list.
 */

const FIXTURE = new URL(
  "../fixtures/stdio-mcp/fixture-server.sh",
  import.meta.url,
).pathname;
const RUN = { sanitizeResources: false, sanitizeOps: false } as const;
const CONNECTION = "66666666-6666-4666-8666-666666666666";
const CALL = "77777777-7777-4777-8777-777777777777";

async function launchSpec(digest?: string) {
  return {
    command: FIXTURE,
    args: [],
    artifactDigest: digest ??
      createHash("sha256").update(await readFile(FIXTURE)).digest("hex"),
  };
}

function tool(spec: GatewayTool["launchSpec"], readOnly = false): GatewayTool {
  return {
    name: "echo",
    toolName: "echo",
    connectionId: CONNECTION,
    description: "Echoes text.",
    inputSchema: { type: "object" },
    readOnly,
    launchSpec: spec,
  };
}

type Settled = { callId: string; outcome: Record<string, unknown> };

function fakeClient(
  tools: GatewayTool[],
  open: "open" | "completed" | "refused" = "open",
) {
  const opened: Record<string, unknown>[] = [];
  const settled: Settled[] = [];
  let remoteCalls = 0;
  const client = {
    effectiveTools: () => Promise.resolve({ value: { tools } }),
    invokeTool: () => {
      remoteCalls++;
      return Promise.resolve({ value: { content: [], isError: false } });
    },
    openLocalToolCall: (_attempt: string, input: Record<string, unknown>) => {
      opened.push(input);
      if (open === "refused") {
        return Promise.reject(new Error("WORKER_REQUEST_FORBIDDEN"));
      }
      return Promise.resolve({
        value: open === "open"
          ? { callId: CALL, status: "open" as const, result: null }
          : {
            callId: CALL,
            status: "completed" as const,
            result: {
              content: [{ type: "text", text: "earlier" }],
              isError: false,
            },
          },
      });
    },
    settleLocalToolCall: (
      _attempt: string,
      callId: string,
      outcome: Record<string, unknown>,
    ) => {
      settled.push({ callId, outcome });
      return Promise.resolve();
    },
  };
  return { client, opened, settled, remoteCalls: () => remoteCalls };
}

const authority = () =>
  Promise.resolve({ workerSessionId: "s", workerSessionGeneration: "1" });
const assignment = { attemptId: "a", leaseToken: "l", fence: "1" };

async function call(url: string, token: string, name: string, args: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()).result as {
    content: { text: string }[];
    isError: boolean;
  };
}

Deno.test(
  "a local tool is opened on the server, run in the sandbox, and its outcome reported",
  RUN,
  async () => {
    const launches: StdioIsolation[] = [];
    const fake = fakeClient([tool(await launchSpec())]);
    const factory = createToolGatewayFactory(fake.client, authority, {
      stdioAllowlist: [],
      launch: async (spec, options) => {
        const server = await launchStdioMcpServer(spec, options);
        launches.push(server.isolation);
        return server;
      },
    });
    const gateway = await factory(assignment);
    try {
      const first = await call(gateway.url, gateway.token, "echo", {
        text: "one",
      });
      const second = await call(gateway.url, gateway.token, "echo", {
        text: "two",
      });
      assertEquals(first.content[0]!.text, "one");
      assertEquals(second.content[0]!.text, "two");
      // One sandboxed process for the session, launched on the first call.
      assertEquals(launches, ["sandbox"]);
      assertEquals(fake.remoteCalls(), 0);
      assertEquals(fake.opened.map((input) => input.toolName), [
        "echo",
        "echo",
      ]);
      assertEquals(fake.settled.map((s) => s.outcome.status), [
        "completed",
        "completed",
      ]);
    } finally {
      await gateway.close();
    }
  },
);

Deno.test(
  "a local call the server refuses never launches anything",
  RUN,
  async () => {
    let launched = 0;
    const fake = fakeClient([tool(await launchSpec())], "refused");
    const gateway = await createToolGatewayFactory(fake.client, authority, {
      stdioAllowlist: [],
      launch: (spec, options) => {
        launched++;
        return launchStdioMcpServer(spec, options);
      },
    })(assignment);
    try {
      const answer = await call(gateway.url, gateway.token, "echo", {
        text: "x",
      });
      assert(answer.isError);
      assertEquals(launched, 0);
      assertEquals(fake.settled, []);
    } finally {
      await gateway.close();
    }
  },
);

Deno.test(
  "a replayed local call answers what happened without running again",
  RUN,
  async () => {
    let launched = 0;
    const fake = fakeClient([tool(await launchSpec())], "completed");
    const gateway = await createToolGatewayFactory(fake.client, authority, {
      stdioAllowlist: [],
      launch: (spec, options) => {
        launched++;
        return launchStdioMcpServer(spec, options);
      },
    })(assignment);
    try {
      const answer = await call(gateway.url, gateway.token, "echo", {
        text: "x",
      });
      assertEquals(answer.content[0]!.text, "earlier");
      assertEquals(launched, 0);
    } finally {
      await gateway.close();
    }
  },
);

Deno.test(
  "a local server whose command drifted from its pin is reported failed, never run",
  RUN,
  async () => {
    const fake = fakeClient([tool(await launchSpec("0".repeat(64)))]);
    const gateway = await createToolGatewayFactory(fake.client, authority, {
      stdioAllowlist: [],
    })(assignment);
    try {
      const answer = await call(gateway.url, gateway.token, "echo", {
        text: "x",
      });
      assert(answer.isError);
      assertEquals(fake.settled, [{
        callId: CALL,
        outcome: {
          status: "failed",
          failureCode: "stdio_mcp_artifact_mismatch",
        },
      }]);
    } finally {
      await gateway.close();
    }
  },
);

Deno.test(
  "the host discovers each local server placed on it and reports what it lists",
  RUN,
  async () => {
    const reports: {
      connectionId: string;
      protocolVersion: string;
      names: string[];
    }[] = [];
    const spec = await launchSpec();
    const pages = [
      {
        items: [{
          connectionId: CONNECTION,
          launchSpec: spec,
          currentDigest: null,
        }],
        nextCursor: CONNECTION,
      },
      {
        items: [{
          connectionId: CALL,
          launchSpec: await launchSpec("0".repeat(64)),
          currentDigest: null,
        }],
        nextCursor: null,
      },
    ];
    const afters: (string | null)[] = [];
    const outcomes = await discoverLocalMcpServers({
      localMcpConnections: (after) => {
        afters.push(after);
        return Promise.resolve({ value: pages[afters.length - 1]! });
      },
      reportLocalMcpSnapshot: (connectionId, report) => {
        reports.push({
          connectionId,
          protocolVersion: report.protocolVersion,
          names: report.tools.map((t) => (t as { name: string }).name),
        });
        return Promise.resolve({ value: { digest: "d".repeat(64) } });
      },
    }, { allowlist: [] });
    assertEquals(afters, [null, CONNECTION]);
    assertEquals(reports, [{
      connectionId: CONNECTION,
      protocolVersion: "2026-07-28",
      names: ["echo", "probe"],
    }]);
    assertEquals(outcomes, [
      { connectionId: CONNECTION, digest: "d".repeat(64), failure: null },
      {
        connectionId: CALL,
        digest: null,
        failure: "STDIO_MCP_ARTIFACT_MISMATCH",
      },
    ]);
  },
);

Deno.test(
  "an unknown outcome of a local write stays sent for a person to settle",
  RUN,
  async () => {
    const fake = fakeClient([tool(await launchSpec())]);
    const gateway = await createToolGatewayFactory(fake.client, authority, {
      stdioAllowlist: [],
      launch: async (spec, options) => {
        const server = await launchStdioMcpServer(spec, options);
        return {
          ...server,
          callTool: () => Promise.reject(new Error("connection lost mid-call")),
        };
      },
    })(assignment);
    try {
      const answer = await call(gateway.url, gateway.token, "echo", {
        text: "x",
      });
      assert(answer.isError);
      assertEquals(fake.settled, []);
    } finally {
      await gateway.close();
    }
  },
);
