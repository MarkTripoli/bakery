import type { Database } from "../../platform/database.ts";
import {
  mcpHostEligible,
  type McpTransport,
} from "@bakery/contracts/mcp-capabilities";
import type { McpPinnedState, McpPinnedStatePort } from "./invoke.ts";

/**
 * The Postgres read behind an MCP invocation (issue #20, criterion 1).
 *
 * One query answers every question the invoke path asks, so the checks cannot
 * see a half-updated world: the connection's status and transport, the host it
 * is bound to, the snapshot the binding pinned, the snapshot the connection
 * currently points at, whether a grant for this actor is live, and which
 * capabilities an operator enabled. Reading these in separate statements would
 * let a revocation land between two of them.
 *
 * Two things this deliberately does not do:
 *
 * - It does not treat "a binding row exists" as a live grant. A binding is a
 *   grant to a named actor with a named operation list; both are part of the
 *   check, and an earlier version omitted them.
 * - It does not read the pin from `connection.current_snapshot_id`. That
 *   pointer moves when discovery runs again, so reading it would make a
 *   re-discovery a silent re-pin. The pin comes from the binding.
 */
export function createPostgresMcpPinnedStatePort(
  db: Database,
): McpPinnedStatePort {
  return {
    async load(input) {
      const rows = await db<{
        connection_status: string;
        transport: string;
        worker_host_id: string | null;
        enabled_capabilities: unknown;
        pinned_id: string | null;
        pinned_digest: string | null;
        pinned_manifest: unknown;
        current_id: string | null;
        current_digest: string | null;
        grant_live: boolean;
        allowed_operations: unknown;
        dispatching_host_eligible: boolean;
        owner_principal_id: string | null;
        use_grant_live: boolean;
      }[]>`
          select
            connection.status as connection_status,
            server.transport as transport,
            connection.worker_host_id,
            connection.owner_principal_id,
            -- The owner's grant to the workflow this call is made for, live now. A
            -- revoked grant, or one to another workflow, is not this one.
            exists (
              select 1
                from bakery.mcp_use_grants use_grant
                join bakery.workflow_versions granted_version
                  on granted_version.organization_id = use_grant.organization_id
                 and granted_version.workflow_id = use_grant.workflow_id
               where use_grant.organization_id = connection.organization_id
                 and use_grant.connection_id = connection.id
                 and use_grant.revoked_at is null
                 and granted_version.id = ${input.workflowVersionId ?? null}
            ) as use_grant_live,
            connection.enabled_capabilities,
            pinned.id as pinned_id,
            binding.mcp_snapshot_digest as pinned_digest,
            pinned.manifest as pinned_manifest,
            latest.id as current_id,
            latest.digest as current_digest,
            -- A live grant is a binding that names this actor, or names nobody
            -- (an organization-wide grant). A binding made for someone else is
            -- not this caller's grant, and existing is not the same as granted.
            exists (
              select 1
                from bakery.capability_bindings binding_any
               where binding_any.organization_id = connection.organization_id
                 and binding_any.mcp_connection_id = connection.id
                 -- A binding an Admin withdrew grants nothing (#436).
                 and not exists (
                   select 1 from bakery.capability_binding_revocations revoked
                    where revoked.organization_id = binding_any.organization_id
                      and revoked.binding_id = binding_any.id
                 )
                 and (binding_any.actor_ref is null
                      or binding_any.actor_ref = ${input.actorRef})
            ) as grant_live,
            binding.allowed_operations,
            -- The dispatching host's eligibility is read from the worker's own
            -- row, not taken from the caller: a caller that asserts it is
            -- eligible would otherwise be believed.
            case
              -- The server's own broker has no worker row; it is eligible, and
              -- the transport decides what that is worth (stdio is not).
              when ${input.hostId}::uuid is null then true
              else coalesce((
                select host.status = 'online' and host.desired_mode = 'accepting'
                  from bakery.worker_hosts host
                 where host.organization_id = connection.organization_id
                   and host.id = ${input.hostId}::uuid
              ), false)
            end as dispatching_host_eligible
          from bakery.mcp_connections connection
          join bakery.mcp_servers server
            on server.organization_id = connection.organization_id
           and server.id = connection.server_id
          -- The binding this invocation is checked against: the caller's own
          -- grant if one names it, else an organization-wide grant, else any
          -- (which the actor check below then refuses).
          left join lateral (
            select b.id, b.mcp_snapshot_id, b.mcp_snapshot_digest,
                   b.allowed_operations
              from bakery.capability_bindings b
             where b.organization_id = connection.organization_id
               and b.mcp_connection_id = connection.id
               and not exists (
                 select 1 from bakery.capability_binding_revocations revoked
                  where revoked.organization_id = b.organization_id
                    and revoked.binding_id = b.id
               )
               -- The caller's own grant outranks an organization-wide one, and
               -- another actor's binding is not a candidate at all: selecting it
               -- would let a stranger's operation list stand in for this one.
               and (b.actor_ref = ${input.actorRef} or b.actor_ref is null)
               -- A binding owned by a workflow, agent, skill or automation is
               -- for that owner, not for anyone with a connection id. A caller
               -- matching none of the supplied ownership slots may use only an
               -- unowned binding, so a step-scoped grant cannot stand in for an
               -- organization-wide one.
               and (
                 (b.workflow_version_id is null
                   or b.workflow_version_id = ${
        input.workflowVersionId ?? null
      })
                 and (b.agent_version_id is null
                   or b.agent_version_id = ${input.agentVersionId ?? null})
                 and (b.step_key is null or b.step_key = ${
        input.stepKey ?? null
      })
                 and (b.seat_key is null or b.seat_key = ${
        input.seatKey ?? null
      })
                 and (b.repository_id is null
                   or b.repository_id = ${input.repositoryId ?? null})
                 and (b.skill_version_owner_id is null
                   or b.skill_version_owner_id = ${
        input.skillVersionOwnerId ?? null
      })
                 and (b.automation_version_id is null
                   or b.automation_version_id = ${
        input.automationVersionId ?? null
      })
               )
             -- A binding that names more of this caller's ownership slots is
             -- more specific and wins, so a step-scoped grant is preferred over
             -- an organization-wide one that also matches. Recency only breaks
             -- ties between equally specific grants.
             order by (
                        (b.workflow_version_id is not null)::int
                        + (b.agent_version_id is not null)::int
                        + (b.step_key is not null)::int
                        + (b.seat_key is not null)::int
                        + (b.repository_id is not null)::int
                        + (b.skill_version_owner_id is not null)::int
                        + (b.automation_version_id is not null)::int
                      ) desc,
                      (b.actor_ref = ${input.actorRef}) desc nulls last,
                      b.created_at desc
             limit 1
          ) binding on true
          left join bakery.mcp_capability_snapshots pinned
            on pinned.organization_id = connection.organization_id
           and pinned.id = binding.mcp_snapshot_id
           -- The snapshot must belong to this same connection. Matching only on
           -- organization would let a binding name another connection's
           -- snapshot, which has a different remote behind it.
           and pinned.connection_id = connection.id
          left join lateral (
            select s.id, s.digest
              from bakery.mcp_capability_snapshots s
             where s.organization_id = connection.organization_id
               and s.connection_id = connection.id
             order by s.observed_at desc, s.id desc
             limit 1
          ) latest on true
          where connection.organization_id = ${input.organizationId}
            and connection.id = ${input.connectionId}
        `;
      const row = rows[0];
      if (!row) return null;

      return {
        connectionStatus: row
          .connection_status as McpPinnedState["connectionStatus"],
        transport: row.transport as McpTransport,
        workerHostId: row.worker_host_id,
        enabledCapabilities: stringArray(row.enabled_capabilities),
        allowedOperations: stringArray(row.allowed_operations),
        // The grant is live only when a binding exists AND it names this actor
        // or names nobody. A binding for someone else is not this caller's.
        grantLive: row.grant_live === true &&
          (row.allowed_operations !== null),
        dispatchingHostEligible: row.dispatching_host_eligible === true,
        personal: row.owner_principal_id === null ? null : {
          ownerPrincipalId: row.owner_principal_id,
          useGrantLive: row.use_grant_live === true,
        },
        pinnedSnapshot: row.pinned_id && row.pinned_digest
          ? {
            id: row.pinned_id,
            digest: row.pinned_digest,
            toolNames: pinnedToolNames(row.pinned_manifest),
            inputSchemas: pinnedInputSchemas(row.pinned_manifest),
          }
          : null,
        currentSnapshot: row.current_id && row.current_digest
          ? { id: row.current_id, digest: row.current_digest }
          : null,
      } satisfies McpPinnedState;
    },
  };
}

/** Each tool's declared input schema from a stored manifest, by tool name; a malformed manifest yields none. */
function pinnedInputSchemas(manifest: unknown): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  if (!manifest || typeof manifest !== "object") return schemas;
  const tools = (manifest as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return schemas;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const { name, inputSchema } = tool as {
      name?: unknown;
      inputSchema?: unknown;
    };
    if (typeof name === "string" && inputSchema !== undefined) {
      schemas[name] = inputSchema;
    }
  }
  return schemas;
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

export { mcpHostEligible };
