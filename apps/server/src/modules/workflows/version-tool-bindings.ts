import {
  compileWorkflowDocumentDetailed,
  pointerOf,
} from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { WorkflowValidationIssue } from "./validation.ts";

/**
 * A published workflow version pins the MCP tool each of its `tool.call` steps
 * calls (#435, docs/technical-design/25-one-engine.md 15.4): the connection, the
 * capability snapshot digest it was published against and the exact tool name,
 * written to `capability_bindings` owned by the version and the step. Drift on a
 * used tool then refuses the call at invoke ("update available"); nothing
 * updates on its own, and a new pin is a new version.
 *
 * Only a step that names its connection and tool as literals can be pinned. A
 * step whose connection is not an MCP connection is an integration call and
 * pins nothing here. A reference for either field leaves nothing to pin, so an
 * MCP call it reaches is refused at invoke for want of a binding.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ToolCallPin = Readonly<{
  /** The step's id from the workflow root, dot-joined; the key an invoke matches. */
  stepKey: string;
  /** Authored JSON Pointer of the step. */
  pointer: string;
  connectionId: string;
  tool: unknown;
}>;

type Json = Record<string, unknown>;

function at(value: unknown, segments: readonly (string | number)[]): unknown {
  let node = value;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/** Every tool.call step that names a literal connection id, in authored order. */
export async function toolCallPins(
  definition: unknown,
): Promise<readonly ToolCallPin[]> {
  const { actionSites } = await compileWorkflowDocumentDetailed(definition, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  const pins: ToolCallPin[] = [];
  for (const site of actionSites) {
    if (site.action !== "tool.call") continue;
    const withInput = at(definition, [...site.path, "with"]) as
      | Json
      | undefined;
    const connectionId = withInput?.connectionId;
    if (typeof connectionId !== "string" || !UUID.test(connectionId)) continue;
    pins.push(Object.freeze({
      stepKey: site.qualifiedId,
      pointer: pointerOf(site.path),
      connectionId,
      tool: withInput?.tool,
    }));
  }
  return pins;
}

/** A pin resolved against the connection's current capability snapshot. */
export type ResolvedToolPin = Readonly<{
  stepKey: string;
  connectionId: string;
  snapshotId: string;
  snapshotDigest: string;
  tool: string;
}>;

type ConnectionRow = {
  id: string;
  status: string;
  owner_principal_id: string | null;
  enabled_capabilities: unknown;
  snapshot_id: string | null;
  snapshot_digest: string | null;
  manifest: unknown;
  use_granted: boolean;
};

export type ToolBindingCheck = Readonly<{
  issues: readonly WorkflowValidationIssue[];
  pins: readonly ResolvedToolPin[];
}>;

/**
 * Checks every MCP tool.call step of a definition against the connection it names
 * and returns the findings and the pins to write. The latest snapshot is the one
 * a pin is taken against, the same one invoke compares a binding with.
 */
export async function checkToolCallPins(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    workflowId: string | null;
    definition: unknown;
  }>,
): Promise<ToolBindingCheck> {
  const found = await toolCallPins(facts.definition);
  const issues: WorkflowValidationIssue[] = [];
  const pins: ResolvedToolPin[] = [];
  const refuse = (pin: ToolCallPin, code: string, tail = "with/tool") =>
    issues.push(Object.freeze({
      path: `${pin.pointer}/${tail}`,
      code,
      message: code.replaceAll("_", " "),
    }));
  for (const pin of found) {
    const rows = await transaction.query<ConnectionRow>(
      `select c.id, c.status, c.owner_principal_id, c.enabled_capabilities,
              s.id as snapshot_id, s.digest as snapshot_digest, s.manifest,
              (
                c.owner_principal_id is not null and exists (
                  select 1 from bakery.mcp_use_grants g
                   where g.organization_id = c.organization_id
                     and g.connection_id = c.id
                     and g.workflow_id = $3::uuid
                     and g.revoked_at is null
                )
              ) as use_granted
         from bakery.mcp_connections c
         left join lateral (
           select id, digest, manifest from bakery.mcp_capability_snapshots
            where organization_id = c.organization_id and connection_id = c.id
            order by observed_at desc, id desc limit 1
         ) s on true
        where c.organization_id = $1 and c.id = $2`,
      [facts.organizationId, pin.connectionId, facts.workflowId],
    );
    const row = rows.rows[0];
    // Not an MCP connection of this organization: an integration call, or one
    // that does not exist, which the engine answers when it runs.
    if (row === undefined) continue;
    // Someone else's personal connection is not theirs to put in a workflow
    // unless its owner granted this workflow the use.
    if (
      row.owner_principal_id !== null &&
      row.owner_principal_id !== facts.principalId && !row.use_granted
    ) {
      refuse(pin, "tool_call_connection_not_usable", "with/connectionId");
      continue;
    }
    if (row.status !== "enabled") {
      refuse(pin, "tool_call_connection_off", "with/connectionId");
      continue;
    }
    if (typeof pin.tool !== "string" || pin.tool.length === 0) {
      refuse(pin, "tool_call_tool_unpinned");
      continue;
    }
    if (row.snapshot_id === null || row.snapshot_digest === null) {
      refuse(pin, "tool_call_snapshot_missing", "with/connectionId");
      continue;
    }
    const tools = (row.manifest as { tools?: { name?: unknown }[] } | null)
      ?.tools ?? [];
    if (!tools.some((tool) => tool.name === pin.tool)) {
      refuse(pin, "tool_call_tool_unknown");
      continue;
    }
    const enabled = Array.isArray(row.enabled_capabilities)
      ? row.enabled_capabilities
      : [];
    if (!enabled.includes(pin.tool)) {
      refuse(pin, "tool_call_tool_not_enabled");
      continue;
    }
    pins.push(Object.freeze({
      stepKey: pin.stepKey,
      connectionId: row.id,
      snapshotId: row.snapshot_id,
      snapshotDigest: row.snapshot_digest,
      tool: pin.tool,
    }));
  }
  return { issues, pins };
}

/**
 * Writes one binding per resolved pin, owned by the version and the step. The
 * grant is the exact tool name, never a wildcard, and is for any actor of the
 * organization: who may run the step is the workflow's rule, not the pin's.
 */
export async function writeToolCallBindings(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    workflowVersionId: string;
    pins: readonly ResolvedToolPin[];
  }>,
): Promise<void> {
  for (const pin of facts.pins) {
    await transaction.query(
      `insert into bakery.capability_bindings (
         organization_id, workflow_version_id, step_key, mcp_connection_id,
         mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations,
         required
       ) values ($1, $2, $3, $4, $5, $6, null, $7::jsonb, true)`,
      [
        facts.organizationId,
        facts.workflowVersionId,
        pin.stepKey,
        pin.connectionId,
        pin.snapshotId,
        pin.snapshotDigest,
        JSON.stringify([pin.tool]),
      ],
    );
  }
}
