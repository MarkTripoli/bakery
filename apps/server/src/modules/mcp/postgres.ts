import type { Database } from "../../platform/database.ts";
import type { McpPinnedState, McpPinnedStatePort } from "./invoke.ts";

/**
 * The Postgres read behind an MCP invocation (issue #20, criterion 1).
 *
 * One query answers every question the invoke path asks, so the checks cannot
 * see a half-updated world: the connection's status, the snapshot the binding
 * pinned, the snapshot the connection currently points at, whether a grant is
 * live, and which capabilities an operator enabled. Reading these in separate
 * statements would let a revocation land between two of them.
 *
 * Everything comes from rows. Nothing here trusts the caller for anything but
 * which connection it means; the actor ref only narrows the grant.
 */
export function createPostgresMcpPinnedStatePort(
  db: Database,
): McpPinnedStatePort {
  return {
    async load(input) {
      const rows = await db<{
        connection_status: string;
        enabled_capabilities: unknown;
        pinned_id: string | null;
        pinned_digest: string | null;
        pinned_manifest: unknown;
        current_id: string | null;
        current_digest: string | null;
        grant_live: boolean;
      }[]>`
          select
            connection.status as connection_status,
            connection.enabled_capabilities,
            pinned.id as pinned_id,
            pinned.digest as pinned_digest,
            pinned.manifest as pinned_manifest,
            latest.id as current_id,
            latest.digest as current_digest,
            exists (
              select 1
                from bakery.capability_bindings binding
               where binding.organization_id = connection.organization_id
                 and binding.mcp_connection_id = connection.id
            ) as grant_live
          from bakery.mcp_connections connection
          left join bakery.mcp_capability_snapshots pinned
            on pinned.organization_id = connection.organization_id
           and pinned.id = connection.current_snapshot_id
          left join bakery.mcp_capability_snapshots latest
            on latest.organization_id = connection.organization_id
           and latest.connection_id = connection.id
           and latest.observed_at = (
             select max(inner_snapshot.observed_at)
               from bakery.mcp_capability_snapshots inner_snapshot
              where inner_snapshot.connection_id = connection.id
           )
          where connection.organization_id = ${input.organizationId}
            and connection.id = ${input.connectionId}
        `;
      const row = rows[0];
      if (!row) return null;

      const toolNames = pinnedToolNames(row.pinned_manifest);
      return {
        connectionStatus: row
          .connection_status as McpPinnedState["connectionStatus"],
        enabledCapabilities: stringArray(row.enabled_capabilities),
        pinnedSnapshot: row.pinned_id && row.pinned_digest
          ? {
            id: row.pinned_id,
            digest: row.pinned_digest,
            toolNames,
          }
          : null,
        currentSnapshot: row.current_id && row.current_digest
          ? { id: row.current_id, digest: row.current_digest }
          : null,
        grantLive: row.grant_live === true,
      } satisfies McpPinnedState;
    },
  };
}

/** Tool names from a stored manifest, tolerating a malformed one by yielding none. */
function pinnedToolNames(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const tools = (manifest as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (tool && typeof tool === "object") {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/** A jsonb column holding string names, tolerating a malformed value by yielding none. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
