import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { CapabilityBindingImplementedAction } from "@bakery/contracts/implemented-actions";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { canonicalJson } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * Capability bindings an Admin manages directly (#436, docs/technical-design/
 * 25-one-engine.md 15.4 and 15.5): the MCP tools an agent version may call from
 * any session it runs in. A grant is exact tool names against the connection's
 * pinned snapshot, never a wildcard, and pins that snapshot so drift refuses the
 * tool until someone binds the new one.
 *
 * Bindings owned by a workflow version (its tool.call steps, its steps and its
 * seats) are written when the version is published, from its definition, and
 * are part of the version: they cannot be made, changed or removed here.
 */

type Binding = z.output<typeof contractSchemas.CapabilityBinding>;
type BindingCreate = z.output<typeof contractSchemas.CapabilityBindingCreate>;
type BindingQuery = z.output<typeof contractSchemas.BindingQuery>;
type BindingPage = { items: Binding[]; nextCursor: string | null };

type Row = {
  id: string;
  repository_id: string | null;
  agent_version_id: string | null;
  workflow_version_id: string | null;
  skill_version_owner_id: string | null;
  automation_version_id: string | null;
  step_key: string | null;
  seat_key: string | null;
  mcp_connection_id: string | null;
  integration_connection_id: string | null;
  skill_version_id: string | null;
  allowed_operations: unknown;
  required: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
};

const COLUMNS = `id, repository_id, agent_version_id, workflow_version_id,
  skill_version_owner_id, automation_version_id, step_key, seat_key,
  mcp_connection_id, integration_connection_id, skill_version_id,
  allowed_operations, required, created_at, updated_at, version`;

function toBinding(row: Row): Binding {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    agentVersionId: row.agent_version_id,
    workflowVersionId: row.workflow_version_id,
    skillVersionOwnerId: row.skill_version_owner_id,
    automationVersionId: row.automation_version_id,
    stepKey: row.step_key,
    seatKey: row.seat_key,
    mcpConnectionId: row.mcp_connection_id,
    integrationConnectionId: row.integration_connection_id,
    skillVersionId: row.skill_version_id,
    allowedOperations: Array.isArray(row.allowed_operations)
      ? row.allowed_operations
      : [],
    required: row.required,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as Binding;
}

/** The tool names a request may grant: exact, distinct, never a wildcard. */
export function grantedToolNames(
  requested: readonly string[],
): readonly string[] {
  const names = [...new Set(requested.map((name) => name.trim()))];
  if (names.length === 0) {
    throw unprocessable(["allowedOperations"], "binding_operations_empty");
  }
  if (names.some((name) => name.length === 0 || name.includes("*"))) {
    throw unprocessable(["allowedOperations"], "binding_operation_wildcard");
  }
  return names.sort();
}

/** `capabilityBindings.create`: an Admin grants an agent version exact MCP tools. */
export async function createCapabilityBinding(
  context: ActionContext,
  input: BindingCreate,
): Promise<Binding> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  if (
    input.workflowVersionId != null || input.stepKey != null ||
    input.seatKey != null
  ) {
    // A version's bindings come from its definition at publish.
    throw unprocessable(["workflowVersionId"], "binding_owned_by_definition");
  }
  if (
    input.repositoryId != null || input.skillVersionOwnerId != null ||
    input.automationVersionId != null
  ) {
    throw unprocessable(["agentVersionId"], "binding_owner_unsupported");
  }
  if (input.agentVersionId == null) {
    throw unprocessable(["agentVersionId"], "binding_owner_required");
  }
  if (input.integrationConnectionId != null || input.skillVersionId != null) {
    throw unprocessable(["mcpConnectionId"], "binding_target_unsupported");
  }
  if (input.mcpConnectionId == null) {
    throw unprocessable(["mcpConnectionId"], "binding_target_required");
  }
  const tools = grantedToolNames(input.allowedOperations);
  const agent = await transaction.query(
    `select 1 from bakery.agent_versions
      where organization_id = $1 and id = $2`,
    [organizationId, input.agentVersionId],
  );
  if (agent.rows.length === 0) {
    throw unprocessable(["agentVersionId"], "agent_version_not_found");
  }
  const connection = (await transaction.query<{
    id: string;
    owner_principal_id: string | null;
    enabled_capabilities: unknown;
    snapshot_id: string | null;
    snapshot_digest: string | null;
    manifest: unknown;
  }>(
    `select c.id, c.owner_principal_id, c.enabled_capabilities,
            s.id as snapshot_id, s.digest as snapshot_digest, s.manifest
       from bakery.mcp_connections c
       left join lateral (
         select id, digest, manifest from bakery.mcp_capability_snapshots
          where organization_id = c.organization_id and connection_id = c.id
          order by observed_at desc, id desc limit 1
       ) s on true
      where c.organization_id = $1 and c.id = $2
      for update of c`,
    [organizationId, input.mcpConnectionId],
  )).rows[0];
  if (connection === undefined) {
    throw unprocessable(["mcpConnectionId"], "connection_not_found");
  }
  // An agent version runs for anyone; a personal connection acts as one
  // person, so it is bound per workflow through its owner's use grant instead.
  if (connection.owner_principal_id !== null) {
    throw unprocessable(["mcpConnectionId"], "binding_connection_personal");
  }
  if (connection.snapshot_id === null || connection.snapshot_digest === null) {
    throw unprocessable(["mcpConnectionId"], "binding_snapshot_missing");
  }
  const offered = new Set(
    ((connection.manifest as { tools?: { name?: unknown }[] } | null)?.tools ??
      [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const enabled = new Set(
    Array.isArray(connection.enabled_capabilities)
      ? connection.enabled_capabilities
      : [],
  );
  for (const tool of tools) {
    if (!offered.has(tool)) {
      throw unprocessable(["allowedOperations"], "binding_tool_unknown");
    }
    if (!enabled.has(tool)) {
      throw unprocessable(["allowedOperations"], "binding_tool_not_enabled");
    }
  }
  const row = (await transaction.query<Row>(
    `insert into bakery.capability_bindings (
       organization_id, agent_version_id, mcp_connection_id, mcp_snapshot_id,
       mcp_snapshot_digest, actor_ref, allowed_operations, required
     ) values ($1, $2, $3, $4, $5, null, $6::jsonb, $7)
     returning ${COLUMNS}`,
    [
      organizationId,
      input.agentVersionId,
      connection.id,
      connection.snapshot_id,
      connection.snapshot_digest,
      JSON.stringify(tools),
      input.required,
    ],
  )).rows[0]!;
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: CapabilityBindingImplementedAction.CapabilityBindingsCreate,
    resourceType: "capability_binding",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      agentVersionId: input.agentVersionId,
      mcpConnectionId: connection.id,
      snapshotDigest: connection.snapshot_digest,
      allowedOperations: tools,
    },
  });
  return toBinding(row);
}

/** `capabilityBindings.list`: the organization's bindings, newest first, by keyset. */
export function createCapabilityBindingsListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: BindingQuery,
  ): Promise<BindingPage> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const filters = {
      repositoryId: input.repositoryId ?? null,
      agentVersionId: input.agentVersionId ?? null,
      workflowVersionId: input.workflowVersionId ?? null,
      skillVersionOwnerId: input.skillVersionOwnerId ?? null,
      automationVersionId: input.automationVersionId ?? null,
      stepKey: input.stepKey ?? null,
      seatKey: input.seatKey ?? null,
      mcpConnectionId: input.mcpConnectionId ?? null,
      integrationConnectionId: input.integrationConnectionId ?? null,
      skillVersionId: input.skillVersionId ?? null,
      allowedOperations: input.allowedOperations === undefined
        ? null
        : [...input.allowedOperations].sort(),
      required: input.required ?? null,
    };
    const binding: CursorBinding = {
      action: CapabilityBindingImplementedAction.CapabilityBindingsList,
      organizationId,
      principalId,
      ordering: "createdAt:desc,id:desc",
      filters: canonicalJson(filters),
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      Row & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.capability_bindings binding
        where organization_id = $1
          and not exists (
            select 1 from bakery.capability_binding_revocations revoked
             where revoked.organization_id = binding.organization_id
               and revoked.binding_id = binding.id
          )
          and ($2::uuid is null or repository_id = $2)
          and ($3::uuid is null or agent_version_id = $3)
          and ($4::uuid is null or workflow_version_id = $4)
          and ($5::uuid is null or skill_version_owner_id = $5)
          and ($6::uuid is null or automation_version_id = $6)
          and ($7::text is null or step_key = $7)
          and ($8::text is null or seat_key = $8)
          and ($9::uuid is null or mcp_connection_id = $9)
          and ($10::uuid is null or integration_connection_id = $10)
          and ($11::uuid is null or skill_version_id = $11)
          and ($12::text[] is null or allowed_operations ?| $12::text[])
          and ($13::boolean is null or required = $13)
          and ($14::timestamptz is null
               or (created_at, id) < ($14, $15::uuid))
        order by created_at desc, id desc
        limit $16`,
      [
        organizationId,
        filters.repositoryId,
        filters.agentVersionId,
        filters.workflowVersionId,
        filters.skillVersionOwnerId,
        filters.automationVersionId,
        filters.stepKey,
        filters.seatKey,
        filters.mcpConnectionId,
        filters.integrationConnectionId,
        filters.skillVersionId,
        filters.allowedOperations,
        filters.required,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toBinding),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(cursorSecret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/** `capabilityBindings.delete`: an Admin withdraws an agent version's binding. */
export async function deleteCapabilityBinding(
  context: ActionContext,
): Promise<null> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const found = (await transaction.query<Row & { revoked: boolean }>(
    `select ${COLUMNS}, exists (
              select 1 from bakery.capability_binding_revocations revoked
               where revoked.organization_id = binding.organization_id
                 and revoked.binding_id = binding.id
            ) as revoked
       from bakery.capability_bindings binding
      where organization_id = $1 and id = $2`,
    [organizationId, id],
  )).rows[0];
  if (!found) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // A version's pins are part of the version; a changed pin is a new version.
  if (found.workflow_version_id !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "binding_pinned_by_version" },
    });
  }
  // Withdrawn already: the same request again changes nothing.
  if (found.revoked) return null;
  // The binding row is never touched: a withdrawal is its own row, and every
  // read of a grant skips a withdrawn binding.
  await transaction.query(
    `insert into bakery.capability_binding_revocations
       (organization_id, binding_id, revoked_by)
     values ($1, $2, $3)
     on conflict do nothing`,
    [organizationId, id, principalId],
  );
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: CapabilityBindingImplementedAction.CapabilityBindingsDelete,
    resourceType: "capability_binding",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      agentVersionId: found.agent_version_id,
      mcpConnectionId: found.mcp_connection_id,
    },
  });
  return null;
}
