import { authTestOrigin, signSessionCookie } from "./auth.ts";
import type { SocketFixture } from "./events-socket.ts";

/**
 * Shared setup for the run request tests (#456): members with different roles,
 * runs to ask about, and a small HTTP helper. Every member here is an active
 * member of the fixture's organization; a guest holds no permission at all.
 */

export type Member = {
  principalId: string;
  cookie: string;
  email: string;
  displayName: string;
};

export async function addMember(
  fixture: SocketFixture,
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
  fixture: SocketFixture,
  taskId = fixture.taskId,
): Promise<SeededRun> {
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
  fixture: SocketFixture,
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
