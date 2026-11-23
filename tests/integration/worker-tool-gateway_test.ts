import { assert, assertEquals } from "@std/assert";
import {
  type GatewayTool,
  startToolGateway,
  type ToolGatewayBackend,
} from "../../apps/worker/src/tool-gateway.ts";

// #436: the worker-local tool gateway is one loopback MCP endpoint per agent
// session. It lists exactly the tools the server said are effective, sends each
// call to worker.invokeTool with a fresh key, and answers nobody without the
// session's bearer.

const SEARCH: GatewayTool = {
  name: "search",
  toolName: "search",
  connectionId: "44444444-4444-4444-8444-444444444444",
  description: "search docs",
  inputSchema: { type: "object" },
  readOnly: true,
};

function backend() {
  const calls: { tool: string; arguments: unknown; key: string }[] = [];
  const value: ToolGatewayBackend = {
    listTools: () => Promise.resolve([SEARCH]),
    invokeTool: (input) => {
      calls.push({
        tool: input.tool.toolName,
        arguments: input.arguments,
        key: input.idempotencyKey,
      });
      return Promise.resolve({
        content: [{ type: "text", text: "2 hits" }],
        isError: false,
      });
    },
  };
  return { calls, value };
}

async function rpc(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

Deno.test("the gateway lists the session's effective tools and sends a call to the backend with a fresh key", async () => {
  const fake = backend();
  const gateway = await startToolGateway(fake.value);
  try {
    assert(gateway.url.startsWith("http://127.0.0.1:"));
    const init = await rpc(gateway.url, gateway.token, {
      id: 1,
      method: "initialize",
      params: {},
    });
    assertEquals(
      (init.json?.result as { serverInfo: { name: string } }).serverInfo.name,
      "bakery",
    );
    const note = await rpc(gateway.url, gateway.token, {
      method: "notifications/initialized",
    });
    assertEquals(note.status, 202);
    const listed = await rpc(gateway.url, gateway.token, {
      id: 2,
      method: "tools/list",
    });
    assertEquals(
      (listed.json?.result as { tools: { name: string }[] }).tools.map((t) =>
        t.name
      ),
      ["search"],
    );
    for (const id of [3, 4]) {
      const called = await rpc(gateway.url, gateway.token, {
        id,
        method: "tools/call",
        params: { name: "search", arguments: { query: "bakery" } },
      });
      assertEquals(called.json?.result, {
        content: [{ type: "text", text: "2 hits" }],
        isError: false,
      });
    }
    assertEquals(fake.calls.length, 2);
    assertEquals(fake.calls[0]!.arguments, { query: "bakery" });
    // Every call is its own: two calls never share a key.
    assert(fake.calls[0]!.key !== fake.calls[1]!.key);
    assertEquals(gateway.mcpConfig(), {
      mcpServers: {
        bakery: {
          type: "http",
          url: gateway.url,
          headers: { Authorization: `Bearer ${gateway.token}` },
        },
      },
    });
  } finally {
    await gateway.close();
  }
});

Deno.test("a tool the gateway did not list is refused without reaching the backend", async () => {
  const fake = backend();
  const gateway = await startToolGateway(fake.value);
  try {
    const called = await rpc(gateway.url, gateway.token, {
      id: 1,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    assertEquals(
      (called.json?.error as { code: number }).code,
      -32602,
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    await gateway.close();
  }
});

Deno.test("the gateway answers nobody without the session's bearer", async () => {
  const fake = backend();
  const gateway = await startToolGateway(fake.value);
  try {
    const refused = await rpc(gateway.url, "not-the-token", {
      id: 1,
      method: "tools/list",
    });
    assertEquals(refused.status, 401);
    const get = await fetch(gateway.url);
    await get.body?.cancel();
    assertEquals(get.status, 405);
  } finally {
    await gateway.close();
  }
});

Deno.test("a call the server refuses reaches the agent as a failed call, not the server's detail", async () => {
  const gateway = await startToolGateway({
    listTools: () => Promise.resolve([SEARCH]),
    invokeTool: () => Promise.reject(new Error("AUTH_FORBIDDEN secret detail")),
  });
  try {
    const called = await rpc(gateway.url, gateway.token, {
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    const result = called.json?.result as { isError: boolean };
    assertEquals(result.isError, true);
    assert(!JSON.stringify(result).includes("secret detail"));
  } finally {
    await gateway.close();
  }
});
