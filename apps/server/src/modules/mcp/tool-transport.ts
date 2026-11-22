import type { SecretsKeyConfig } from "@bakery/config";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { loadBearerToken } from "./connection-discovery.ts";
import {
  DiscoveryError,
  failureFor,
  MCP_TARGET_PROTOCOL_VERSION,
  resolveEndpoint,
  rpcMessage,
} from "./discovery.ts";
import {
  MCP_DEADLINE_MS,
  type McpHttpResult,
  type McpTransport,
} from "./discovery-transport.ts";
import type { McpToolTransport } from "./invoke.ts";

/**
 * The call half of a remote MCP connection (#435, chapter 25 section 15.4): the
 * server-side broker sends one pinned tool's call to the remote server and brings
 * back its result. Discovery already speaks to the same server; this reuses its
 * guarded HTTPS exchange, its endpoint rules and its credential reading, and adds
 * `tools/call`.
 *
 * The credential is read for this one exchange and sent only in the Authorization
 * header of these requests; it never reaches a session. The client offers nothing
 * (no sampling, elicitation or roots, O31), the exchange has one deadline, and the
 * result is read up to a byte cap and then size-bounded again: a result never
 * carries authority and is never trusted to be small.
 */

export const MCP_CALL_MAX_RESULT_BYTES = 256 * 1024;

/** Why a call failed, as a fixed vocabulary a person can act on. */
export type McpToolCallFailure =
  | "connection_unavailable"
  | "transport_unsupported"
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
  | "tool_failed"
  | "result_too_large";

export class McpToolCallError extends Error {
  constructor(readonly reason: McpToolCallFailure) {
    super(reason);
    this.name = "McpToolCallError";
  }
}

type ConnectionRow = {
  status: string;
  secret_id: string | null;
  config: unknown;
  endpoint_template: string | null;
  server_enabled: boolean;
  transport: string;
};

export function createRemoteMcpToolTransport(deps: {
  database: PgDatabase;
  secretsKey: SecretsKeyConfig | undefined;
  transport: McpTransport;
  deadlineMs?: number;
}): McpToolTransport {
  return {
    async invoke(input) {
      // Everything the exchange needs is read first and the transaction ends
      // before the network: no connection is held open on a remote server.
      const prepared = await withPgTransaction(deps.database, async (tx) => {
        const row = (await tx.query<ConnectionRow>(
          `select c.status, c.secret_id, c.config,
                  s.endpoint_template, s.enabled as server_enabled, s.transport
             from bakery.mcp_connections c
             join bakery.mcp_servers s
               on s.organization_id = c.organization_id and s.id = c.server_id
            where c.organization_id = $1 and c.id = $2`,
          [input.organizationId, input.connectionId],
        )).rows[0];
        if (
          row === undefined || row.status !== "enabled" ||
          !row.server_enabled || row.endpoint_template === null
        ) throw new McpToolCallError("connection_unavailable");
        if (row.transport !== "streamable_http") {
          throw new McpToolCallError("transport_unsupported");
        }
        try {
          return {
            endpoint: resolveEndpoint(row.endpoint_template, row.config),
            token: await loadBearerToken(
              tx,
              input.organizationId,
              row.secret_id,
              deps.secretsKey,
            ),
          };
        } catch (error) {
          if (error instanceof DiscoveryError) {
            throw new McpToolCallError(error.reason as McpToolCallFailure);
          }
          throw error;
        }
      });

      const signal = AbortSignal.timeout(deps.deadlineMs ?? MCP_DEADLINE_MS);
      const base: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(prepared.token === null
          ? {}
          : { authorization: `Bearer ${prepared.token}` }),
      };
      let headers = base;
      const post = async (payload: Record<string, unknown>) => {
        const result = await deps.transport({
          endpoint: prepared.endpoint,
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
          signal,
        });
        const failure = failureFor(result);
        if (failure) throw new McpToolCallError(failure as McpToolCallFailure);
        return result as Extract<McpHttpResult, { kind: "response" }>;
      };
      const call = async (id: number, method: string, params: unknown) => {
        const response = await post({ id, method, params });
        let message: Record<string, unknown>;
        try {
          message = rpcMessage(response.contentType, response.body, id);
        } catch (error) {
          if (error instanceof DiscoveryError) {
            throw new McpToolCallError("invalid_response");
          }
          throw error;
        }
        if (message.error !== undefined) {
          throw new McpToolCallError("server_error");
        }
        const result = message.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new McpToolCallError("invalid_response");
        }
        return { result: result as Record<string, unknown>, response };
      };

      const init = await call(1, "initialize", {
        protocolVersion: MCP_TARGET_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "bakery", version: "1" },
      });
      const protocolVersion = init.result.protocolVersion;
      if (typeof protocolVersion !== "string" || protocolVersion === "") {
        throw new McpToolCallError("invalid_response");
      }
      headers = {
        ...base,
        "mcp-protocol-version": protocolVersion,
        ...(init.response.sessionId === null
          ? {}
          : { "mcp-session-id": init.response.sessionId }),
      };
      await post({ method: "notifications/initialized" });
      const called = await call(2, "tools/call", {
        name: input.toolName,
        arguments: input.arguments,
      });
      // The tool ran and said it failed: the step fails, whatever text it left.
      if (called.result.isError === true) {
        throw new McpToolCallError("tool_failed");
      }
      const answer = isRecord(called.result.structuredContent)
        ? called.result.structuredContent
        : { content: called.result.content ?? [] };
      if (
        new TextEncoder().encode(JSON.stringify(answer)).length >
          MCP_CALL_MAX_RESULT_BYTES
      ) throw new McpToolCallError("result_too_large");
      return answer;
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
