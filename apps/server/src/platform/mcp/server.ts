import { Hono } from "hono";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import {
  challengeResponse,
  guardMcpRequest,
  type McpGrant,
  type McpGuardOptions,
} from "./guard.ts";
import {
  decideMcpToolAccess,
  MCP_RESOURCE_PATH,
  MCP_TOOL_SCOPE,
  McpTool,
} from "./scopes.ts";
import type { McpToolRunner } from "./tools.ts";

/** A tool call is a few hundred bytes; anything larger is not one. */
const MAX_REQUEST_BYTES = 64 * 1024;

const TOOL_METADATA: Readonly<
  Record<McpTool, { title: string; description: string }>
> = Object.freeze({
  [McpTool.Whoami]: {
    title: "Who am I",
    description:
      "Returns the person this connection acts as: identity, language and time zone for the connected organization.",
  },
  [McpTool.OrganizationGet]: {
    title: "Get organization",
    description:
      "Returns the one organization this connection is bound to, as the person may see it.",
  },
});

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, error_description: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolAllowed(grant: McpGrant, tool: McpTool): boolean {
  return decideMcpToolAccess({
    tool,
    tokenScopes: grant.tokenScopes,
    consentScopes: grant.consentScopes,
  }).allowed;
}

function hasAllowedTool(grant: McpGrant): boolean {
  return Object.values(McpTool).some((tool) => toolAllowed(grant, tool));
}

/** One stateless MCP server holding only the tools this grant's scopes allow. */
function buildMcpServer(grant: McpGrant, tools: McpToolRunner): McpServer {
  const server = new McpServer({ name: "bakery", version: "1.0.0" });
  for (const tool of Object.values(McpTool)) {
    if (!toolAllowed(grant, tool)) continue;
    server.registerTool(
      tool,
      {
        ...TOOL_METADATA[tool],
        inputSchema: z.object({}).describe(
          "This tool takes no input; it acts for the connected person in the connected organization.",
        ),
      },
      async () => {
        try {
          const result = await tools.run(tool, grant);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          // Only the closed problem code leaves the server; details stay in logs.
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: error instanceof StandardError ? error.code : "INTERNAL",
            }],
          };
        }
      },
    );
  }
  return server;
}

/** Tool named by a `tools/call` request, or undefined for any other message. */
function calledTool(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { method, params } = message as Record<string, unknown>;
  if (method !== "tools/call") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { name } = params as Record<string, unknown>;
  return typeof name === "string" ? name : undefined;
}

function isMcpTool(name: string): name is McpTool {
  return (Object.values(McpTool) as string[]).includes(name);
}

/**
 * Stateless Streamable HTTP endpoint for the MCP 2026-07-28 profile. Only
 * `POST` is served. Origin, credential and scope failures are answered with
 * HTTP 401/403 and a challenge before the SDK sees the request, never as
 * JSON-RPC results.
 */
export function createMcpRoutes(options: {
  guard: McpGuardOptions;
  tools: McpToolRunner;
  /** Origins allowed to send an `Origin` header; a request with no `Origin` is a native client. */
  allowedOrigins: readonly string[];
}) {
  const app = new Hono();
  const { publicOrigin } = options.guard;
  const origins = new Set(options.allowedOrigins);
  app.all(MCP_RESOURCE_PATH, async (context) => {
    const request = context.req.raw;
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "method_not_allowed",
          error_description: "The MCP endpoint accepts POST only.",
        }),
        {
          status: 405,
          headers: { allow: "POST", "content-type": "application/json" },
        },
      );
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !origins.has(origin)) {
      return jsonError(
        403,
        "forbidden",
        "This origin may not call the MCP endpoint.",
      );
    }
    const granted = await guardMcpRequest(request, options.guard);
    if (granted instanceof Response) return granted;

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BYTES) {
      return jsonError(413, "payload_too_large", "The request is too large.");
    }
    const text = await request.clone().text();
    if (text.length > MAX_REQUEST_BYTES) {
      return jsonError(413, "payload_too_large", "The request is too large.");
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      message = undefined;
    }
    const name = calledTool(message);
    const headerName = request.headers.get("mcp-name");
    if (name !== undefined && headerName !== null && headerName !== name) {
      return jsonError(
        400,
        "invalid_request",
        "The tool name header does not match the request.",
      );
    }
    if (name !== undefined && isMcpTool(name)) {
      const decision = decideMcpToolAccess({
        tool: name,
        tokenScopes: granted.tokenScopes,
        consentScopes: granted.consentScopes,
      });
      if (!decision.allowed) {
        return challengeResponse(publicOrigin, {
          status: 403,
          error: "insufficient_scope",
          scope: MCP_TOOL_SCOPE[name],
        });
      }
    }
    // The SDK registers no `tools/list` handler for a server without tools, so
    // a grant whose scopes allow none gets the empty list from here.
    if (
      granted.scopes.length > 0 && isRecord(message) &&
      message.method === "tools/list" && !hasAllowedTool(granted)
    ) {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [],
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
        },
      });
    }
    const handler = createMcpHandler(
      () => buildMcpServer(granted, options.tools),
      { legacy: "reject", responseMode: "json", maxSubscriptions: 0 },
    );
    try {
      return await handler.fetch(request);
    } finally {
      await handler.close();
    }
  });
  return app;
}
