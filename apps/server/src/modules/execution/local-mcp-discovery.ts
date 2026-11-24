import type { Context } from "hono";
import { z } from "zod";
import { McpStdioLaunchSpecSchema } from "@bakery/contracts/mcp-capabilities";
import { StandardError } from "@bakery/contracts/http";
import { buildManifest, DiscoveryError } from "../mcp/discovery.ts";
import { pinDiscoveredSnapshot } from "../mcp/connection-discovery.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  type ExecutionRouteOptions,
  requestMetadata,
  workerTransaction,
} from "./shared.ts";

export const LOCAL_MCP_CONNECTIONS_PATH = "/v1/worker/local-mcp-connections";
export const LOCAL_MCP_SNAPSHOTS_PATH =
  "/v1/worker/local-mcp-connections/:id/snapshots";

const PAGE_LIMIT = 50;

export const LocalMcpConnectionsQuerySchema = z.strictObject({
  after: z.uuid().optional().describe(
    "Keyset cursor: the last connection id of the previous page.",
  ),
  limit: z.number().int().min(1).max(PAGE_LIMIT).optional().describe(
    "Most connections to return; at most 50, default 50.",
  ),
}).describe(
  "A worker pages through the enabled local MCP connections placed on its own host.",
);

export const LocalMcpSnapshotReportSchema = z.strictObject({
  protocolVersion: z.string().min(1).max(64).describe(
    "Protocol version the local server answered initialize with.",
  ),
  tools: z.array(z.unknown().describe("One tool as tools/list listed it."))
    .max(1000).describe(
      "Every tool the local server listed, across all pages, unvalidated.",
    ),
}).describe(
  "What a local MCP server's tools/list answered on the worker host it is placed on.",
);

type PlacedRow = {
  id: string;
  launch_spec: unknown;
  current_digest: string | null;
};

export async function localMcpConnectionsRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const query = await parseContract(context, LocalMcpConnectionsQuerySchema);
  const limit = query.limit ?? PAGE_LIMIT;
  const rows = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) =>
      (await transaction.query<PlacedRow>(
        `select connection.id, server.launch_spec,
                current.digest as current_digest
           from bakery.mcp_connections connection
           join bakery.mcp_servers server
             on server.organization_id = connection.organization_id
            and server.id = connection.server_id
           left join bakery.mcp_capability_snapshots current
             on current.organization_id = connection.organization_id
            and current.id = connection.current_snapshot_id
          where connection.organization_id = $1
            and connection.worker_host_id = $2
            and connection.status = 'enabled'
            and server.enabled and server.transport = 'stdio'
            and ($3::uuid is null or connection.id > $3::uuid)
          order by connection.id
          limit $4`,
        [
          identity.host.organization_id,
          identity.host.id,
          query.after ?? null,
          limit + 1,
        ],
      )).rows,
  );
  const page = rows.slice(0, limit);
  return jsonResponse({
    items: page.flatMap((row) => {
      const launch = McpStdioLaunchSpecSchema.safeParse(row.launch_spec);
      return launch.success
        ? [{
          connectionId: row.id,
          launchSpec: launch.data,
          currentDigest: row.current_digest,
        }]
        : [];
    }),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  }, 200);
}

export async function localMcpSnapshotRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const connectionId = z.uuid().safeParse(context.req.param("id"));
  if (!connectionId.success) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const report = await parseContract(context, LocalMcpSnapshotReportSchema);
  let found;
  try {
    found = await buildManifest(report.tools, report.protocolVersion);
  } catch (error) {
    if (error instanceof DiscoveryError) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: error.reason },
      });
    }
    throw error;
  }
  const { requestId, traceId } = requestMetadata(context);
  const pinned = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const placed = (await transaction.query<{ id: string }>(
        `select connection.id
           from bakery.mcp_connections connection
           join bakery.mcp_servers server
             on server.organization_id = connection.organization_id
            and server.id = connection.server_id
          where connection.organization_id = $1 and connection.id = $2
            and connection.worker_host_id = $3
            and connection.status = 'enabled'
            and server.enabled and server.transport = 'stdio'`,
        [identity.host.organization_id, connectionId.data, identity.host.id],
      )).rows[0];
      if (placed === undefined) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      return await pinDiscoveredSnapshot(transaction, {
        organizationId: identity.host.organization_id,
        principalId: identity.host.principal_id,
        connectionId: connectionId.data,
        found: { ...found, protocolVersion: report.protocolVersion },
        requestId,
        traceId,
        reportedBy: "worker",
      });
    },
  );
  return jsonResponse({
    connectionId: connectionId.data,
    snapshotId: pinned.id,
    digest: pinned.digest,
  }, 200);
}
