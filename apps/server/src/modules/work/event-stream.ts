import { z } from "zod";
import {
  contractSchemas,
  type JsonValue,
  type OrganizationId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";

export type SyncScopeType = z.output<
  typeof contractSchemas.SyncQuery
>["scopeType"];

export type SyncScope = {
  readonly type: SyncScopeType;
  readonly id: z.output<typeof contractSchemas.SyncQuery>["scopeId"];
};

type SyncScopeDefinition = {
  readonly eventColumn: string;
  readonly taskColumn: string;
  readonly assertQuery: string;
};

export const EVENT_SCOPES: Readonly<
  Record<SyncScopeType, SyncScopeDefinition>
> = Object.freeze({
  application: Object.freeze({
    eventColumn: "application_id",
    taskColumn: "application_id",
    assertQuery: `select 1 from bakery.applications
        where organization_id = $1 and id = $2`,
  }),
  repository: Object.freeze({
    eventColumn: "repository_id",
    taskColumn: "repository_id",
    assertQuery: `select 1 from bakery.tasks
        where organization_id = $1 and repository_id = $2
        union all
        select 1 from bakery.conversations
        where organization_id = $1 and repository_id = $2
        union all
        select 1 from bakery.domain_events
        where organization_id = $1 and repository_id = $2
        limit 1`,
  }),
  task: Object.freeze({
    eventColumn: "task_id",
    taskColumn: "id",
    assertQuery: `select 1 from bakery.tasks
        where organization_id = $1 and id = $2`,
  }),
  conversation: Object.freeze({
    eventColumn: "conversation_id",
    taskColumn: "conversation_id",
    assertQuery: `select 1 from bakery.conversations
        where organization_id = $1 and id = $2`,
  }),
  worker_enrollment: Object.freeze({
    eventColumn: "worker_enrollment_id",
    taskColumn: "id",
    assertQuery: `select 1 from bakery.worker_enrollments
        where organization_id = $1 and id = $2`,
  }),
  worker: Object.freeze({
    eventColumn: "worker_host_id",
    taskColumn: "id",
    assertQuery: `select 1 from bakery.worker_hosts
        where organization_id = $1 and id = $2`,
  }),
});

export async function assertScope(
  transaction: PgTransactionClient,
  organizationId: OrganizationId,
  scope: SyncScope,
): Promise<void> {
  const result = await transaction.query(
    EVENT_SCOPES[scope.type].assertQuery,
    [organizationId, scope.id],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export type ClockRow = {
  highwater: string;
  retainedFrom: string;
};

export async function readEventClock(
  transaction: PgTransactionClient,
  organizationId: OrganizationId,
): Promise<ClockRow> {
  const clock = await transaction.query<ClockRow>(
    `select coalesce(clock.next_seq - 1, 0)::text as highwater,
      coalesce(clock.retained_from_seq, 1)::text as "retainedFrom"
     from (values ($1::uuid)) as requested(organization_id)
     left join bakery.event_clock as clock
       on clock.organization_id = requested.organization_id
      and clock.stream = 'domain_events'`,
    [organizationId],
  );
  const current = clock.rows[0];
  if (!current) throw new Error("EVENT_CLOCK_UNAVAILABLE");
  return current;
}

export type EventRow = {
  id: string;
  sequence: string;
  event_type: string;
  schema_version: number;
  occurred_at: Date;
  application_id: string | null;
  repository_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  worker_host_id: string | null;
  worker_enrollment_id: string | null;
  payload: unknown;
};

export async function readScopedEvents(
  transaction: PgTransactionClient,
  organizationId: string,
  scopes: readonly SyncScope[],
  afterSequence: string,
  highwater: string,
  limit: number,
): Promise<EventRow[]> {
  const idsByType: Record<SyncScopeType, string[]> = {
    application: [],
    repository: [],
    task: [],
    conversation: [],
    worker_enrollment: [],
    worker: [],
  };
  for (const scope of scopes) idsByType[scope.type].push(scope.id);
  const events = await transaction.query<EventRow>(
    `select id, organization_sequence::text as sequence, event_type,
        schema_version, created_at as occurred_at, application_id,
        repository_id, task_id, conversation_id, worker_host_id,
        worker_enrollment_id, payload
       from bakery.domain_events
       where organization_id = $1
         and organization_sequence > $3::bigint
         and organization_sequence <= $4::bigint
         and (
           application_id = any($2::uuid[])
           or repository_id = any($5::uuid[])
           or task_id = any($6::uuid[])
           or conversation_id = any($7::uuid[])
           or worker_enrollment_id = any($8::uuid[])
           or worker_host_id = any($9::uuid[])
         )
       order by bakery.domain_events.organization_sequence asc
       limit $10`,
    [
      organizationId,
      idsByType.application,
      afterSequence,
      highwater,
      idsByType.repository,
      idsByType.task,
      idsByType.conversation,
      idsByType.worker_enrollment,
      idsByType.worker,
      limit,
    ],
  );
  return events.rows;
}

export function toEvent(row: EventRow) {
  let payload: JsonValue;
  try {
    payload = JSON.parse(JSON.stringify(row.payload));
  } catch {
    throw new Error("WORK_READ_EVENT_PAYLOAD_INVALID");
  }
  return {
    id: row.id,
    sequence: row.sequence,
    type: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    repositoryId: row.repository_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    workerHostId: row.worker_host_id,
    workerEnrollmentId: row.worker_enrollment_id,
    payload,
  };
}

export function isOutsideRetention(
  sequence: bigint,
  clock: ClockRow,
): boolean {
  return sequence < BigInt(clock.retainedFrom) - 1n ||
    sequence > BigInt(clock.highwater);
}
