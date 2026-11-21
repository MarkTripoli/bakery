import {
  appendAudit,
  type DomainEventFacts,
  type PgTransactionClient,
  registerDomainEventProjection,
} from "@bakery/persistence";
import { signalInboxChanged } from "./notification-signal.ts";

/**
 * The inbox's producer (chapter 24, issue #455).
 *
 * The inbox is a projection of committed domain events: this runs in the
 * transaction that appends the event, so a notification and the fact it reports
 * commit or roll back together, and a replayed or duplicated event writes the
 * same row twice, which the unique dedupe key turns into a no-op. Nothing here
 * reads an assistant's prose or a child agent's completion: a task's outcome is
 * the terminal state of its run, and only a top-level task's run counts.
 *
 * A row stores a typed reference (kind, target, the run and task it belongs to,
 * and an anchor naming the inner part), never a copy of the destination. The
 * target resolver reauthorizes the reader when the item is opened, so a row can
 * go stale or unreachable without leaking anything.
 *
 * Recipients are people, never services: the initiating human of the task, the
 * named audience of a question or approval, and, for a comment, the people who
 * already took part in that document.
 */

type Kind =
  | "run_completed"
  | "run_failed"
  | "step_failed"
  | "approval_requested"
  | "question_asked"
  | "document_version"
  | "comment";

type TargetKind =
  | "run"
  | "run_step"
  | "approval"
  | "question"
  | "document_version"
  | "comment";

type Draft = Readonly<{
  recipientId: string;
  kind: Kind;
  targetKind: TargetKind;
  targetId: string;
  /** Names the inner part the address should land on, `kind:id` form. */
  anchor: string | null;
  taskId: string | null;
  runId: string | null;
  conversationId: string | null;
  actorId: string | null;
}>;

/**
 * A data case the projection cannot write a row for: the thing the event names
 * is gone, or nobody is to be told. It never throws, so only a real bug can
 * roll back the domain write it rides on. The reason is recorded in the audit
 * trail, where an operator can find why a person was not told.
 */
async function skip(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
  reason: string,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: event.organizationId,
    principalId: null,
    operation: "notifications.skipped",
    resourceType: "domain_event",
    resourceId: event.eventId,
    requestId: crypto.randomUUID(),
    traceId: event.traceId,
    details: { reason, eventType: event.eventType },
  });
}

/** Principals that may be told something: active human members of the organization. */
async function activeHumans(
  transaction: PgTransactionClient,
  organizationId: string,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const found = await transaction.query<{ id: string }>(
    `select distinct principal.id
       from bakery.principals as principal
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
      where membership.organization_id = $1
        and membership.status = 'active'
        and principal.principal_type = 'human'
        and principal.disabled_at is null
        and principal.id = any($2::uuid[])`,
    [organizationId, [...new Set(candidates)]],
  );
  return found.rows.map((row) => row.id);
}

/** The person who started the work, when a person did. A service has no inbox. */
async function initiatingHuman(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<string[]> {
  const task = await transaction.query<{ createdBy: string }>(
    `select created_by as "createdBy" from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, taskId],
  );
  const creator = task.rows[0]?.createdBy;
  return creator === undefined
    ? []
    : await activeHumans(transaction, organizationId, [creator]);
}

/** Whether the task is top level: a child task's outcome is not the work's. */
async function isTopLevelTask(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<boolean> {
  const task = await transaction.query<{ parentTaskId: string | null }>(
    `select parent_task_id as "parentTaskId" from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, taskId],
  );
  return task.rows.length === 1 && task.rows[0].parentTaskId === null;
}

async function write(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
  drafts: readonly Draft[],
): Promise<void> {
  const changed = new Set<string>();
  if (drafts.length === 0) await skip(transaction, event, "no_recipient");
  for (const draft of drafts) {
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.notifications (
         organization_id, recipient_id, kind, target_kind, target_id,
         target_anchor, conversation_id, run_id, task_id, actor_id,
         source_event_id, source_version
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict do nothing
       returning id`,
      [
        event.organizationId,
        draft.recipientId,
        draft.kind,
        draft.targetKind,
        draft.targetId,
        draft.anchor,
        draft.conversationId,
        draft.runId,
        draft.taskId,
        draft.actorId,
        event.eventId,
        event.aggregateVersion,
      ],
    );
    if (inserted.rows.length === 1) changed.add(draft.recipientId);
  }
  // One signal per inbox that changed, so an open browser re-reads its count.
  for (const recipientId of changed) {
    await signalInboxChanged(transaction, {
      organizationId: event.organizationId,
      recipientId,
      traceId: event.traceId,
    });
  }
}

/** A step ended in failure: tell the person who started the task, on that step. */
async function stepFailed(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
): Promise<void> {
  const payload = event.payload as {
    runId: string;
    stepId: string;
    status: string;
  };
  if (payload.status !== "failed") return;
  const run = await transaction.query<{ taskId: string }>(
    `select task_id as "taskId" from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [event.organizationId, payload.runId],
  );
  const taskId = run.rows[0]?.taskId;
  if (taskId === undefined) return await skip(transaction, event, "run_gone");
  if (!(await isTopLevelTask(transaction, event.organizationId, taskId))) {
    return;
  }
  // One notification per step, on its final failure: a failed attempt that has
  // a later iteration of the same step is being retried, which is not news.
  const retried = await transaction.query(
    `select 1 from bakery.run_steps as step
       join bakery.run_steps as later
         on later.organization_id = step.organization_id
        and later.run_id = step.run_id and later.step_key = step.step_key
        and later.iteration > step.iteration
      where step.organization_id = $1 and step.id = $2
      limit 1`,
    [event.organizationId, payload.stepId],
  );
  if (retried.rows.length > 0) return;
  const recipients = await initiatingHuman(
    transaction,
    event.organizationId,
    taskId,
  );
  await write(
    transaction,
    event,
    recipients.map((recipientId) => ({
      recipientId,
      kind: "step_failed",
      targetKind: "run_step",
      targetId: payload.stepId,
      anchor: `step:${payload.stepId}`,
      taskId,
      runId: payload.runId,
      conversationId: null,
      actorId: null,
    })),
  );
}

/** A run reached a terminal state: completed or failed, once per run. */
async function runTerminal(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
): Promise<void> {
  const payload = event.payload as { runId: string };
  const run = await transaction.query<{ taskId: string; status: string }>(
    `select task_id as "taskId", status from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [event.organizationId, payload.runId],
  );
  const row = run.rows[0];
  if (row === undefined) return await skip(transaction, event, "run_gone");
  // Blocked and canceled are not outcomes to announce: a blocked run is already
  // waiting on a question or an approval, and a person canceled the other.
  const kind: Kind | null = row.status === "completed"
    ? "run_completed"
    : row.status === "failed"
    ? "run_failed"
    : null;
  if (kind === null) return;
  if (!(await isTopLevelTask(transaction, event.organizationId, row.taskId))) {
    return;
  }
  const recipients = await initiatingHuman(
    transaction,
    event.organizationId,
    row.taskId,
  );
  // One outcome per recipient per run, enforced by a unique index so two
  // events racing to announce the same run cannot both write.
  // Where it lands: the failed step on a failure, the last step that had a
  // session on a success.
  const step = await transaction.query<{ id: string }>(
    kind === "run_failed"
      ? `select id from bakery.run_steps
          where organization_id = $1 and run_id = $2 and status = 'failed'
          order by position asc, iteration asc limit 1`
      : `select step.id from bakery.run_steps as step
          join bakery.agent_sessions as session
            on session.organization_id = step.organization_id
           and session.run_step_id = step.id
          where step.organization_id = $1 and step.run_id = $2
          order by step.position desc, step.iteration desc limit 1`,
    [event.organizationId, payload.runId],
  );
  const stepId = step.rows[0]?.id ?? null;
  await write(
    transaction,
    event,
    recipients.map((recipientId) => ({
      recipientId,
      kind,
      targetKind: "run",
      targetId: payload.runId,
      anchor: stepId === null ? null : `step:${stepId}`,
      taskId: row.taskId,
      runId: payload.runId,
      conversationId: null,
      actorId: null,
    })),
  );
}

type QuestionRow = {
  id: string;
  kind: string;
  taskId: string;
  runId: string | null;
  conversationId: string;
  audience: { type: string; principalIds?: string[] };
};

/** An approval or a question was opened: tell whoever it is addressed to. */
async function questionOpened(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
  questionId: string,
  expectedKind: "approval" | "question",
): Promise<void> {
  const found = await transaction.query<QuestionRow>(
    `select id, kind, task_id as "taskId", run_id as "runId",
            conversation_id as "conversationId", audience
       from bakery.questions
      where organization_id = $1 and id = $2`,
    [event.organizationId, questionId],
  );
  const question = found.rows[0];
  if (question === undefined) {
    return await skip(transaction, event, "target_gone");
  }
  if (question.kind !== expectedKind) return;
  // An explicit audience is who is asked; otherwise the person who started it.
  const named = question.audience.type === "principals"
    ? question.audience.principalIds ?? []
    : [];
  const recipients = named.length > 0
    ? await activeHumans(transaction, event.organizationId, named)
    : await initiatingHuman(transaction, event.organizationId, question.taskId);
  await write(
    transaction,
    event,
    recipients.map((recipientId) => ({
      recipientId,
      kind: expectedKind === "approval"
        ? "approval_requested"
        : "question_asked",
      targetKind: expectedKind,
      targetId: question.id,
      anchor: `${expectedKind}:${question.id}`,
      taskId: question.taskId,
      runId: question.runId,
      conversationId: question.conversationId,
      actorId: null,
    })),
  );
}

/** A new version of a document: tell the person who started the task. */
async function documentVersion(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
): Promise<void> {
  const payload = event.payload as { resourceId: string };
  const version = await transaction.query<
    { id: string; taskId: string; authorId: string; revision: number }
  >(
    `select id, task_id as "taskId", author_id as "authorId", revision
       from bakery.artifact_versions
      where organization_id = $1 and id = $2`,
    [event.organizationId, payload.resourceId],
  );
  const row = version.rows[0];
  if (row === undefined) {
    return await skip(transaction, event, "target_gone");
  }
  const recipients = (await initiatingHuman(
    transaction,
    event.organizationId,
    row.taskId,
  )).filter((id) => id !== row.authorId);
  await write(
    transaction,
    event,
    recipients.map((recipientId) => ({
      recipientId,
      kind: "document_version",
      targetKind: "document_version",
      targetId: row.id,
      anchor: `version:${row.revision}`,
      taskId: row.taskId,
      runId: null,
      conversationId: null,
      actorId: row.authorId,
    })),
  );
}

/** A comment on a document: tell the people already taking part in it. */
async function commentCreated(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
): Promise<void> {
  const payload = event.payload as {
    resourceId: string;
    artifactId: string;
    artifactVersionId: string;
  };
  const comment = await transaction.query<{ authorId: string; taskId: string }>(
    `select comment.author_id as "authorId", version.task_id as "taskId"
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
      where comment.organization_id = $1 and comment.id = $2`,
    [event.organizationId, payload.resourceId],
  );
  const row = comment.rows[0];
  if (row === undefined) {
    return await skip(transaction, event, "target_gone");
  }
  // The task's initiator, and everyone who already commented on this document.
  const prior = await transaction.query<{ authorId: string }>(
    `select distinct comment.author_id as "authorId"
       from bakery.artifact_comments as comment
       join bakery.artifact_versions as version
         on version.organization_id = comment.organization_id
        and version.id = comment.artifact_version_id
      where comment.organization_id = $1 and version.artifact_id = $2
        and comment.deleted_at is null`,
    [event.organizationId, payload.artifactId],
  );
  const initiator = await initiatingHuman(
    transaction,
    event.organizationId,
    row.taskId,
  );
  const recipients = (await activeHumans(transaction, event.organizationId, [
    ...initiator,
    ...prior.rows.map((entry) => entry.authorId),
  ])).filter((id) => id !== row.authorId);
  await write(
    transaction,
    event,
    recipients.map((recipientId) => ({
      recipientId,
      kind: "comment",
      targetKind: "comment",
      targetId: payload.resourceId,
      anchor: `comment:${payload.resourceId}`,
      taskId: row.taskId,
      runId: null,
      conversationId: null,
      actorId: row.authorId,
    })),
  );
}

/**
 * The projection: reads only the event types that mean something to a person,
 * and returns at once for every other. The inbox's own change signal is one of
 * those others, which is what keeps writing a notification from re-entering
 * itself.
 */
export async function projectNotifications(
  transaction: PgTransactionClient,
  event: DomainEventFacts,
): Promise<void> {
  switch (event.eventType) {
    case "job.completed":
      return await stepFailed(transaction, event);
    case "run.updated":
      return await runTerminal(transaction, event);
    case "approval.requested":
      return await questionOpened(
        transaction,
        event,
        (event.payload as { resourceId: string }).resourceId,
        "approval",
      );
    case "question.opened":
      return await questionOpened(
        transaction,
        event,
        (event.payload as { questionId: string }).questionId,
        "question",
      );
    case "artifact.version_created":
      return await documentVersion(transaction, event);
    case "artifact.comment_created":
      return await commentCreated(transaction, event);
    default:
      return;
  }
}

/** Starts the producer for this process. Safe to call more than once. */
export function registerNotificationProjection(): void {
  registerDomainEventProjection(projectNotifications);
}
