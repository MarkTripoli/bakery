import { compileWorkflowDocumentDetailed } from "@bakery/contracts/workflow-compiler";
import { defaultWorkflowCompilerCatalog } from "@bakery/contracts/workflow-compiler/default-catalog";
import { WORKFLOW_ACTION_METADATA } from "@bakery/contracts/workflow-action-registry";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The effective tools of one agent session (#436, docs/technical-design/
 * 25-one-engine.md 15.4 and 15.5): the MCP tools the worker's tool gateway lists
 * and the only ones `worker.invokeTool` will send.
 *
 * A tool is effective for a session when all of these hold, read fresh:
 *
 * - a capability binding grants it by exact name to the session's agent version,
 *   its seat (the workflow version plus the role the step runs as) or its step;
 * - the connection is enabled, and a personal connection is usable for this run
 *   (its owner started it, or granted the workflow, O27);
 * - an Admin enabled the tool on the connection;
 * - the binding's pinned snapshot is still the connection's latest and still
 *   holds the tool. Drift does not re-pin: the tool is listed as unavailable
 *   with "update available" until someone binds the new snapshot.
 * - a reviewer-role session gets only tools an Admin classified as reads.
 *
 * Nothing here trusts the worker: the scope is read from the attempt's own rows,
 * and the same function answers the listing and the call, so a tool cannot be
 * callable without being listed or listed without being callable.
 */

/** Who a session is, as far as its bindings are concerned. */
export type SessionToolScope = Readonly<{
  attemptId: string;
  runId: string;
  runStepId: string;
  workflowVersionId: string | null;
  /** The step's id from the workflow root, without repeat-round marks. */
  stepKey: string;
  /** The role the step runs as, when it declares one. */
  seatKey: string | null;
  agentVersionId: string | null;
  /** Reviewer sessions are offered read tools only. */
  reviewer: boolean;
  /** Who started the run; every workflow run has one (requested_by is not null). */
  startedByPrincipalId: string;
  /** Offline runs reach nothing outside (#427). */
  live: boolean;
}>;

/** One tool a session may call through its gateway. */
export type EffectiveMcpTool = Readonly<{
  /** The name the gateway shows the agent; unique within the session. */
  name: string;
  /** The tool's own name on the server. */
  toolName: string;
  connectionId: string;
  connectionName: string;
  description: string;
  inputSchema: unknown;
  snapshotDigest: string;
  /** True when an Admin classified the tool as a read. */
  readOnly: boolean;
  /** Which owner granted it: the most specific binding wins. */
  grantedBy: "step" | "seat" | "agent";
}>;

/** A bound tool the session cannot call now, and why, so the gap is visible. */
export type UnavailableMcpTool = Readonly<{
  toolName: string;
  connectionId: string;
  reason:
    | "update_available"
    | "connection_off"
    | "tool_not_enabled"
    | "personal_not_usable"
    | "reviewer_read_only"
    | "offline";
}>;

export type EffectiveMcpTools = Readonly<{
  tools: readonly EffectiveMcpTool[];
  unavailable: readonly UnavailableMcpTool[];
}>;

type ScopeRow = {
  run_id: string;
  run_step_id: string;
  step_key: string;
  workflow_version_id: string | null;
  definition: unknown;
  agent_version_id: string | null;
  requested_by: string;
  environment: string | null;
};

function at(value: unknown, segments: readonly (string | number)[]): unknown {
  let node = value;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/** The role and action of one step of a published definition, by its key. */
export async function stepRoleOf(
  definition: unknown,
  stepKey: string,
): Promise<{ role: string | null; action: string | null }> {
  const { actionSites } = await compileWorkflowDocumentDetailed(definition, {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  const site = actionSites.find((candidate) =>
    candidate.qualifiedId === stepKey
  );
  if (site === undefined) return { role: null, action: null };
  const role = at(definition, [...site.path, "role"]);
  return {
    role: typeof role === "string" && role.length > 0 ? role : null,
    action: site.action,
  };
}

/** Whether an action is a reviewer's: its registry entry needs the reviewer capability. */
export function reviewerAction(action: string | null): boolean {
  if (action === null) return false;
  const metadata = (WORKFLOW_ACTION_METADATA as Readonly<
    Record<string, { capabilities: readonly string[] } | undefined>
  >)[action];
  return metadata?.capabilities.includes("reviewer") ?? false;
}

/**
 * Reads the scope of one attempt from its own rows. Null when the attempt is
 * not part of a workflow run of this organization.
 */
export async function sessionToolScope(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<SessionToolScope | null> {
  const found = await transaction.query<ScopeRow>(
    `select run.id as run_id, step.id as run_step_id, step.step_key,
            run.workflow_version_id, version.normalized_spec as definition,
            job.agent_version_id, run.requested_by, run.environment
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       left join bakery.workflow_versions version
         on version.organization_id = run.organization_id
        and version.id = run.workflow_version_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [organizationId, attemptId],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  // A binding is keyed by the step's id from the root; the run's step key also
  // carries an @n for every enclosing repeat round.
  const stepKey = row.step_key.replace(/@\d+/g, "");
  const step = row.definition === null
    ? { role: null, action: null }
    : await stepRoleOf(row.definition, stepKey);
  return {
    attemptId,
    runId: row.run_id,
    runStepId: row.run_step_id,
    workflowVersionId: row.workflow_version_id,
    stepKey,
    seatKey: step.role,
    agentVersionId: row.agent_version_id,
    reviewer: step.role === "reviewer" || reviewerAction(step.action),
    startedByPrincipalId: row.requested_by,
    live: (row.environment ?? "live") === "live",
  };
}

type BindingRow = {
  binding_id: string;
  connection_id: string;
  connection_name: string;
  connection_status: string;
  enabled_capabilities: unknown;
  owner_principal_id: string | null;
  use_grant_live: boolean;
  allowed_operations: unknown;
  pinned_digest: string | null;
  pinned_manifest: unknown;
  latest_digest: string | null;
  granted_by: "step" | "seat" | "agent";
};

type ManifestTool = { name: string; description: string; inputSchema: unknown };

function manifestTools(manifest: unknown): ManifestTool[] {
  const tools = (manifest as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  const out: ManifestTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const { name, description, inputSchema } = tool as Record<string, unknown>;
    if (typeof name !== "string") continue;
    out.push({
      name,
      description: typeof description === "string" ? description : "",
      inputSchema: inputSchema ?? { type: "object" },
    });
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const SPECIFICITY = { step: 3, seat: 2, agent: 1 } as const;

/** The MCP tools one session may call, and the bound ones it cannot, with why. */
export async function effectiveMcpTools(
  transaction: PgTransactionClient,
  organizationId: string,
  scope: SessionToolScope,
): Promise<EffectiveMcpTools> {
  const rows = await transaction.query<BindingRow>(
    `select binding.id as binding_id,
            connection.id as connection_id,
            connection.label as connection_name,
            connection.status as connection_status,
            connection.enabled_capabilities,
            connection.owner_principal_id,
            exists (
              select 1 from bakery.mcp_use_grants grant_row
                join bakery.workflow_versions granted
                  on granted.organization_id = grant_row.organization_id
                 and granted.workflow_id = grant_row.workflow_id
               where grant_row.organization_id = connection.organization_id
                 and grant_row.connection_id = connection.id
                 and grant_row.revoked_at is null
                 and granted.id = $3::uuid
            ) as use_grant_live,
            binding.allowed_operations,
            binding.mcp_snapshot_digest as pinned_digest,
            pinned.manifest as pinned_manifest,
            latest.digest as latest_digest,
            case
              when binding.step_key is not null then 'step'
              when binding.seat_key is not null then 'seat'
              else 'agent'
            end as granted_by
       from bakery.capability_bindings binding
       join bakery.mcp_connections connection
         on connection.organization_id = binding.organization_id
        and connection.id = binding.mcp_connection_id
       left join bakery.mcp_capability_snapshots pinned
         on pinned.organization_id = binding.organization_id
        and pinned.id = binding.mcp_snapshot_id
        and pinned.connection_id = connection.id
       left join lateral (
         select s.digest from bakery.mcp_capability_snapshots s
          where s.organization_id = connection.organization_id
            and s.connection_id = connection.id
          order by s.observed_at desc, s.id desc
          limit 1
       ) latest on true
      where binding.organization_id = $1
        and binding.mcp_connection_id is not null
        and not exists (
          select 1 from bakery.capability_binding_revocations revoked
           where revoked.organization_id = binding.organization_id
             and revoked.binding_id = binding.id
        )
        and binding.actor_ref is null
        and (
          (binding.agent_version_id = $2::uuid
            and binding.workflow_version_id is null)
          or (binding.workflow_version_id = $3::uuid
            and binding.agent_version_id is null
            and (
              (binding.step_key = $4 and binding.seat_key is null)
              or (binding.seat_key = $5 and binding.step_key is null)
            ))
        )
      order by binding.created_at, binding.id`,
    [
      organizationId,
      scope.agentVersionId,
      scope.workflowVersionId,
      scope.stepKey,
      scope.seatKey,
    ],
  );

  // Classifications decide what a reviewer may see; read once for every
  // connection the bindings name.
  const connectionIds = [...new Set(rows.rows.map((row) => row.connection_id))];
  const reads = new Set<string>();
  if (connectionIds.length > 0) {
    const classified = await transaction.query<{
      connection_id: string;
      tool_name: string;
      snapshot_digest: string;
    }>(
      `select connection_id, tool_name, snapshot_digest
         from bakery.mcp_tool_classifications
        where organization_id = $1 and connection_id = any($2::uuid[])
          and effect_class = 'read'`,
      [organizationId, connectionIds],
    );
    for (const row of classified.rows) {
      reads.add(
        `${row.connection_id}\u0000${row.snapshot_digest}\u0000${row.tool_name}`,
      );
    }
  }

  const chosen = new Map<string, EffectiveMcpTool>();
  const unavailable = new Map<string, UnavailableMcpTool>();
  for (const row of rows.rows) {
    const allowed = strings(row.allowed_operations).filter((name) =>
      name !== "*"
    );
    const enabled = new Set(strings(row.enabled_capabilities));
    const pinned = new Map(
      manifestTools(row.pinned_manifest).map((tool) => [tool.name, tool]),
    );
    for (const toolName of allowed) {
      const key = `${row.connection_id}\u0000${toolName}`;
      const refuse = (reason: UnavailableMcpTool["reason"]) => {
        if (!chosen.has(key)) {
          unavailable.set(key, {
            toolName,
            connectionId: row.connection_id,
            reason,
          });
        }
      };
      if (!scope.live) {
        refuse("offline");
        continue;
      }
      if (row.connection_status !== "enabled") {
        refuse("connection_off");
        continue;
      }
      if (row.owner_principal_id !== null) {
        const started = scope.startedByPrincipalId;
        if (started !== row.owner_principal_id && !row.use_grant_live) {
          refuse("personal_not_usable");
          continue;
        }
      }
      if (!enabled.has(toolName)) {
        refuse("tool_not_enabled");
        continue;
      }
      const tool = pinned.get(toolName);
      if (
        tool === undefined || row.pinned_digest === null ||
        row.latest_digest !== row.pinned_digest
      ) {
        refuse("update_available");
        continue;
      }
      const readOnly = reads.has(
        `${row.connection_id}\u0000${row.pinned_digest}\u0000${toolName}`,
      );
      if (scope.reviewer && !readOnly) {
        refuse("reviewer_read_only");
        continue;
      }
      const previous = chosen.get(key);
      if (
        previous !== undefined &&
        SPECIFICITY[previous.grantedBy] >= SPECIFICITY[row.granted_by]
      ) continue;
      unavailable.delete(key);
      chosen.set(key, {
        name: toolName,
        toolName,
        connectionId: row.connection_id,
        connectionName: row.connection_name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        snapshotDigest: row.pinned_digest,
        readOnly,
        grantedBy: row.granted_by,
      });
    }
  }
  return {
    tools: exposeNames([...chosen.values()]),
    unavailable: [...unavailable.values()].sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId) ||
      left.toolName.localeCompare(right.toolName)
    ),
  };
}

/**
 * Gives each tool a name unique within the session. A name only one connection
 * offers stays as the server named it; a name two connections offer gets the
 * connection's id prefix, so the agent never calls the wrong server by a shared
 * name. Sorted, so the same bindings list the same way twice.
 */
export function exposeNames(
  tools: readonly EffectiveMcpTool[],
): EffectiveMcpTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  }
  return tools.map((tool) => ({
    ...tool,
    name: (counts.get(tool.toolName) ?? 0) > 1
      ? `${tool.toolName}__${tool.connectionId.slice(0, 8)}`
      : tool.toolName,
  })).sort((left, right) => left.name.localeCompare(right.name));
}
