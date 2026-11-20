import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  EGRESS_REFUSED,
  endpointHostIsRefused,
  guardedLookup,
} from "../execution/provider-egress.ts";

/**
 * One HTTPS POST to a remote MCP server, as safe as the provider probe's GET.
 *
 * `node:https` and not `fetch`, so the address a name resolves to is checked and
 * dialled in the same step through `lookup` (no rebinding between the check and the
 * connection). It follows no redirect, a hard deadline covers the whole exchange,
 * and the response is read only up to a byte cap, so a hostile server cannot make
 * the broker buffer more than that.
 */

export const MCP_DEADLINE_MS = 10_000;
export const MCP_MAX_RESPONSE_BYTES = 1024 * 1024;

export type McpHttpResult =
  | {
    kind: "response";
    status: number;
    contentType: string;
    sessionId: string | null;
    body: string;
  }
  | { kind: "timeout" }
  | { kind: "network_error" }
  | { kind: "refused" }
  | { kind: "too_large" };

export type McpHttpRequest = {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  /** Instant after which the whole exchange is abandoned. */
  signal: AbortSignal;
};

export type McpTransport = (request: McpHttpRequest) => Promise<McpHttpResult>;

export function httpsMcpTransport(
  options: {
    lookup?: LookupFunction;
    maxBytes?: number;
    /** Replaceable so a test can watch what is sent without a network. */
    request?: typeof httpsRequest;
  } = {},
): McpTransport {
  const lookup = options.lookup ?? guardedLookup();
  const maxBytes = options.maxBytes ?? MCP_MAX_RESPONSE_BYTES;
  const request = options.request ?? httpsRequest;
  return ({ endpoint, headers, body, signal }) =>
    new Promise((resolve) => {
      if (endpointHostIsRefused(endpoint)) {
        resolve({ kind: "refused" });
        return;
      }
      const url = new URL(endpoint);
      let settled = false;
      const settle = (result: McpHttpResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = request({
        method: "POST",
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? 443 : Number(url.port),
        path: url.pathname + url.search,
        headers: {
          ...headers,
          "content-length": String(new TextEncoder().encode(body).length),
          "user-agent": "bakery-mcp-broker",
        },
        agent: false,
        lookup,
        signal,
      }, (response) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        response.on("data", (chunk: Uint8Array) => {
          size += chunk.length;
          if (size > maxBytes) {
            settle({ kind: "too_large" });
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          const type = response.headers["content-type"];
          const session = response.headers["mcp-session-id"];
          settle({
            kind: "response",
            status: response.statusCode ?? 0,
            contentType: typeof type === "string" ? type : "",
            sessionId: typeof session === "string" ? session : null,
            body: new TextDecoder().decode(joined),
          });
        });
        response.on("error", () => settle({ kind: "network_error" }));
      });
      req.on("error", (error: Error & { code?: string; name: string }) => {
        if (error.code === EGRESS_REFUSED) settle({ kind: "refused" });
        else if (
          error.name === "AbortError" || error.code === "ETIMEDOUT" ||
          signal.aborted
        ) settle({ kind: "timeout" });
        else settle({ kind: "network_error" });
      });
      req.end(body);
    });
}
