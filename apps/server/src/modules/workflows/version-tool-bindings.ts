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
  calls?: ReadonlyMap<string, unknown>,
): Promise<readonly ToolCallPin[]> {
  const { actionSites } = await compileWorkflowDocumentDetailed(definition, {
    catalog: defaultWorkflowCompilerCatalog(),
    workflows: calls,
  });
  const pins: ToolCallPin[] = [];
  for (const site of actionSites) {
    if (site.action !== "tool.call") continue;
    // A step the compiler brought in from a called workflow is located at its
    // call, not at a step of this definition, and has no pin here.
    const authored = at(definition, site.path) as Json | undefined;
    if (authored?.uses !== "tool.call") continue;
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
  pairedRead: string | null;
  asyncForm: McpAsyncForm | null;
}>;

export type McpAsyncForm = Readonly<{
  kind: "submit_poll_v1";
  effectKeyArgument: string;
  pollTool: string;
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
    /** The published versions the definition may call; see called-workflows.ts. */
    calls?: ReadonlyMap<string, unknown>;
  }>,
): Promise<ToolBindingCheck> {
  const found = await toolCallPins(facts.definition, facts.calls);
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
    const paired = await transaction.query<{
      effect_class: string;
      paired_read_tool: string | null;
      effect_key_argument: string | null;
    }>(
      `select effect_class, paired_read_tool, effect_key_argument
         from bakery.mcp_tool_classifications
        where organization_id = $1 and connection_id = $2 and tool_name = $3
          and snapshot_digest = $4
          and effect_class in ('write_reconcilable', 'write_async')`,
      [facts.organizationId, row.id, pin.tool, row.snapshot_digest],
    );
    const classified = paired.rows[0];
    const pairedRead = classified?.paired_read_tool ?? null;
    if (pairedRead !== null && !enabled.includes(pairedRead)) {
      refuse(pin, "tool_call_paired_read_not_enabled");
      continue;
    }
    const asyncForm = asyncFormOf(classified);
    if (classified?.effect_class === "write_async" && asyncForm === null) {
      refuse(pin, "tool_call_async_form_incomplete");
      continue;
    }
    pins.push(Object.freeze({
      stepKey: pin.stepKey,
      connectionId: row.id,
      snapshotId: row.snapshot_id,
      snapshotDigest: row.snapshot_digest,
      tool: pin.tool,
      pairedRead,
      asyncForm,
    }));
  }
  return { issues, pins };
}

function asyncFormOf(
  classified:
    | Readonly<{
      effect_class: string;
      paired_read_tool: string | null;
      effect_key_argument: string | null;
    }>
    | undefined,
): McpAsyncForm | null {
  if (
    classified?.effect_class !== "write_async" ||
    classified.paired_read_tool === null ||
    classified.effect_key_argument === null
  ) return null;
  return Object.freeze({
    kind: "submit_poll_v1",
    effectKeyArgument: classified.effect_key_argument,
    pollTool: classified.paired_read_tool,
  });
}

/**
 * Writes one binding per resolved pin, owned by the version and the step. The
 * grant is the exact tool name (and the read paired with it), never a wildcard, and is for any actor of the
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
         required, mcp_async_form
       ) values ($1, $2, $3, $4, $5, $6, null, $7::jsonb, true, $8::jsonb)`,
      [
        facts.organizationId,
        facts.workflowVersionId,
        pin.stepKey,
        pin.connectionId,
        pin.snapshotId,
        pin.snapshotDigest,
        JSON.stringify(
          pin.pairedRead === null ? [pin.tool] : [pin.tool, pin.pairedRead],
        ),
        pin.asyncForm === null ? null : JSON.stringify(pin.asyncForm),
      ],
    );
  }
}

/**
 * One binding the workflow tools section asks for (#436, 25-one-engine.md 15.5):
 * a step or a seat of the version, the connection, the snapshot it is pinned to
 * and the exact tools.
 */
export type ResolvedSectionPin = Readonly<{
  stepKey: string | null;
  seatKey: string | null;
  connectionId: string;
  snapshotId: string;
  snapshotDigest: string;
  tools: readonly string[];
}>;

type SectionEntry = { connectionId: string; allow: string[]; seats?: string[] };

function sectionOf(definition: unknown): Record<string, SectionEntry> {
  const tools = at(definition, ["tools"]);
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) {
    return {};
  }
  return tools as Record<string, SectionEntry>;
}

/**
 * Checks the workflow tools section against the connections it names and
 * returns the findings and the step and seat bindings to write. Each entry is
 * pinned to its connection's latest snapshot, the same one invoke compares a
 * binding with, and every tool it allows must be one the server offers and an
 * Admin enabled. A personal connection needs its owner's grant, as for a
 * tool.call step.
 */
export async function checkToolSectionPins(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    workflowId: string | null;
    definition: unknown;
  }>,
): Promise<
  Readonly<{
    issues: readonly WorkflowValidationIssue[];
    pins: readonly ResolvedSectionPin[];
  }>
> {
  const section = sectionOf(facts.definition);
  const names = Object.keys(section).sort();
  const issues: WorkflowValidationIssue[] = [];
  const refuse = (path: string, code: string) =>
    issues.push(Object.freeze({
      path,
      code,
      message: code.replaceAll("_", " "),
    }));
  const resolved = new Map<
    string,
    { connectionId: string; snapshotId: string; snapshotDigest: string }
  >();
  for (const name of names) {
    const entry = section[name]!;
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
      [facts.organizationId, entry.connectionId, facts.workflowId],
    );
    const row = rows.rows[0];
    const entryPath = `/tools/${name}`;
    if (row === undefined) {
      refuse(`${entryPath}/connectionId`, "tools_connection_not_found");
      continue;
    }
    if (
      row.owner_principal_id !== null &&
      row.owner_principal_id !== facts.principalId && !row.use_granted
    ) {
      refuse(`${entryPath}/connectionId`, "tools_connection_not_usable");
      continue;
    }
    if (row.status !== "enabled") {
      refuse(`${entryPath}/connectionId`, "tools_connection_off");
      continue;
    }
    if (row.snapshot_id === null || row.snapshot_digest === null) {
      refuse(`${entryPath}/connectionId`, "tools_snapshot_missing");
      continue;
    }
    const offered = new Set(
      ((row.manifest as { tools?: { name?: unknown }[] } | null)?.tools ?? [])
        .map((tool) => tool.name),
    );
    const enabled = Array.isArray(row.enabled_capabilities)
      ? row.enabled_capabilities
      : [];
    let failed = false;
    for (const tool of entry.allow) {
      if (!offered.has(tool)) {
        refuse(`${entryPath}/allow`, "tools_tool_unknown");
        failed = true;
        break;
      }
      if (!enabled.includes(tool)) {
        refuse(`${entryPath}/allow`, "tools_tool_not_enabled");
        failed = true;
        break;
      }
    }
    if (failed) continue;
    resolved.set(name, {
      connectionId: row.id,
      snapshotId: row.snapshot_id,
      snapshotDigest: row.snapshot_digest,
    });
  }

  const pins: ResolvedSectionPin[] = [];
  // Seats: every step that runs as the seat gets the entry's tools.
  for (const name of names) {
    const target = resolved.get(name);
    if (target === undefined) continue;
    for (const seat of section[name]!.seats ?? []) {
      pins.push(Object.freeze({
        stepKey: null,
        seatKey: seat,
        ...target,
        tools: Object.freeze([...section[name]!.allow].sort()),
      }));
    }
  }
  // Steps: a reference names an entry (all its tools) or one of its tools.
  if (names.length > 0) {
    const { actionSites } = await compileWorkflowDocumentDetailed(
      facts.definition,
      { catalog: defaultWorkflowCompilerCatalog() },
    );
    for (const site of actionSites) {
      const references = at(facts.definition, [...site.path, "tools"]);
      if (!Array.isArray(references) || references.length === 0) continue;
      // A tool.call step calls one pinned tool and has no session to offer
      // tools to; its own pin is keyed by the same step.
      if (site.action === "tool.call") {
        refuse(`${pointerOf(site.path)}/tools`, "tools_on_tool_call_step");
        continue;
      }
      const byEntry = new Map<string, Set<string>>();
      for (const reference of references) {
        if (typeof reference !== "string") continue;
        const dot = reference.indexOf(".");
        const name = dot < 0 ? reference : reference.slice(0, dot);
        const entry = section[name];
        if (entry === undefined) continue;
        const tools = byEntry.get(name) ?? new Set<string>();
        for (
          const tool of dot < 0 ? entry.allow : [reference.slice(dot + 1)]
        ) tools.add(tool);
        byEntry.set(name, tools);
      }
      for (const [name, tools] of [...byEntry].sort()) {
        const target = resolved.get(name);
        if (target === undefined) continue;
        pins.push(Object.freeze({
          stepKey: site.qualifiedId,
          seatKey: null,
          ...target,
          tools: Object.freeze([...tools].sort()),
        }));
      }
    }
  }
  return { issues, pins };
}

/**
 * Writes the tools section's bindings, owned by the version and one step or one
 * seat. Exact tool names, never a wildcard, and for any actor: who may run the
 * step is the workflow's rule.
 */
export async function writeToolSectionBindings(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    workflowVersionId: string;
    pins: readonly ResolvedSectionPin[];
  }>,
): Promise<void> {
  for (const pin of facts.pins) {
    await transaction.query(
      `insert into bakery.capability_bindings (
         organization_id, workflow_version_id, step_key, seat_key,
         mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref,
         allowed_operations, required
       ) values ($1, $2, $3, $4, $5, $6, $7, null, $8::jsonb, true)`,
      [
        facts.organizationId,
        facts.workflowVersionId,
        pin.stepKey,
        pin.seatKey,
        pin.connectionId,
        pin.snapshotId,
        pin.snapshotDigest,
        JSON.stringify(pin.tools),
      ],
    );
  }
}
