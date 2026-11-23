import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpStdioLaunchSpecSchema } from "@bakery/contracts/mcp-capabilities";
import {
  launchStdioMcpServer,
  StdioMcpError,
  type StdioMcpServer,
} from "./stdio-mcp.ts";

/**
 * The worker-local tool gateway (#436, docs/technical-design/25-one-engine.md
 * 15.4): one MCP endpoint per agent session, on loopback, listing exactly the
 * session's effective tools. Every call goes to the server's lease-protected
 * `worker.invokeTool` route; the server's broker sends it, so no credential
 * for the remote server ever enters the session. The session reaches the
 * gateway with a random bearer that lives only as long as the session, and the
 * worker's own credential never leaves this process.
 *
 * Tools only (O31): no resources, prompts, sampling, elicitation or roots.
 */

export const TOOL_GATEWAY_SERVER_NAME = "bakery";
const PROTOCOL_VERSION = "2026-07-28";
const MAX_BODY_BYTES = 1024 * 1024;

export const GatewayToolSchema = z.object({
  name: z.string().min(1).max(200).describe(
    "Name the gateway shows the session; unique within it.",
  ),
  toolName: z.string().min(1).max(200).describe(
    "The tool's own name on its server.",
  ),
  connectionId: z.uuid().describe("MCP connection the tool is called on."),
  description: z.string().max(10_000).describe("The tool's description."),
  inputSchema: z.unknown().describe("The tool's pinned input schema."),
  readOnly: z.boolean().describe("Whether an Admin classified it as a read."),
  launchSpec: McpStdioLaunchSpecSchema.nullable().optional().describe(
    "For a local (stdio) server this worker runs, its pinned launch; null or absent for a remote one.",
  ),
}).describe("One effective tool of an agent session.");
export type GatewayTool = z.infer<typeof GatewayToolSchema>;

/** What the gateway needs from the worker's server client. */
export type ToolGatewayBackend = Readonly<{
  listTools(signal?: AbortSignal): Promise<readonly GatewayTool[]>;
  invokeTool(
    input: Readonly<{
      tool: GatewayTool;
      arguments: Record<string, unknown>;
      idempotencyKey: string;
    }>,
    signal?: AbortSignal,
  ): Promise<{ content: unknown[]; isError: boolean }>;
}>;

export type ToolGatewaySession = Readonly<{
  /** The loopback URL the session's MCP client connects to. */
  url: string;
  /** The bearer the session presents; random per session. */
  token: string;
  tools: readonly GatewayTool[];
  /** An MCP client configuration naming only this gateway. */
  mcpConfig(): Record<string, unknown>;
  close(): Promise<void>;
}>;

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    request.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("TOOL_GATEWAY_BODY_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new TextDecoder().decode(concat(chunks))));
    request.on("error", reject);
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function sameSecret(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers one JSON-RPC message; null for a notification, which has no answer. */
export async function answerGatewayMessage(
  message: JsonRpcRequest,
  tools: readonly GatewayTool[],
  backend: ToolGatewayBackend,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const id = message.id;
  if (id === undefined || id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: TOOL_GATEWAY_SERVER_NAME, version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object" },
          annotations: { readOnlyHint: tool.readOnly },
        })),
      });
    case "tools/call": {
      const params = (message.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      const tool = tools.find((candidate) => candidate.name === params.name);
      // Only listed tools; the server refuses anything else again anyway.
      if (tool === undefined) return error(-32602, "Unknown tool.");
      const args = params.arguments ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return error(-32602, "Tool arguments must be an object.");
      }
      try {
        const result = await backend.invokeTool({
          tool,
          arguments: args as Record<string, unknown>,
          // One key per call: the server records it and never sends the same
          // call twice under it.
          idempotencyKey: randomUUID(),
        }, signal);
        return reply(result);
      } catch {
        // A refusal or a fault reaches the agent as a failed call, never as
        // the server's detail.
        return reply({
          content: [{
            type: "text",
            text: "The tool call was refused or failed.",
          }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, "Method not found.");
  }
}

/** Starts one session's gateway on loopback and lists its tools once. */
export async function startToolGateway(
  backend: ToolGatewayBackend,
  signal?: AbortSignal,
): Promise<ToolGatewaySession> {
  const tools = await backend.listTools(signal);
  const token = randomBytes(32).toString("base64url");
  const server: Server = createServer((request, response) => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(
        status,
        body === undefined ? {} : { "content-type": "application/json" },
      );
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const authorization = request.headers.authorization ?? "";
    if (
      request.method !== "POST" ||
      !sameSecret(authorization, `Bearer ${token}`)
    ) {
      send(request.method === "POST" ? 401 : 405);
      return;
    }
    readBody(request).then(async (text) => {
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(text) as JsonRpcRequest;
      } catch {
        send(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error." },
        });
        return;
      }
      const answer = await answerGatewayMessage(
        message,
        tools,
        backend,
        signal,
      );
      if (answer === null) send(202);
      else send(200, answer);
    }).catch(() => send(400));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("TOOL_GATEWAY_LISTEN_FAILED");
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  signal?.addEventListener("abort", () => void close(), { once: true });
  return Object.freeze({
    url,
    token,
    tools,
    mcpConfig: () => ({
      mcpServers: {
        [TOOL_GATEWAY_SERVER_NAME]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
    close,
  });
}

/** The worker session holding the attempt, read when a gateway opens. */
export type ToolGatewayAuthority = () => Promise<
  { workerSessionId: string; workerSessionGeneration: string } | null
>;

/** Opens the gateway of one assignment's agent session. */
export type ToolGatewayFactory = (
  assignment: Readonly<
    { attemptId: string; leaseToken: string; fence: string }
  >,
  signal?: AbortSignal,
) => Promise<ToolGatewaySession>;

type GatewayClient = Readonly<{
  effectiveTools(
    attemptId: string,
    proof: {
      leaseToken: string;
      fence: string;
      workerSessionId: string;
      workerSessionGeneration: string;
    },
    signal?: AbortSignal,
  ): Promise<{ value: { tools: readonly GatewayTool[] } }>;
  invokeTool(
    attemptId: string,
    input: {
      mcpConnectionId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      idempotencyKey: string;
    },
    proof: {
      leaseToken: string;
      fence: string;
      workerSessionId: string;
      workerSessionGeneration: string;
    },
    signal?: AbortSignal,
  ): Promise<{ value: { content: unknown[]; isError: boolean } }>;
  openLocalToolCall(
    attemptId: string,
    input: {
      mcpConnectionId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      idempotencyKey: string;
    },
    proof: {
      leaseToken: string;
      fence: string;
      workerSessionId: string;
      workerSessionGeneration: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    value: {
      callId: string;
      status: "open" | "completed" | "failed";
      result: { content: unknown[]; isError: boolean } | null;
    };
  }>;
  settleLocalToolCall(
    attemptId: string,
    callId: string,
    outcome:
      | { status: "completed"; content: unknown[]; isError: boolean }
      | { status: "failed"; failureCode: string },
    proof: {
      leaseToken: string;
      fence: string;
      workerSessionId: string;
      workerSessionGeneration: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}>;

export type LocalToolOptions = Readonly<{
  stdioAllowlist: readonly string[];
  launch?: typeof launchStdioMcpServer;
}>;

function requestReachedServer(error: unknown): boolean {
  return !(error instanceof StdioMcpError && !error.requestWritten);
}

/**
 * Binds the gateway to the worker's server client: the session's tools come
 * from the effective-tools route and each call goes to worker.invokeTool, both
 * under the assignment's lease and the worker session that holds it.
 */
export function createToolGatewayFactory(
  client: GatewayClient,
  authority: ToolGatewayAuthority,
  local: LocalToolOptions = { stdioAllowlist: [] },
): ToolGatewayFactory {
  const launch = local.launch ?? launchStdioMcpServer;
  return async (assignment, signal) => {
    const session = await authority();
    if (session === null) throw new Error("TOOL_GATEWAY_SESSION_MISSING");
    const proof = {
      leaseToken: assignment.leaseToken,
      fence: String(assignment.fence),
      workerSessionId: session.workerSessionId,
      workerSessionGeneration: session.workerSessionGeneration,
    };
    const servers = new Map<string, Promise<StdioMcpServer>>();
    const forget = (connectionId: string, started: Promise<StdioMcpServer>) => {
      if (servers.get(connectionId) === started) servers.delete(connectionId);
    };
    const localServer = (tool: GatewayTool) => {
      let started = servers.get(tool.connectionId);
      if (started === undefined) {
        const launching = launch(tool.launchSpec!, {
          allowlist: local.stdioAllowlist,
          signal,
        });
        started = launching;
        servers.set(tool.connectionId, launching);
        launching.then(
          (server) =>
            server.exited.then(() => {
              forget(tool.connectionId, launching);
              return server.close();
            }),
          () => forget(tool.connectionId, launching),
        );
      }
      return started;
    };
    const settleFailed = (
      callId: string,
      error: unknown,
      callSignal?: AbortSignal,
    ) =>
      client.settleLocalToolCall(
        assignment.attemptId,
        callId,
        {
          status: "failed",
          failureCode: error instanceof StdioMcpError
            ? error.code.toLowerCase()
            : "unknown",
        },
        proof,
        callSignal,
      );
    const callLocal = async (
      input: Parameters<ToolGatewayBackend["invokeTool"]>[0],
      callSignal?: AbortSignal,
    ) => {
      const opened = (await client.openLocalToolCall(
        assignment.attemptId,
        {
          mcpConnectionId: input.tool.connectionId,
          toolName: input.tool.toolName,
          arguments: input.arguments,
          idempotencyKey: input.idempotencyKey,
        },
        proof,
        callSignal,
      )).value;
      if (opened.status !== "open") {
        if (opened.result === null) {
          throw new Error("TOOL_GATEWAY_REPLAY_EMPTY");
        }
        return opened.result;
      }
      let server: StdioMcpServer;
      try {
        server = await localServer(input.tool);
      } catch (error) {
        await settleFailed(opened.callId, error, callSignal);
        throw error;
      }
      let result: { content: unknown[]; isError: boolean };
      try {
        result = await server.callTool(
          input.tool.toolName,
          input.arguments,
          callSignal,
        );
      } catch (error) {
        if (input.tool.readOnly || !requestReachedServer(error)) {
          await settleFailed(opened.callId, error, callSignal);
        }
        throw error;
      }
      await client.settleLocalToolCall(
        assignment.attemptId,
        opened.callId,
        {
          status: "completed",
          content: result.content,
          isError: result.isError,
        },
        proof,
        callSignal,
      );
      return result;
    };
    const gateway = await startToolGateway({
      listTools: async (listSignal) =>
        (await client.effectiveTools(assignment.attemptId, proof, listSignal))
          .value.tools,
      invokeTool: async (input, callSignal) => {
        if (input.tool.launchSpec) return await callLocal(input, callSignal);
        const answered = await client.invokeTool(
          assignment.attemptId,
          {
            mcpConnectionId: input.tool.connectionId,
            toolName: input.tool.toolName,
            arguments: input.arguments,
            idempotencyKey: input.idempotencyKey,
          },
          proof,
          callSignal,
        );
        return {
          content: answered.value.content,
          isError: answered.value.isError,
        };
      },
    }, signal);
    return Object.freeze({
      ...gateway,
      close: async () => {
        await gateway.close();
        const running = [...servers.values()];
        servers.clear();
        await Promise.all(
          running.map((started) =>
            started.then((server) => server.close(), () => undefined)
          ),
        );
      },
    });
  };
}
