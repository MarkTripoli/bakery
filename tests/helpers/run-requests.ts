import { withPgTransaction } from "@bakery/persistence/postgres";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import { authTestOrigin, signSessionCookie } from "./auth.ts";
import type { SocketFixture } from "./events-socket.ts";

/**
 * Shared setup for the run request tests (#456): members with different roles,
 * runs to ask about, and a small HTTP helper. Every member here is an active
 * member of the fixture's organization; a guest holds no permission at all.
 */

/** What the member and request helpers need of a fixture: the socket fixture and the worker fixture both fit. */
export type ApiHost = {
  pgDatabase: SocketFixture["pgDatabase"];
  organizationId: string;
  app: { fetch(request: Request): Response | Promise<Response> };
  config: { auth?: { secret: string } };
};

export type Member = {
  principalId: string;
  cookie: string;
  email: string;
  displayName: string;
};

export async function addMember(
  fixture: ApiHost,
  label: string,
  role: "guest" | "developer" | "viewer" | "admin",
): Promise<Member> {
  const db = fixture.pgDatabase;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `member-${crypto.randomUUID()}`;
  const now = new Date();
  const email = `${label}-${providerUserId}@example.test`;
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, $4, $4)`,
    [providerUserId, label, email, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, $3, 'human')`,
    [principalId, providerUserId, label],
  );
  await db.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, $5, 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, now, role],
  );
  await db.query(
    `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      providerUserId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    principalId,
    email,
    displayName: label,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

export type SeededRun = { runId: string; taskId: string; stepKey: string };

/** A run (and one step) on the given task, started by the fixture's admin. */
export async function seedRun(
  fixture: {
    pgDatabase: SocketFixture["pgDatabase"];
    organizationId: string;
    principalId: string;
    taskId?: string;
  },
  taskId = fixture.taskId,
): Promise<SeededRun> {
  if (taskId === undefined) throw new Error("seedRun needs a task");
  const db = fixture.pgDatabase;
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await db.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Requests')`,
    [workflowId, fixture.organizationId, `r-${workflowId}`],
  );
  await db.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id,
       revision, source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: r', '{"name":"r"}', $4, 'published', $5)`,
    [
      versionId,
      fixture.organizationId,
      workflowId,
      `r-${versionId}`,
      fixture.principalId,
    ],
  );
  await db.query(
    `insert into bakery.workflow_runs (id, organization_id, task_id,
       workflow_version_id, requested_by, status, snapshot, budget_limit_usd)
     values ($1, $2, $3, $4, $5, 'running', '{"name":"r"}', 0)`,
    [runId, fixture.organizationId, taskId, versionId, fixture.principalId],
  );
  await db.query(
    `insert into bakery.run_steps (id, organization_id, run_id, step_key,
       position, iteration, status, input)
     values ($1, $2, $3, 'build', 1, 0, 'running', '{}')`,
    [crypto.randomUUID(), fixture.organizationId, runId],
  );
  return { runId, taskId, stepKey: "build" };
}

/** A second task in the fixture's organization, for "another task" cases. */
export async function seedOtherTask(fixture: SocketFixture): Promise<string> {
  const taskId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title,
       task_type, status, priority, created_by
     ) select $1, organization_id, application_id, conversation_id,
              'Other task', task_type, status, priority, created_by
         from bakery.tasks where id = $2`,
    [taskId, fixture.taskId],
  );
  return taskId;
}

export function api(
  fixture: ApiHost,
  cookie: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  ifMatch?: number,
): Promise<Response> {
  const headers = new Headers({
    cookie,
    "Bakery-Organization-Id": fixture.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  if (ifMatch !== undefined) headers.set("If-Match", `"${ifMatch}"`);
  return Promise.resolve(fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "DELETE" && body === undefined
        ? {}
        : { body: JSON.stringify(body ?? {}) }),
    }),
  ));
}

/**
 * A step approval on the run, private to `approverId` (#456 slice 2a). It is
 * made by the store itself, so the row is whatever a real wait writes.
 */
export async function seedStepApproval(
  fixture: SocketFixture,
  run: SeededRun,
  approverId: string,
  stepKey = "human.approval",
): Promise<string> {
  const asked = await withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      requestHumanApproval(transaction, {
        organizationId: fixture.organizationId,
        runId: run.runId,
        taskId: run.taskId,
        conversationId: fixture.conversationId,
        stepKey,
        prompt: "Ship it?",
        ownerPrincipalId: approverId,
        traceId: crypto.randomUUID(),
        applicationId: fixture.applicationId,
        repositoryId: null,
      }),
  );
  return asked.approvalId;
}

/** An open question on the run, private to `audience` (or to the task). */
export async function seedQuestion(
  fixture: SocketFixture,
  run: SeededRun,
  audience: readonly string[] | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.questions (
       id, organization_id, kind, conversation_id, task_id, run_id, generation,
       prompt, allow_free_text, audience, status)
     values ($1, $2, 'question', $3, $4, $5, 1, 'Which branch?', true,
             $6::jsonb, 'open')`,
    [
      id,
      fixture.organizationId,
      fixture.conversationId,
      run.taskId,
      run.runId,
      JSON.stringify(
        audience === null
          ? { type: "task_participants" }
          : { type: "principals", principalIds: audience },
      ),
    ],
  );
  return id;
}

/**
 * An artifact version on the task, produced by a step of `runId` (or by no run
 * at all when `runId` is null), for the artifact read cases (#456 slice 2a).
 */
export async function seedArtifactVersion(
  fixture: SocketFixture,
  taskId: string,
  runId: string | null,
): Promise<string> {
  const db = fixture.pgDatabase;
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, 'document', $4)`,
    [artifactId, fixture.organizationId, taskId, `doc-${artifactId}`],
  );
  const step = runId === null ? null : (await db.query<{ id: string }>(
    `select id from bakery.run_steps
      where organization_id = $1 and run_id = $2 order by position limit 1`,
    [fixture.organizationId, runId],
  )).rows[0]?.id ?? null;
  await db.query(
    `insert into bakery.artifact_versions (
       id, organization_id, artifact_id, task_id, author_id, revision, content,
       sha256, size_bytes, media_type, run_step_id)
     values ($1, $2, $3, $4, $5, 1, 'hi'::bytea, $6, 2, 'text/plain', $7)`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      "0".repeat(64),
      step,
    ],
  );
  return versionId;
}

/**
 * A real agent session on the run's step (#456 slice 2b), so the session routes
 * have a row that belongs to a step of that run.
 */
export async function seedAgentSession(
  fixture: SocketFixture,
  run: SeededRun,
  stepKey = run.stepKey,
): Promise<string> {
  const db = fixture.pgDatabase;
  const agentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.agent_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Steered')`,
    [agentId, fixture.organizationId, `steered-${agentId}`],
  );
  await db.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision,
       config, digest, created_by)
     values ($1, $2, $3, 1, '{}'::jsonb, $4, $5)`,
    [
      versionId,
      fixture.organizationId,
      agentId,
      `digest-${versionId}`,
      fixture.principalId,
    ],
  );
  await db.query(
    `insert into bakery.agent_sessions (id, organization_id, run_step_id,
       conversation_id, agent_version_id, harness, status)
     select $1, $2, step.id, $3, $4, 'codex', 'active'
       from bakery.run_steps step
      where step.organization_id = $2 and step.run_id = $5
        and step.step_key = $6
      order by step.iteration desc limit 1`,
    [
      sessionId,
      fixture.organizationId,
      fixture.conversationId,
      versionId,
      run.runId,
      stepKey,
    ],
  );
  return sessionId;
}

/** A second step on the run, so "the other step" cases have something to name. */
export async function seedStep(
  fixture: SocketFixture,
  run: SeededRun,
  stepKey: string,
): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.run_steps (id, organization_id, run_id, step_key,
       position, iteration, status, input)
     values ($1, $2, $3, $4, 2, 0, 'running', '{}')`,
    [crypto.randomUUID(), fixture.organizationId, run.runId, stepKey],
  );
}
