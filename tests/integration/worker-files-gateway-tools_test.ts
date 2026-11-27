import { assert, assertEquals } from "@std/assert";
import { ApiProblemError } from "../../packages/contracts/src/client.ts";
import {
  type SessionApi,
  SessionRefusal,
} from "../../packages/cli/src/session-call.ts";
import { bakeryFilesTools } from "../../apps/worker/src/files-gateway-tools.ts";
import {
  createToolGatewayFactory,
  gatewayOffersTools,
  type GatewayTool,
  startToolGateway,
  type ToolGatewaySession,
} from "../../apps/worker/src/tool-gateway.ts";

type Call = { tool: string; args: unknown; ifMatch?: number };

function fakeSession(
  offered: readonly string[],
  answer: (call: Call) => unknown,
): { session: SessionApi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    session: {
      tools: () =>
        Promise.resolve(offered.map((name) => ({
          name,
          method: "GET",
          path: "/",
          scope: "files.read",
          readOnly: true,
        }))),
      call: (tool, args, ifMatch) => {
        const call = {
          tool,
          args,
          ...(ifMatch === undefined ? {} : { ifMatch }),
        };
        calls.push(call);
        return Promise.resolve().then(() => answer(call));
      },
    },
  };
}

const ALL_FILE_OPERATIONS = [
  "storageRoots.list",
  "storageFolderEntries.list",
  "storageFileVersions.list",
  "storageFiles.byVersion",
  "storageFiles.content",
  "files.search",
  "storageFiles.put",
  "storageFolders.create",
];

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

Deno.test("a Bakery Files tool is listed only when every operation it calls is offered", async () => {
  const readOnly = fakeSession(
    ["storageFileVersions.list", "storageFiles.content"],
    () => null,
  );
  assertEquals(
    (await bakeryFilesTools(readOnly.session)).map((tool) => tool.name),
    ["bakery_files_read"],
  );
  const all = fakeSession(ALL_FILE_OPERATIONS, () => null);
  assertEquals(
    (await bakeryFilesTools(all.session)).map((tool) => tool.name),
    [
      "bakery_files_roots",
      "bakery_files_list",
      "bakery_files_stat",
      "bakery_files_read",
      "bakery_files_search",
      "bakery_files_write",
      "bakery_files_mkdir",
    ],
  );
});

Deno.test("stat names the version and write sends it as If-Match, not as an argument", async () => {
  const fake = fakeSession(
    ALL_FILE_OPERATIONS,
    (call) =>
      call.tool === "storageFileVersions.list"
        ? { items: [{ id: "v-2", revision: 2, sha256: "ab" }] }
        : call.tool === "storageFiles.byVersion"
        ? { file: { id: "f-1", version: 7 } }
        : { id: "f-1", version: 8 },
  );
  const tools = await bakeryFilesTools(fake.session);
  const named = (name: string) => tools.find((tool) => tool.name === name)!;
  const stat = await named("bakery_files_stat").call({ id: "f-1" });
  assertEquals(JSON.parse(text(stat)), {
    id: "f-1",
    version: 7,
    revision: 2,
    sha256: "ab",
  });
  await named("bakery_files_write").call({
    path: "/shared/a.md",
    mediaType: "text/markdown",
    content: "YQ==",
    version: 7,
  });
  assertEquals(fake.calls.at(-1), {
    tool: "storageFiles.put",
    args: { path: "/shared/a.md", mediaType: "text/markdown", content: "YQ==" },
    ifMatch: 7,
  });
});

Deno.test("a refused file call tells the agent the server's code", async () => {
  const fake = fakeSession(ALL_FILE_OPERATIONS, (call) => {
    throw new SessionRefusal(
      call.tool,
      new ApiProblemError({
        type: "precondition-required",
        title: "Precondition required",
        status: 428,
        code: "PRECONDITION_REQUIRED",
        retryable: false,
      }),
    );
  });
  const write = (await bakeryFilesTools(fake.session)).find((tool) =>
    tool.name === "bakery_files_write"
  )!;
  const result = await write.call({
    path: "/shared/a.md",
    mediaType: "text/plain",
    content: "YQ==",
  });
  assertEquals(result.isError, true);
  assert(text(result).includes("PRECONDITION_REQUIRED"), text(result));
});

async function rpc(
  gateway: ToolGatewaySession,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(gateway.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gateway.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()).result;
}

Deno.test("a connection tool with a Bakery Files name never shadows the built-in tool", async () => {
  const fake = fakeSession(ALL_FILE_OPERATIONS, () => ({ id: "f-1" }));
  const builtins = await bakeryFilesTools(fake.session);
  const clashing: GatewayTool = {
    name: "bakery_files_write",
    toolName: "write",
    connectionId: crypto.randomUUID(),
    description: "A connection's own write.",
    inputSchema: { type: "object" },
    readOnly: false,
  };
  let connectionCalls = 0;
  const gateway = await startToolGateway({
    listTools: () => Promise.resolve([clashing]),
    listBuiltinTools: () => Promise.resolve(builtins),
    invokeTool: () => {
      connectionCalls += 1;
      return Promise.resolve({ content: [], isError: false });
    },
  });
  try {
    const listed = await rpc(gateway, "tools/list") as {
      tools: { name: string; description: string }[];
    };
    const writes = listed.tools.filter((tool) =>
      tool.name === "bakery_files_write"
    );
    assertEquals(writes.length, 1);
    assert(writes[0].description !== clashing.description);
    await rpc(gateway, "tools/call", {
      name: "bakery_files_write",
      arguments: { path: "/shared/a.md", mediaType: "text/plain", content: "" },
    });
    assertEquals(connectionCalls, 0);
    assertEquals(fake.calls.at(-1)?.tool, "storageFiles.put");
  } finally {
    await gateway.close();
  }
});

Deno.test("the gateway factory lists Bakery Files tools with the assignment's session credential", async () => {
  const seen: { url: string; credential: string | null }[] = [];
  const factory = createToolGatewayFactory(
    {
      effectiveTools: () => Promise.resolve({ value: { tools: [] } }),
      invokeTool: () => Promise.reject(new Error("unused")),
      openLocalToolCall: () => Promise.reject(new Error("unused")),
      settleLocalToolCall: () => Promise.reject(new Error("unused")),
    },
    () =>
      Promise.resolve({ workerSessionId: "ws", workerSessionGeneration: "1" }),
    {
      stdioAllowlist: [],
      sessionServerUrl: "http://bakery.test",
      sessionFetcher: (input, init) => {
        const request = new Request(input, init);
        seen.push({
          url: request.url,
          credential: request.headers.get("x-session-credential"),
        });
        return Promise.resolve(Response.json({
          tools: ALL_FILE_OPERATIONS.map((name) => ({ name })),
        }));
      },
    },
  );
  const assignment = { attemptId: "a-1", leaseToken: "l", fence: "1" };
  const withCredential = await factory({
    ...assignment,
    sessionCredential: "session-token",
  });
  const without = await factory(assignment);
  try {
    assertEquals(withCredential.builtinTools.length, 7);
    assert(gatewayOffersTools(withCredential));
    assertEquals(seen, [{
      url: "http://bakery.test/v1/session/tools",
      credential: "session-token",
    }]);
    assertEquals(without.builtinTools, []);
    assertEquals(gatewayOffersTools(without), false);
  } finally {
    await withCredential.close();
    await without.close();
  }
});

Deno.test("a connection tool never takes a Bakery Files name, even when the built-in is not offered", async () => {
  const clashing: GatewayTool = {
    name: "bakery_files_write",
    toolName: "write",
    connectionId: crypto.randomUUID(),
    description: "A connection's own write.",
    inputSchema: { type: "object" },
    readOnly: false,
  };
  let connectionCalls = 0;
  const gateway = await startToolGateway({
    listTools: () => Promise.resolve([clashing]),
    listBuiltinTools: () => Promise.resolve([]),
    invokeTool: () => {
      connectionCalls += 1;
      return Promise.resolve({ content: [], isError: false });
    },
  });
  try {
    const listed = await rpc(gateway, "tools/list") as {
      tools: { name: string }[];
    };
    assertEquals(listed.tools, []);
    await rpc(gateway, "tools/call", {
      name: "bakery_files_write",
      arguments: {},
    });
    assertEquals(connectionCalls, 0);
  } finally {
    await gateway.close();
  }
});

Deno.test("write takes its version as an integer or digits, and refuses anything else by name", async () => {
  const fake = fakeSession(ALL_FILE_OPERATIONS, () => ({ id: "f-1" }));
  const write = (await bakeryFilesTools(fake.session)).find((tool) =>
    tool.name === "bakery_files_write"
  )!;
  const put = { path: "/shared/a.md", mediaType: "text/plain", content: "" };
  await write.call({ ...put, version: "4" });
  assertEquals(fake.calls.at(-1)?.ifMatch, 4);
  const refused = await write.call({ ...put, version: "four" });
  assertEquals(refused.isError, true);
  assert(text(refused).includes("version"), text(refused));
  assertEquals(fake.calls.length, 1);
});

Deno.test("a request over the gateway's body limit is answered 413, not reset", async () => {
  const gateway = await startToolGateway({
    listTools: () => Promise.resolve([]),
    invokeTool: () => Promise.reject(new Error("unused")),
  });
  try {
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
      },
      body: "x".repeat(1024 * 1024 + 1),
    });
    assertEquals(response.status, 413);
    assertEquals((await response.json()).error.code, -32600);
  } finally {
    await gateway.close();
  }
});
