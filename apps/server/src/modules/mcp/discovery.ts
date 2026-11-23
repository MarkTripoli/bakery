import { canonicalJson } from "../../platform/canonical-json.ts";
import { mcpManifestDigest } from "./invoke.ts";
import {
  MCP_DEADLINE_MS,
  type McpHttpResult,
  type McpTransport,
} from "./discovery-transport.ts";
import { endpointTemplateProblem } from "./server-commands.ts";

/**
 * Discovery of a remote MCP server's tools (#434, chapter 25 section 15.4, O31).
 *
 * Tools only: the client advertises no capabilities, so the server may not ask it
 * for sampling, elicitation or roots, and resources and prompts are ignored. What
 * comes back is validated, size-bounded and frozen into a manifest with a digest;
 * it carries no authority. Discovery observes. It never enables a tool.
 */

/** The protocol version Bakery targets; the server's answer is recorded as observed. */
export const MCP_TARGET_PROTOCOL_VERSION = "2026-07-28";

const MAX_PAGES = 20;
const MAX_TOOLS = 500;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 4000;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,63})\}/g;
const FILL_VALUE = /^[A-Za-z0-9._-]{1,63}$/;
const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/** Why discovery failed, as a fixed vocabulary a person can act on. */
export type DiscoveryFailure =
  | "config_missing_placeholder"
  | "endpoint_invalid"
  | "refused_address"
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "auth_rejected"
  | "endpoint_not_found"
  | "redirect_refused"
  | "http_status"
  | "invalid_response"
  | "server_error"
  | "too_many_tools"
  | "tool_invalid"
  | "description_too_long"
  | "duplicate_tool"
  | "manifest_too_large";

export class DiscoveryError extends Error {
  constructor(readonly reason: DiscoveryFailure) {
    super(reason);
    this.name = "DiscoveryError";
  }
}

export type DiscoveredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type Discovery = {
  protocolVersion: string;
  manifest: { tools: DiscoveredTool[] };
  digest: string;
};

/**
 * The endpoint a connection reaches: the server's template with each `{name}` filled
 * from the connection's config. A value must be a plain label (letters, digits, dot,
 * dash, underscore), and the result must still be an acceptable https endpoint, so
 * config can choose a tenant and cannot smuggle in a path, a host or a credential.
 */
export function resolveEndpoint(template: string, config: unknown): string {
  const values = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const filled = template.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (typeof value !== "string" || !FILL_VALUE.test(value)) {
      throw new DiscoveryError("config_missing_placeholder");
    }
    return value;
  });
  if (endpointTemplateProblem(filled) !== null) {
    throw new DiscoveryError("endpoint_invalid");
  }
  return filled;
}

/** The JSON-RPC message with `id` from a JSON or event-stream response body. */
export function rpcMessage(
  contentType: string,
  body: string,
  id: number,
): Record<string, unknown> {
  const candidates: unknown[] = [];
  try {
    if (contentType.toLowerCase().includes("text/event-stream")) {
      for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data !== "") candidates.push(JSON.parse(data));
      }
    } else {
      const parsed = JSON.parse(body);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  } catch {
    throw new DiscoveryError("invalid_response");
  }
  const found = candidates.find((message) =>
    !!message && typeof message === "object" &&
    (message as { id?: unknown }).id === id
  ) as Record<string, unknown> | undefined;
  if (!found) throw new DiscoveryError("invalid_response");
  return found;
}

export function failureFor(result: McpHttpResult): DiscoveryFailure | null {
  switch (result.kind) {
    case "timeout":
      return "timeout";
    case "network_error":
      return "network_error";
    case "refused":
      return "refused_address";
    case "too_large":
      return "response_too_large";
    case "response": {
      const status = result.status;
      if (status >= 200 && status < 300) return null;
      if (status === 401 || status === 403) return "auth_rejected";
      if (status === 404) return "endpoint_not_found";
      if (status >= 300 && status < 400) return "redirect_refused";
      return "http_status";
    }
  }
}

function toolFrom(raw: unknown): DiscoveredTool {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DiscoveryError("tool_invalid");
  }
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
    throw new DiscoveryError("tool_invalid");
  }
  const description = tool.description ?? "";
  if (typeof description !== "string") throw new DiscoveryError("tool_invalid");
  if (description.length > MAX_DESCRIPTION) {
    throw new DiscoveryError("description_too_long");
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!isObject(tool.inputSchema)) throw new DiscoveryError("tool_invalid");
  const out: DiscoveredTool = {
    name: tool.name,
    description,
    inputSchema: tool.inputSchema,
  };
  if (tool.outputSchema !== undefined) {
    if (!isObject(tool.outputSchema)) throw new DiscoveryError("tool_invalid");
    out.outputSchema = tool.outputSchema;
  }
  if (isObject(tool.annotations)) {
    // Server hints are suggestions: kept as booleans and a short title, nothing else.
    const hints: Record<string, unknown> = {};
    for (const hint of HINTS) {
      if (typeof tool.annotations[hint] === "boolean") {
        hints[hint] = tool.annotations[hint];
      }
    }
    const title = tool.annotations.title;
    if (typeof title === "string" && title.length <= 200) hints.title = title;
    if (Object.keys(hints).length > 0) out.annotations = hints;
  }
  return out;
}

/** A validated, name-ordered manifest and its digest, from what the server listed. */
export async function buildManifest(
  rawTools: readonly unknown[],
  protocolVersion: string = MCP_TARGET_PROTOCOL_VERSION,
): Promise<{ manifest: { tools: DiscoveredTool[] }; digest: string }> {
  if (rawTools.length > MAX_TOOLS) throw new DiscoveryError("too_many_tools");
  const tools = rawTools.map(toolFrom);
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new DiscoveryError("duplicate_tool");
    names.add(tool.name);
  }
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const manifest = { tools };
  const text = canonicalJson(manifest);
  if (new TextEncoder().encode(text).length > MAX_MANIFEST_BYTES) {
    throw new DiscoveryError("manifest_too_large");
  }
  // The one digest a binding pins and an invoke compares (plain lowercase hex).
  return {
    manifest,
    digest: await mcpManifestDigest({ protocolVersion, tools }),
  };
}

/**
 * The exchange: initialize, the initialized notification, then tools/list through
 * every page. One deadline covers all of it. The credential, when there is one, goes
 * only in the Authorization header of these requests.
 */
export async function discoverTools(
  transport: McpTransport,
  input: {
    endpoint: string;
    bearerToken: string | null;
    deadlineMs?: number;
  },
): Promise<Discovery> {
  const signal = AbortSignal.timeout(input.deadlineMs ?? MCP_DEADLINE_MS);
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(input.bearerToken === null
      ? {}
      : { authorization: `Bearer ${input.bearerToken}` }),
  };
  let headers = base;
  const post = async (payload: Record<string, unknown>) => {
    const result = await transport({
      endpoint: input.endpoint,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
      signal,
    });
    const failure = failureFor(result);
    if (failure) throw new DiscoveryError(failure);
    return result as Extract<McpHttpResult, { kind: "response" }>;
  };
  const call = async (id: number, method: string, params: unknown) => {
    const response = await post({ id, method, params });
    const message = rpcMessage(response.contentType, response.body, id);
    if (message.error !== undefined) throw new DiscoveryError("server_error");
    const result = message.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new DiscoveryError("invalid_response");
    }
    return { result: result as Record<string, unknown>, response };
  };

  const init = await call(1, "initialize", {
    protocolVersion: MCP_TARGET_PROTOCOL_VERSION,
    // Nothing offered: no sampling, no elicitation, no roots (O31).
    capabilities: {},
    clientInfo: { name: "bakery", version: "1" },
  });
  const protocolVersion = init.result.protocolVersion;
  if (typeof protocolVersion !== "string" || protocolVersion === "") {
    throw new DiscoveryError("invalid_response");
  }
  headers = {
    ...base,
    "mcp-protocol-version": protocolVersion,
    ...(init.response.sessionId === null
      ? {}
      : { "mcp-session-id": init.response.sessionId }),
  };
  await post({ method: "notifications/initialized" });

  const rawTools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await call(
      page + 2,
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );
    const tools = listed.result.tools;
    if (!Array.isArray(tools)) throw new DiscoveryError("invalid_response");
    rawTools.push(...tools);
    if (rawTools.length > MAX_TOOLS) throw new DiscoveryError("too_many_tools");
    const next = listed.result.nextCursor;
    if (typeof next !== "string" || next === "") {
      const { manifest, digest } = await buildManifest(
        rawTools,
        protocolVersion,
      );
      return { protocolVersion, manifest, digest };
    }
    cursor = next;
  }
  throw new DiscoveryError("too_many_tools");
}
