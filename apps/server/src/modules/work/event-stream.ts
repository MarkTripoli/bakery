import { z } from "zod";
import {
  contractSchemas,
  type JsonValue,
  type OrganizationId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { OrganizationActor } from "../auth/application/authority.ts";
import {
  authorize,
  isOrganizationMember,
} from "../auth/application/authorize.ts";

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
  // Every remembered-fact change of the organization, as content-free
  // invalidation signals. The id is the organization itself (assertScope) and
  // only someone who may read memory may subscribe (assertScopeAccess). Its
  // events reach it by their type, not by a column: see MEMORY_EVENT_TYPES.
  memory: Object.freeze({
    eventColumn: "organization_id",
    taskColumn: "id",
    assertQuery: `select 1 where $1::uuid = $2::uuid`,
  }),
  // One person's inbox signal. The id is a principal and only that principal
  // may subscribe to it (assertScope); it carries no task state to snapshot.
  inbox: Object.freeze({
    eventColumn: "recipient_id",
    taskColumn: "id",
    assertQuery: `select 1 from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2
          and status = 'active'`,
  }),
});

/**
 * The signals of remembered facts (#72). They are kept out of every other
 * scope, whatever columns they carry, and delivered only through the `memory`
 * scope, so a reader of a repository's or task's activity learns nothing of
 * them unless they may read memory.
 */
export const MEMORY_EVENT_TYPES: readonly string[] = Object.freeze([
  "memories.created",
  "memories.updated",
  "memory.revised",
  "memory.source_changed",
]);

/**
 * Who may read the events stream for these scopes. `event:read` opens every
 * scope except `memory` (each still checked by assertScope). Without it, a
 * current human member with a system role may still connect, but only to
 * subscribe to their own inbox (and, holding `memory:read`, to the memory
 * signals): it returns false, and the caller then refuses every other scope
 * with assertScopeAccess, so these exceptions never widen into application,
 * task or conversation activity.
 */
export function assertEventAccess(
  actor: OrganizationActor,
): boolean {
  try {
    authorize(actor, "event:read", { action: "events.connect" });
    return true;
  } catch (denied) {
    if (!isOrganizationMember(actor)) throw denied;
    return false;
  }
}

/** What one connected member may subscribe to, read fresh from their current roles. */
export type ScopeAccess = {
  /** `event:read`: every scope but memory. */
  readonly fullAccess: boolean;
  /** `memory:read`: the memory scope, with or without `event:read`. */
  readonly memoryRead: boolean;
};

/** Reads both permissions once; a caller who is not a member is refused outright. */
export function readScopeAccess(actor: OrganizationActor): ScopeAccess {
  const fullAccess = assertEventAccess(actor);
  try {
    authorize(actor, "memory:read", { action: "events.connect" });
    return { fullAccess, memoryRead: true };
  } catch (denied) {
    if (!isOrganizationMember(actor)) throw denied;
    return { fullAccess, memoryRead: false };
  }
}

/**
 * The scope check for a subscriber. An inbox is open to any member (assertScope
 * then requires it to be their own); the memory scope needs `memory:read`
 * whatever else they hold; every other scope needs `event:read`. A refusal
 * answers exactly like a scope that does not exist.
 */
export function assertScopeAccess(
  access: ScopeAccess,
  scope: SyncScope,
): void {
  if (scope.type === "inbox") return;
  const allowed = scope.type === "memory"
    ? access.memoryRead
    : access.fullAccess;
  if (!allowed) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

/**
 * Confirms the scope exists in this organization. An inbox scope is personal:
 * it is accepted only for the subscriber's own principal id, so naming another
 * person's inbox answers exactly like a scope that does not exist. Callers
 * without a subscriber (snapshots) cannot use it at all.
 */
export async function assertScope(
  transaction: PgTransactionClient,
  organizationId: OrganizationId,
  scope: SyncScope,
  subscriberId?: string,
): Promise<void> {
  if (
    scope.type === "inbox" &&
    (subscriberId === undefined ||
      scope.id.toLowerCase() !== subscriberId.toLowerCase())
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // The memory scope is the organization's own: its id is the organization.
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
    inbox: [],
    memory: [],
  };
  for (const scope of scopes) idsByType[scope.type].push(scope.id);
  // Memory signals travel only through the memory scope.
  const memoryTypes = idsByType.memory.length > 0 ? MEMORY_EVENT_TYPES : [];
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
           (
             (
               application_id = any($2::uuid[])
               or repository_id = any($5::uuid[])
               or task_id = any($6::uuid[])
               or conversation_id = any($7::uuid[])
               or worker_enrollment_id = any($8::uuid[])
               or worker_host_id = any($9::uuid[])
               or recipient_id = any($11::uuid[])
             )
             and event_type <> all($12::text[])
           )
           or event_type = any($13::text[])
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
      idsByType.inbox,
      MEMORY_EVENT_TYPES,
      memoryTypes,
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
