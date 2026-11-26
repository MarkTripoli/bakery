import { unprocessable } from "@bakery/contracts/http";
import {
  isLegacyPresetPin,
  type TicketLegacyPresetPin,
  type TicketPin,
  type TicketPresetId,
  type TicketWorkflowPin,
} from "@bakery/contracts/ticket-admission";
import {
  TICKET_PRESET_IDS,
  workflowPresetById,
  type WorkflowPresetDefinition,
} from "@bakery/contracts/workflow-presets";
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  SourceWorkflow,
  SourceWorkflowRequest,
  SourceWorkflowResolver,
} from "./ticket-policy.ts";
import { ensurePresetWorkflowVersion } from "./workflow-presets.ts";
import { needsInputs } from "../workflow-adapter/plan-admission.ts";

export type TicketWorkflow =
  | Readonly<{
    kind: "ready";
    pin: TicketWorkflowPin;
    builtIn: WorkflowPresetDefinition | null;
  }>
  | Readonly<{ kind: "unavailable"; workflowId: string }>;

type DefinitionRow = {
  id: string;
  enabled: boolean;
  origin_kind: string;
  origin_catalog_key: string | null;
  active_version_id: string | null;
};

type VersionRow = {
  id: string;
  digest: string;
  status: string;
  normalized_spec: unknown;
};

async function activeSpecOf(
  transaction: PgTransactionClient,
  organizationId: string,
  row: DefinitionRow,
): Promise<unknown> {
  const result = await transaction.query<{ normalized_spec: unknown }>(
    `select normalized_spec from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and id = $3`,
    [organizationId, row.id, row.active_version_id],
  );
  return result.rows[0]?.normalized_spec ?? null;
}

function ticketPresetOf(key: string | null): TicketPresetId | null {
  return TICKET_PRESET_IDS.find((id) => id === key) ?? null;
}

function builtInDefinition(id: TicketPresetId): WorkflowPresetDefinition {
  const preset = workflowPresetById(id);
  if (preset === undefined) throw new Error("TICKET_PRESET_UNKNOWN");
  return preset;
}

async function definitionRow(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<DefinitionRow | null> {
  const result = await transaction.query<DefinitionRow>(
    `select id, enabled, origin_kind, origin_catalog_key, active_version_id
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, workflowId],
  );
  return result.rows[0] ?? null;
}

function builtInOf(row: DefinitionRow): TicketPresetId | null {
  return row.origin_kind === "catalog"
    ? ticketPresetOf(row.origin_catalog_key)
    : null;
}

export async function installBuiltInWorkflow(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  builtIn: TicketPresetId,
): Promise<string> {
  const versionId = await ensurePresetWorkflowVersion(
    transaction,
    organizationId,
    principalId,
    builtInDefinition(builtIn),
  );
  const result = await transaction.query<{ workflow_id: string }>(
    `select workflow_id from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [organizationId, versionId],
  );
  const workflowId = result.rows[0]?.workflow_id;
  if (workflowId === undefined) throw new Error("BUILT_IN_WORKFLOW_MISSING");
  return workflowId;
}

export async function sourceWorkflowOf(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  requested: SourceWorkflowRequest,
): Promise<SourceWorkflow> {
  if (requested.workflowId === undefined) {
    const builtIn = requested.builtIn;
    if (builtIn === undefined) {
      throw unprocessable(["policy", "workflow"], "workflow_required");
    }
    return {
      workflowId: await installBuiltInWorkflow(
        transaction,
        organizationId,
        principalId,
        builtIn,
      ),
      builtIn,
    };
  }
  const row = await definitionRow(
    transaction,
    organizationId,
    requested.workflowId,
  );
  if (row === null) {
    throw unprocessable(
      ["policy", "workflow", "workflowId"],
      "workflow_not_found",
    );
  }
  const builtIn = builtInOf(row);
  if (row.origin_kind === "catalog" && builtIn === null) {
    throw unprocessable(
      ["policy", "workflow", "workflowId"],
      "workflow_not_ticket_workflow",
    );
  }
  if (requested.builtIn !== undefined && requested.builtIn !== builtIn) {
    throw unprocessable(
      ["policy", "workflow", "builtIn"],
      "workflow_built_in_mismatch",
    );
  }
  if (
    builtIn === null &&
    needsInputs(await activeSpecOf(transaction, organizationId, row))
  ) {
    throw unprocessable(
      ["policy", "workflow", "workflowId"],
      "workflow_needs_inputs",
    );
  }
  return builtIn === null
    ? { workflowId: row.id }
    : { workflowId: row.id, builtIn };
}

export function sourceWorkflowResolver(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): SourceWorkflowResolver {
  return (requested) =>
    sourceWorkflowOf(transaction, organizationId, principalId, requested);
}

async function versionRow(
  transaction: PgTransactionClient,
  organizationId: string,
  row: DefinitionRow,
  builtIn: WorkflowPresetDefinition | null,
): Promise<VersionRow | null> {
  const result = await transaction.query<VersionRow>(
    builtIn === null
      ? `select id, digest, status, normalized_spec from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2 and id = $3`
      : `select id, digest, status, normalized_spec from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2
          order by (revision = $4) desc, (id = $3) desc, revision desc
          limit 1`,
    builtIn === null
      ? [organizationId, row.id, row.active_version_id]
      : [organizationId, row.id, row.active_version_id, builtIn.revision],
  );
  return result.rows[0] ?? null;
}

export async function ticketWorkflowOf(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<TicketWorkflow> {
  const unavailable = { kind: "unavailable", workflowId } as const;
  const row = await definitionRow(transaction, organizationId, workflowId);
  if (row === null || !row.enabled) return unavailable;
  const key = builtInOf(row);
  if (row.origin_kind === "catalog" && key === null) return unavailable;
  const builtIn = key === null ? null : builtInDefinition(key);
  const version = await versionRow(transaction, organizationId, row, builtIn);
  if (version === null || version.status !== "published") return unavailable;
  if (
    builtIn === null &&
    needsInputs(version.normalized_spec)
  ) return unavailable;
  return {
    kind: "ready",
    pin: { workflowId: row.id, versionId: version.id, digest: version.digest },
    builtIn,
  };
}

export async function pinnedTicketWorkflow(
  transaction: PgTransactionClient,
  organizationId: string,
  pinned: TicketPin,
): Promise<TicketWorkflow> {
  if (isLegacyPresetPin(pinned)) {
    return await legacyTicketWorkflow(transaction, organizationId, pinned);
  }
  const pin = pinned;
  const row = await definitionRow(transaction, organizationId, pin.workflowId);
  const key = row === null ? null : builtInOf(row);
  return {
    kind: "ready",
    pin,
    builtIn: key === null ? null : builtInDefinition(key),
  };
}

async function legacyTicketWorkflow(
  transaction: PgTransactionClient,
  organizationId: string,
  pin: TicketLegacyPresetPin,
): Promise<TicketWorkflow> {
  const builtIn = builtInDefinition(pin.id);
  const result = await transaction.query<
    { workflow_id: string; version_id: string; digest: string }
  >(
    `select definition.id as workflow_id, version.id as version_id,
            version.digest
       from bakery.workflow_definitions definition
       join bakery.workflow_versions version
         on version.organization_id = definition.organization_id
        and version.workflow_id = definition.id
      where definition.organization_id = $1 and definition.slug = $2
        and definition.origin_kind = 'catalog' and version.status = 'published'
      order by (version.revision = $3) desc, (version.revision = $4) desc,
               version.revision desc
      limit 1`,
    [organizationId, builtIn.slug, pin.revision, builtIn.revision],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return { kind: "unavailable", workflowId: `built-in:${pin.id}` };
  }
  return {
    kind: "ready",
    pin: {
      workflowId: row.workflow_id,
      versionId: row.version_id,
      digest: row.digest,
    },
    builtIn,
  };
}

export async function builtInWorkflowId(
  transaction: PgTransactionClient,
  organizationId: string,
  builtIn: TicketPresetId,
  principalId: string | null,
): Promise<string | null> {
  const preset = builtInDefinition(builtIn);
  const result = await transaction.query<{ id: string }>(
    `select id from bakery.workflow_definitions
      where organization_id = $1 and slug = $2 and origin_kind = 'catalog'`,
    [organizationId, preset.slug],
  );
  const found = result.rows[0]?.id;
  if (found !== undefined || principalId === null) return found ?? null;
  return await installBuiltInWorkflow(
    transaction,
    organizationId,
    principalId,
    builtIn,
  );
}
