/**
 * Automation definitions, their immutable versions and the firings a version
 * produced (issue #36): create, read, list and the lifecycle change (name,
 * enabled, active version). The scheduler (`automation.tick`) and event
 * triggers are separate; this module only keeps the rows they will use and
 * the schedule cursor (`next_fire_at`) consistent with them.
 */
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type { PgTransactionClient } from "../../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../../platform/postgres-errors.ts";
import { canonicalJson, sha256Hex } from "../../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import { nextOccurrence, parseCron } from "./schedule.ts";
import {
  type AutomationTrigger,
  parseTrigger,
  TriggerError,
} from "./trigger.ts";

const DEFINITIONS_ORDERING = "createdAt:desc,id:desc";
const VERSIONS_ORDERING = "revision:desc,id:desc";
// The cursor vocabulary knows the timestamp ordering by this name; for firings
// the timestamp it carries is the scheduled instant, not the creation time.
const FIRINGS_ORDERING = "createdAt:desc,id:desc";
const DEFINITION_COLUMNS =
  "id, slug, name, description, active_version_id, enabled, next_fire_at, created_at, updated_at, version";
const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

type DefinitionRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  enabled: boolean;
  next_fire_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type VersionRow = {
  id: string;
  automation_id: string;
  revision: number;
  trigger: unknown;
  workflow_version_id: string;
  actor_id: string;
  inputs: unknown;
  misfire_policy: string;
  overlap_policy: string;
  digest: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type FiringRow = {
  id: string;
  automation_version_id: string;
  scheduled_at: Date | string;
  trigger_event_id: string | null;
  status: string;
  pending: boolean;
  skipped_count: number;
  run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type CursorQueryInput = { cursor?: string; limit?: number };
type CreateInput = { slug: string; name: string; description: string };
type UpdateInput = {
  name?: string;
  enabled?: boolean;
  activeVersionId?: string | null;
};
type VersionCreateInput = {
  trigger: JsonValue;
  workflowVersionId: string;
  inputs: JsonValue;
  misfirePolicy: "coalesce" | "skip";
  overlapPolicy: "skip" | "queue_one";
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * The safe projection of a definition. A disabled automation computes no next
 * fire time: the scheduler keeps its cursor, so that re-enabling can apply the
 * active version's misfire policy to what was missed, but it is not shown.
 */
export function toAutomation(row: DefinitionRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    activeVersionId: row.active_version_id,
    enabled: row.enabled,
    nextFireAt: row.enabled && row.next_fire_at !== null
      ? toIso(row.next_fire_at)
      : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

function jsonValue(value: unknown, what: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new Error(`${what}_INVALID`);
  }
}

export function toAutomationVersion(row: VersionRow) {
  return {
    id: row.id,
    automationId: row.automation_id,
    revision: row.revision,
    trigger: jsonValue(row.trigger, "AUTOMATION_VERSION_TRIGGER"),
    workflowVersionId: row.workflow_version_id,
    actorId: row.actor_id,
    inputs: jsonValue(row.inputs, "AUTOMATION_VERSION_INPUTS"),
    misfirePolicy: row.misfire_policy as "coalesce" | "skip",
    overlapPolicy: row.overlap_policy as "skip" | "queue_one",
    digest: row.digest,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toAutomationFiring(row: FiringRow) {
  return {
    id: row.id,
    automationVersionId: row.automation_version_id,
    scheduledAt: toIso(row.scheduled_at),
    triggerEventId: row.trigger_event_id,
    status: row.status as "queued" | "skipped" | "started" | "failed",
    runId: row.run_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
    pending: row.pending,
    skippedCount: row.skipped_count,
  };
}

async function boundedMutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    const code = postgresErrorCode(error);
    if (code === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "STATE_CONFLICT", cause: error });
    }
    if (["22001", "22P02", "23502", "23503"].includes(code ?? "")) {
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    }
    throw error;
  }
}

/** Audit and event facts carry ids and versions only, never definition text. */
async function appendFacts(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    eventType: string;
    resourceVersion: number;
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: options.organizationId,
    principalId: options.principalId,
    operation: options.operation,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    requestId: options.requestId,
    traceId: options.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId: options.organizationId,
    eventType: options.eventType,
    aggregateId: options.resourceId,
    aggregateVersion: options.resourceVersion,
    payload: {
      resourceId: options.resourceId,
      resourceVersion: options.resourceVersion,
    },
    traceId: options.traceId,
  });
}

/** The first scheduled occurrence strictly after `now` for a trigger, or null for an event trigger or a schedule that never fires. */
export function firstFireAfter(
  trigger: AutomationTrigger,
  now: Date,
): Date | null {
  if (trigger.type !== "schedule") return null;
  return nextOccurrence(parseCron(trigger.cron), trigger.timezone, now);
}

function requireAutomationId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

async function requireAutomationVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  automationId: string,
): Promise<void> {
  const parent = await transaction.query(
    "select 1 from bakery.automation_definitions where organization_id = $1 and id = $2",
    [organizationId, automationId],
  );
  if (parent.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export function createAutomationsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "automations.list",
      principalId,
      organizationId,
      ordering: DEFINITIONS_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      DefinitionRow & { cursor_created_at: string }
    >(
      `select ${DEFINITION_COLUMNS},
          to_char(created_at at time zone 'UTC', ${TIMESTAMP}) as cursor_created_at
         from bakery.automation_definitions
        where organization_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toAutomation),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getAutomation(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const automationId = requireAutomationId(context);
  const result = await transaction.query<DefinitionRow>(
    `select ${DEFINITION_COLUMNS}
       from bakery.automation_definitions
      where organization_id = $1 and id = $2`,
    [organizationId, automationId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toAutomation(row);
}

export async function createAutomation(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as CreateInput;
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<DefinitionRow>(
      `insert into bakery.automation_definitions (
         id, organization_id, slug, name, description
       ) values ($1, $2, $3, $4, $5)
       returning ${DEFINITION_COLUMNS}`,
      [id, organizationId, value.slug, value.name, value.description],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("AUTOMATION_DEFINITION_INSERT_FAILED");
  await appendFacts(transaction, {
    organizationId,
    principalId,
    operation: "automations.create",
    resourceType: "automation_definition",
    resourceId: id,
    eventType: "automations.created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAutomation(row);
}

type LockedDefinition = {
  enabled: boolean;
  active_version_id: string | null;
  next_fire_at: Date | string | null;
};

export async function updateAutomation(context: ActionContext, input: unknown) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as UpdateInput;
  const automationId = requireAutomationId(context);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  // An update that changes nothing is refused, not recorded as a change.
  if (
    value.name === undefined && value.enabled === undefined &&
    value.activeVersionId === undefined
  ) {
    throw unprocessable(["body"], "no_changes");
  }
  const locked = await transaction.query<LockedDefinition>(
    `select enabled, active_version_id, next_fire_at
       from bakery.automation_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, automationId],
  );
  const current = locked.rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  const enabled = value.enabled ?? current.enabled;
  const activeVersionId = value.activeVersionId === undefined
    ? current.active_version_id
    : value.activeVersionId;
  const versionChanged = activeVersionId !== current.active_version_id;
  let trigger: AutomationTrigger | null = null;
  if (activeVersionId !== null) {
    const found = await transaction.query<{ trigger: unknown }>(
      `select trigger from bakery.automation_versions
        where organization_id = $1 and automation_id = $2 and id = $3`,
      [organizationId, automationId, activeVersionId],
    );
    const version = found.rows[0];
    if (!version) {
      // Only a version of this automation can be its active one.
      throw unprocessable(["activeVersionId"], "version_not_found");
    }
    trigger = parseTrigger(version.trigger);
  }

  // The schedule cursor follows the active version and the enabled state. A new
  // active version starts a new schedule from now; a disabled automation keeps
  // its cursor (re-enabling applies the misfire policy to what was missed);
  // enabling one that has no cursor yet starts it from now.
  let nextFireAt: Date | null;
  if (versionChanged) {
    nextFireAt = trigger === null ? null : firstFireAfter(trigger, new Date());
  } else if (current.next_fire_at !== null) {
    nextFireAt = new Date(current.next_fire_at);
  } else if (trigger !== null && enabled) {
    nextFireAt = firstFireAfter(trigger, new Date());
  } else {
    nextFireAt = null;
  }

  const updated = await boundedMutation(() =>
    transaction.query<DefinitionRow>(
      `update bakery.automation_definitions
          set name = case when $4::boolean then $5 else name end,
              enabled = $6,
              active_version_id = $7,
              next_fire_at = $8,
              updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${DEFINITION_COLUMNS}`,
      [
        organizationId,
        automationId,
        expectedVersion,
        value.name !== undefined,
        value.name ?? null,
        enabled,
        activeVersionId,
        nextFireAt?.toISOString() ?? null,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await appendFacts(transaction, {
    organizationId,
    principalId,
    operation: "automations.update",
    resourceType: "automation_definition",
    resourceId: automationId,
    eventType: "automations.updated",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAutomation(row);
}

const VERSION_COLUMNS =
  "id, automation_id, revision, trigger, workflow_version_id, actor_id, inputs, misfire_policy, overlap_policy, digest, created_at, updated_at, version";

export function createAutomationVersionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const automationId = requireAutomationId(context);
    await requireAutomationVisible(transaction, organizationId, automationId);
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "automationVersions.list",
      principalId,
      organizationId,
      ordering: VERSIONS_ORDERING,
      filters: JSON.stringify({ automationId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<VersionRow>(
      `select ${VERSION_COLUMNS}
         from bakery.automation_versions
        where organization_id = $1 and automation_id = $2
          and ($3::integer is null or (revision, id) < ($3, $4::uuid))
        order by revision desc, id desc
        limit $5`,
      [
        organizationId,
        automationId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toAutomationVersion),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: last.revision,
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}

export async function createAutomationVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as VersionCreateInput;
  const automationId = requireAutomationId(context);
  let trigger: AutomationTrigger;
  try {
    trigger = parseTrigger(value.trigger);
  } catch (error) {
    if (error instanceof TriggerError) {
      throw unprocessable(["trigger", ...error.path], error.reason, error);
    }
    throw error;
  }
  // Serialize versions of one automation: the revision is the next one.
  const locked = await transaction.query(
    `select 1 from bakery.automation_definitions
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, automationId],
  );
  if (locked.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const workflow = await transaction.query<{ status: string }>(
    `select status from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [organizationId, value.workflowVersionId],
  );
  const pinned = workflow.rows[0];
  if (!pinned) {
    throw unprocessable(["workflowVersionId"], "workflow_version_not_found");
  }
  if (pinned.status !== "published") {
    throw unprocessable(
      ["workflowVersionId"],
      "workflow_version_not_published",
    );
  }
  const highest = await transaction.query<{ revision: number | null }>(
    `select max(revision) as revision from bakery.automation_versions
      where organization_id = $1 and automation_id = $2`,
    [organizationId, automationId],
  );
  const revision = Number(highest.rows[0]?.revision ?? 0) + 1;
  const digest = await sha256Hex(canonicalJson({
    trigger,
    workflowVersionId: value.workflowVersionId,
    inputs: value.inputs,
    misfirePolicy: value.misfirePolicy,
    overlapPolicy: value.overlapPolicy,
  }));
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<VersionRow>(
      `insert into bakery.automation_versions (
         id, organization_id, automation_id, revision, trigger,
         workflow_version_id, actor_id, inputs, misfire_policy,
         overlap_policy, digest
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11)
       returning ${VERSION_COLUMNS}`,
      [
        id,
        organizationId,
        automationId,
        revision,
        JSON.stringify(trigger),
        value.workflowVersionId,
        principalId,
        JSON.stringify(value.inputs),
        value.misfirePolicy,
        value.overlapPolicy,
        digest,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("AUTOMATION_VERSION_INSERT_FAILED");
  await appendFacts(transaction, {
    organizationId,
    principalId,
    operation: "automationVersions.create",
    resourceType: "automation_version",
    resourceId: id,
    eventType: "automation.version_created",
    resourceVersion: row.version,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return toAutomationVersion(row);
}

const FIRING_COLUMNS =
  `f.id, f.automation_version_id, f.scheduled_at, f.trigger_event_id, f.status,
   f.pending, f.skipped_count, f.run_id, f.created_at, f.updated_at, f.version`;

export function createAutomationFiringsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const automationId = requireAutomationId(context);
    await requireAutomationVisible(transaction, organizationId, automationId);
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "automationFirings.list",
      principalId,
      organizationId,
      ordering: FIRINGS_ORDERING,
      filters: JSON.stringify({ automationId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      FiringRow & { cursor_scheduled_at: string }
    >(
      `select ${FIRING_COLUMNS},
          to_char(f.scheduled_at at time zone 'UTC', ${TIMESTAMP}) as cursor_scheduled_at
         from bakery.automation_firings f
         join bakery.automation_versions v
           on v.organization_id = f.organization_id
          and v.id = f.automation_version_id
        where f.organization_id = $1 and v.automation_id = $2
          and ($3::timestamptz is null or (f.scheduled_at, f.id) < ($3, $4::uuid))
        order by f.scheduled_at desc, f.id desc
        limit $5`,
      [
        organizationId,
        automationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toAutomationFiring),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_scheduled_at,
          id: last.id,
        })
        : null,
    };
  };
}
