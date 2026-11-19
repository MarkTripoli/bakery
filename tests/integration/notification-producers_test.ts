import { assertEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import { appendDomainEvent } from "@bakery/persistence";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { registerNotificationProjection } from "../../apps/server/src/modules/work/notification-projection.ts";
import { resolveNotificationTarget } from "../../apps/server/src/modules/work/notifications-target.ts";

/**
 * #455: the inbox's producers. A notification is written in the transaction
 * that appends the domain event it reports, once per recipient and source,
 * only for outcomes that mean something to a person. Real Postgres.
 */

registerNotificationProjection();

type Seeded = { runId: string; stepId: string };

async function seedRun(
  fixture: SocketFixture,
  status: string,
  taskId = fixture.taskId,
): Promise<Seeded> {
  const db = fixture.pgDatabase;
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  await db.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Producers')`,
    [workflowId, fixture.organizationId, `p-${workflowId}`],
  );
  await db.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id,
       revision, source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: p', '{"name":"p"}', $4, 'published', $5)`,
    [
      versionId,
      fixture.organizationId,
      workflowId,
      `p-${versionId}`,
      fixture.principalId,
    ],
  );
  await db.query(
    `insert into bakery.workflow_runs (id, organization_id, task_id,
       workflow_version_id, requested_by, status, snapshot, budget_limit_usd)
     values ($1, $2, $3, $4, $5, $6, '{"name":"p"}', 0)`,
    [
      runId,
      fixture.organizationId,
      taskId,
      versionId,
      fixture.principalId,
      status,
    ],
  );
  await db.query(
    `insert into bakery.run_steps (id, organization_id, run_id, step_key,
       position, iteration, status, input)
     values ($1, $2, $3, 'build', 1, 0, 'failed', '{}')`,
    [stepId, fixture.organizationId, runId],
  );
  return { runId, stepId };
}

function emit(
  fixture: SocketFixture,
  eventType: string,
  payload: Record<string, unknown>,
  aggregateId = crypto.randomUUID(),
  aggregateVersion = 1,
) {
  return withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      appendDomainEvent(transaction, {
        organizationId: fixture.organizationId,
        taskId: fixture.taskId,
        eventType,
        aggregateId,
        aggregateVersion,
        payload,
        traceId: crypto.randomUUID().replaceAll("-", ""),
      }),
  );
}

async function rows(fixture: SocketFixture, kind: string) {
  return (await fixture.pgDatabase.query<
    {
      target_kind: string;
      target_id: string;
      target_anchor: string | null;
      run_id: string | null;
      recipient_id: string;
    }
  >(
    `select target_kind, target_id, target_anchor, run_id, recipient_id
       from bakery.notifications
      where organization_id = $1 and kind = $2`,
    [fixture.organizationId, kind],
  )).rows;
}

Deno.test("a failed step tells the task's initiator once, on that step", async () => {
  const fixture = await openSocketFixture();
  try {
    const { runId, stepId } = await seedRun(fixture, "running");
    const payload = (status: string) => ({
      runId,
      stepId,
      jobId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      status,
    });
    await emit(fixture, "job.completed", payload("completed"));
    await emit(fixture, "job.completed", payload("canceled"));
    assertEquals((await rows(fixture, "step_failed")).length, 0);

    const aggregateId = crypto.randomUUID();
    await emit(fixture, "job.completed", payload("failed"), aggregateId);
    const [row, ...rest] = await rows(fixture, "step_failed");
    assertEquals(rest.length, 0);
    assertEquals(row.recipient_id, fixture.principalId);
    assertEquals(row.target_kind, "run_step");
    assertEquals(row.target_id, stepId);
    assertEquals(row.target_anchor, `step:${stepId}`);
    assertEquals(row.run_id, runId);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a run's outcome is announced once, only when completed or failed", async () => {
  const fixture = await openSocketFixture();
  try {
    const running = await seedRun(fixture, "running");
    const blocked = await seedRun(fixture, "blocked");
    const canceled = await seedRun(fixture, "canceled");
    for (const run of [running, blocked, canceled]) {
      await emit(fixture, "run.updated", { runId: run.runId, version: 1 });
    }
    assertEquals((await rows(fixture, "run_completed")).length, 0);
    assertEquals((await rows(fixture, "run_failed")).length, 0);

    const done = await seedRun(fixture, "completed");
    await emit(fixture, "run.updated", { runId: done.runId, version: 2 });
    // A second event naming the same run is not a second outcome.
    await emit(fixture, "run.updated", { runId: done.runId, version: 3 });
    assertEquals((await rows(fixture, "run_completed")).length, 1);

    const failed = await seedRun(fixture, "failed");
    await emit(fixture, "run.updated", { runId: failed.runId, version: 2 });
    const [row] = await rows(fixture, "run_failed");
    assertEquals(row.target_kind, "run");
    assertEquals(row.target_anchor, `step:${failed.stepId}`);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a child task's run is not the task's outcome", async () => {
  const fixture = await openSocketFixture();
  try {
    const child = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, conversation_id, title,
         task_type, status, priority, created_by, parent_task_id
       ) select $1, organization_id, application_id, conversation_id, 'child',
                task_type, status, priority, created_by, id
           from bakery.tasks where id = $2`,
      [child, fixture.taskId],
    );
    const run = await seedRun(fixture, "completed", child);
    await emit(fixture, "run.updated", { runId: run.runId, version: 2 });
    assertEquals((await rows(fixture, "run_completed")).length, 0);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("the resolver names the part that is gone and the document's address", async () => {
  const fixture = await openSocketFixture();
  try {
    const { runId, stepId } = await seedRun(fixture, "running");
    await emit(fixture, "job.completed", {
      runId,
      stepId,
      jobId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      status: "failed",
    });
    const read = async () =>
      (await fixture.pgDatabase.query(
        `select id, target_kind as "targetKind", target_id as "targetId",
                target_anchor as "targetAnchor", task_id as "taskId",
                run_id as "runId"
           from bakery.notifications
          where organization_id = $1 and kind = 'step_failed'`,
        [fixture.organizationId],
      )).rows[0];
    const resolve = (row: unknown) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          resolveNotificationTarget(
            transaction,
            {
              organizationId: fixture.organizationId,
              recipientId: fixture.principalId,
            },
            // deno-lint-ignore no-explicit-any
            row as any,
          ),
      );
    const before = await resolve(await read());
    assertEquals(before.status, "available");
    assertEquals(before.path, `/tasks/${fixture.taskId}`);
    assertEquals(before.anchor, `step:${stepId}`);

    await fixture.pgDatabase.query(
      `delete from bakery.run_steps where id = $1`,
      [stepId],
    );
    const after = await resolve(await read());
    assertEquals(after.status, "part_unavailable");
    assertEquals(after.path, `/tasks/${fixture.taskId}`);
    assertEquals(after.anchor, null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a question or approval reaches its named audience, and only as its own kind", async () => {
  const fixture = await openSocketFixture();
  try {
    const open = async (kind: string, audience: unknown) => {
      const id = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.questions (
           id, organization_id, kind, conversation_id, task_id, generation,
           prompt, audience
         ) values ($1, $2, $3, $4, $5, 1, 'Ship it?', $6::jsonb)`,
        [
          id,
          fixture.organizationId,
          kind,
          fixture.conversationId,
          fixture.taskId,
          JSON.stringify(audience),
        ],
      );
      return id;
    };
    // Nobody is named: it goes to the person who started the task.
    const asked = await open("question", { type: "task_participants" });
    await emit(fixture, "question.opened", {
      questionId: asked,
      conversationId: fixture.conversationId,
    });
    const [question] = await rows(fixture, "question_asked");
    assertEquals(question.target_kind, "question");
    assertEquals(question.target_anchor, `question:${asked}`);
    assertEquals(question.recipient_id, fixture.principalId);

    // An approval is a question of kind 'approval'; announcing it through the
    // question event would label it wrongly, so it is not announced there.
    const approval = await open("approval", {
      type: "principals",
      principalIds: [fixture.principalId],
    });
    await emit(fixture, "question.opened", {
      questionId: approval,
      conversationId: fixture.conversationId,
    });
    assertEquals((await rows(fixture, "question_asked")).length, 1);
    await emit(fixture, "approval.requested", {
      resourceId: approval,
      resourceVersion: 1,
    });
    const [granted] = await rows(fixture, "approval_requested");
    assertEquals(granted.target_anchor, `approval:${approval}`);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a document's new version and comments reach the initiator, never their author, and open the document", async () => {
  const fixture = await openSocketFixture();
  try {
    const db = fixture.pgDatabase;
    const other = crypto.randomUUID();
    await db.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Author', 'service')`,
      [other],
    );
    const artifactId = crypto.randomUUID();
    await db.query(
      `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
       values ($1, $2, $3, 'plan', 'The plan')`,
      [artifactId, fixture.organizationId, fixture.taskId],
    );
    const content = new TextEncoder().encode("v1");
    const version = async (author: string, revision: number) => {
      const id = crypto.randomUUID();
      await db.query(
        `insert into bakery.artifact_versions (id, organization_id, artifact_id,
           task_id, author_id, revision, content, sha256, size_bytes, media_type)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'text/plain')`,
        [
          id,
          fixture.organizationId,
          artifactId,
          fixture.taskId,
          author,
          revision,
          content,
          `sha-${id}`,
          content.length,
        ],
      );
      return id;
    };
    const mine = await version(fixture.principalId, 1);
    await emit(fixture, "artifact.version_created", {
      resourceId: mine,
      resourceVersion: 1,
    });
    assertEquals((await rows(fixture, "document_version")).length, 0);

    const theirs = await version(other, 2);
    await emit(fixture, "artifact.version_created", {
      resourceId: theirs,
      resourceVersion: 1,
    });
    const [row] = await rows(fixture, "document_version");
    assertEquals(row.recipient_id, fixture.principalId);
    assertEquals(row.target_anchor, "version:2");

    const commentId = crypto.randomUUID();
    await db.query(
      `insert into bakery.artifact_comments (id, organization_id,
         artifact_version_id, author_id, body)
       values ($1, $2, $3, $4, 'Looks off')`,
      [commentId, fixture.organizationId, theirs, other],
    );
    await emit(fixture, "artifact.comment_created", {
      resourceId: commentId,
      resourceVersion: 1,
      artifactId,
      artifactVersionId: theirs,
      rootId: commentId,
      rootVersion: 1,
    });
    const [comment] = await rows(fixture, "comment");
    assertEquals(comment.recipient_id, fixture.principalId);
    assertEquals((await rows(fixture, "comment")).length, 1);

    const target = (row: { target_kind: string; target_id: string }) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          resolveNotificationTarget(
            transaction,
            {
              organizationId: fixture.organizationId,
              recipientId: fixture.principalId,
            },
            {
              targetKind: row.target_kind,
              targetId: row.target_id,
              targetAnchor: null,
              taskId: fixture.taskId,
              runId: null,
            },
          ),
      );
    const forVersion = await target(row);
    assertEquals(
      forVersion.path,
      `/tasks/${fixture.taskId}/artifacts/${artifactId}`,
    );
    assertEquals(forVersion.anchor, "version:2");
    const forComment = await target(comment);
    assertEquals(
      forComment.path,
      `/tasks/${fixture.taskId}/artifacts/${artifactId}`,
    );
    assertEquals(forComment.anchor, `comment:${commentId}`);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [fixture.organizationId],
    );
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("two events racing to announce one run write one notification", async () => {
  const fixture = await openSocketFixture();
  try {
    const run = await seedRun(fixture, "completed");
    await Promise.all([
      emit(fixture, "run.updated", { runId: run.runId, version: 2 }),
      emit(fixture, "run.updated", { runId: run.runId, version: 3 }),
      emit(fixture, "run.updated", { runId: run.runId, version: 4 }),
    ]);
    assertEquals((await rows(fixture, "run_completed")).length, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a step is announced on its final failure only, and once", async () => {
  const fixture = await openSocketFixture();
  try {
    const { runId, stepId } = await seedRun(fixture, "running");
    const failed = (id: string) =>
      emit(fixture, "job.completed", {
        runId,
        stepId: id,
        jobId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        status: "failed",
      });
    // A later iteration of the same step exists: this failure is being retried.
    const retryId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.run_steps (id, organization_id, run_id, step_key,
         position, iteration, status, input)
       values ($1, $2, $3, 'build', 1, 1, 'running', '{}')`,
      [retryId, fixture.organizationId, runId],
    );
    await failed(stepId);
    assertEquals((await rows(fixture, "step_failed")).length, 0);

    // The retry fails too: that is the final failure, announced once even if
    // the event is delivered twice.
    await failed(retryId);
    await failed(retryId);
    const announced = await rows(fixture, "step_failed");
    assertEquals(announced.length, 1);
    assertEquals(announced[0].target_id, retryId);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("a data case the projection cannot serve is skipped with a recorded reason, never thrown", async () => {
  const fixture = await openSocketFixture();
  try {
    const skipped = async () =>
      (await fixture.pgDatabase.query<{ reason: string; event: string }>(
        `select details ->> 'reason' as reason, details ->> 'eventType' as event
           from bakery.audit_events
          where organization_id = $1 and operation = 'notifications.skipped'
          order by id`,
        [fixture.organizationId],
      )).rows.map((row) => `${row.event}:${row.reason}`);
    const gone = () => crypto.randomUUID();

    // The run is gone.
    await emit(fixture, "job.completed", {
      runId: gone(),
      stepId: gone(),
      jobId: gone(),
      attemptId: gone(),
      status: "failed",
    });
    await emit(fixture, "run.updated", { runId: gone(), version: 2 });
    // The thing the event names is gone.
    await emit(fixture, "question.opened", {
      questionId: gone(),
      conversationId: fixture.conversationId,
    });
    await emit(fixture, "approval.requested", {
      resourceId: gone(),
      resourceVersion: 1,
    });
    await emit(fixture, "artifact.version_created", {
      resourceId: gone(),
      resourceVersion: 1,
    });
    await emit(fixture, "artifact.comment_created", {
      resourceId: gone(),
      resourceVersion: 1,
      artifactId: gone(),
      artifactVersionId: gone(),
      rootId: gone(),
      rootVersion: 1,
    });
    // Nobody to tell: the task was started by a service, which has no inbox.
    const service = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Service', 'service')`,
      [service],
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks set created_by = $2 where id = $1`,
      [fixture.taskId, service],
    );
    const run = await seedRun(fixture, "failed");
    await emit(fixture, "run.updated", { runId: run.runId, version: 2 });

    assertEquals(
      (await skipped()).sort(),
      [
        "job.completed:run_gone",
        "run.updated:run_gone",
        "question.opened:target_gone",
        "approval.requested:target_gone",
        "artifact.version_created:target_gone",
        "artifact.comment_created:target_gone",
        "run.updated:no_recipient",
      ].sort(),
    );
    const total = await fixture.pgDatabase.query(
      `select 1 from bakery.notifications where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(total.rows.length, 0);
  } finally {
    await fixture.pgDatabase.query(
      `update bakery.tasks set created_by = $2 where id = $1`,
      [fixture.taskId, fixture.principalId],
    );
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});
