/**
 * Which starts an event answers, and which of them are live (one engine O8).
 *
 * Matching is exact and small, like an automation's: the same neutral kind and
 * every filter entry strictly equal to the event's field. There is no
 * expression, pattern or nesting, and nothing from a payload.
 *
 * A start is live only through the version in use. The match reads each
 * enabled definition's `active_version_id`, the pointer "Use this version"
 * sets, and never the latest published version or a draft: publishing a version
 * does not switch its starts on, and a version that was replaced stops
 * answering at once. Reading the pointer at match time, not at authoring time,
 * is what makes "Use this version" the one switch.
 */
import {
  type WorkflowStart,
  WorkflowStartsSchema,
} from "@bakery/contracts/workflow-starts";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { NeutralEvent } from "../integrations/neutral-events.ts";

type EventStart = Extract<WorkflowStart["on"], { kind: "event" }>;

/** Whether one event start answers the event: same kind, every filter entry equal. */
export function startMatches(on: EventStart, event: NeutralEvent): boolean {
  if (on.eventKind !== event.kind) return false;
  for (const [key, value] of Object.entries(on.filter)) {
    // Own keys only: a field the event does not carry equals nothing.
    if (!Object.hasOwn(event.fields, key) || event.fields[key] !== value) {
      return false;
    }
  }
  return true;
}

/** A start that answers an event, with the version it would run. */
export type LiveStart = Readonly<{
  workflowId: string;
  versionId: string;
  startId: string;
}>;

/**
 * The live starts of one organization that answer the event, in workflow id
 * then start id order. The kind is narrowed in the database (jsonb
 * containment), and the filter is judged in TypeScript by `startMatches`.
 */
export async function liveStartsFor(
  transaction: PgTransactionClient,
  organizationId: string,
  event: NeutralEvent,
): Promise<LiveStart[]> {
  const rows = await transaction.query<
    { workflow_id: string; version_id: string; starts: unknown }
  >(
    `select definition.id as workflow_id, version.id as version_id,
            version.starts
       from bakery.workflow_definitions definition
       join bakery.workflow_versions version
         on version.organization_id = definition.organization_id
        and version.id = definition.active_version_id
      where definition.organization_id = $1
        and definition.enabled
        and version.starts @> $2::jsonb
      order by definition.id`,
    [
      organizationId,
      JSON.stringify([{ on: { kind: "event", eventKind: event.kind } }]),
    ],
  );
  const live: LiveStart[] = [];
  for (const row of rows.rows) {
    for (const start of WorkflowStartsSchema.parse(row.starts)) {
      if (start.on.kind === "event" && startMatches(start.on, event)) {
        live.push({
          workflowId: row.workflow_id,
          versionId: row.version_id,
          startId: start.id,
        });
      }
    }
  }
  return live.sort((a, b) =>
    a.workflowId === b.workflowId
      ? a.startId.localeCompare(b.startId)
      : a.workflowId.localeCompare(b.workflowId)
  );
}
