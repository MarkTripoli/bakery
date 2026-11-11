import { authTestOrigin, signSessionCookie } from "./auth.ts";
import {
  type Fixture,
  type Harness,
  recordSeededEmail,
  type Seed,
  seedOrganization,
} from "./coordinator-turns.ts";
import type {
  CoordinatorEffect,
  CoordinatorTurnExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";

export type { Fixture, Harness, Seed };
export { seedOrganization };

/** Gives the seed's conversation a task; questions are task-scoped. */
export async function seedTask(
  fixture: Harness,
  seed: Seed,
): Promise<string> {
  const taskId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `update bakery.conversations set application_id = $2 where id = $1`,
    [seed.conversationId, seed.applicationId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (id, organization_id, application_id, conversation_id, title,
       description, task_type, status, created_by)
     values ($1, $2, $3, $4, 'Question task', 'durable questions fixture', 'feature', 'queued', $5)`,
    [
      taskId,
      seed.organizationId,
      seed.applicationId,
      seed.conversationId,
      seed.principalId,
    ],
  );
  return taskId;
}

export type Member = { principalId: string; cookie: string };

/** Adds another active member with a live session to the seed's organization. */
export async function addMember(
  fixture: Harness,
  seed: Seed,
  label: string,
  role = "developer",
): Promise<Member> {
  const db = fixture.pgDatabase;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `member-${crypto.randomUUID()}`;
  const now = new Date();
  const email = `${label}-${providerUserId}@example.test`;
  recordSeededEmail(email);
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
    [crypto.randomUUID(), seed.organizationId, principalId, now, role],
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
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

/** Like the turn helper's `call`, with PUT and an explicit identity. */
export async function request(
  fixture: Harness,
  identity: { cookie: string; organizationId: string },
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    key?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({
    cookie: identity.cookie,
    "Bakery-Organization-Id": identity.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }),
  );
}

export type QuestionView = {
  id: string;
  status: string;
  version: number;
  generation: number;
  turnId: string | null;
  answer: { optionId?: string; text?: string } | null;
  answeredBy: string | null;
  options: { id: string; label: string }[] | null;
  taskId: string;
  kind: string;
};

export function scriptedEffects(
  effects: readonly CoordinatorEffect[],
): CoordinatorTurnExecutor {
  return {
    execute: () =>
      Promise.resolve({ status: "completed", effects: [...effects] }),
  };
}

export const ASK_ALLOW_OR_DENY: CoordinatorEffect = {
  type: "question",
  prompt: "Allow the migration?",
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
};

/** Runs the oldest queued turn so far with the given executor. */
export async function runTurn(
  fixture: Fixture,
  seed: Seed,
  executor: CoordinatorTurnExecutor,
) {
  const { processNextConversationTurn } = await import(
    "../../apps/server/src/modules/conversation/turn-runtime.ts"
  );
  return await processNextConversationTurn(
    {
      database: fixture.runtimePgDatabase,
      executor,
      leaseMs: 60_000,
      heartbeatMs: 100,
    },
    {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
    },
  );
}

/** Seeds a running run step with a live worker attempt advertising capabilities. */
export async function seedLiveAttempt(
  fixture: Harness,
  seed: Seed,
  taskId: string,
  adapterCapabilities: readonly string[],
) {
  const db = fixture.pgDatabase;
  const ids = {
    workflowId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    workerPrincipalId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentSessionId: crypto.randomUUID(),
  };
  await db.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Steering workflow')`,
    [ids.workflowId, seed.organizationId, `steer-${ids.workflowId}`],
  );
  await db.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
       source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: steer', '{"name":"steer"}', $4, 'published', $5)`,
    [
      ids.versionId,
      seed.organizationId,
      ids.workflowId,
      `steer-${ids.versionId}`,
      seed.principalId,
    ],
  );
  await db.query(
    `insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id,
       requested_by, status, snapshot, budget_limit_usd)
     values ($1, $2, $3, $4, $5, 'running', '{"name":"steer"}', 0)`,
    [ids.runId, seed.organizationId, taskId, ids.versionId, seed.principalId],
  );
  await db.query(
    `insert into bakery.run_steps (id, organization_id, run_id, step_key, position, iteration,
       status, input) values ($1, $2, $3, 'implement', 1, 0, 'running', '{}')`,
    [ids.stepId, seed.organizationId, ids.runId],
  );
  await db.query(
    `insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements, status, current_fence)
     values ($1, $2, $3, 'harness.implement', '{}', '{}', 'running', 1)`,
    [ids.jobId, seed.organizationId, ids.stepId],
  );
  await db.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Steering worker', 'worker')`,
    [ids.workerPrincipalId],
  );
  await db.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id, principal_type, name,
       os, architecture, capabilities, slots, credential_hash, worker_session_id,
       worker_session_generation, adapter_capabilities)
     values ($1, $2, $3, 'worker', 'Steering host', 'linux', 'x64', '[]', 1, $4, $5, 0, $6::jsonb)`,
    [
      ids.hostId,
      seed.organizationId,
      ids.workerPrincipalId,
      `steer-${ids.hostId}`,
      ids.sessionId,
      JSON.stringify(adapterCapabilities),
    ],
  );
  await db.query(
    `insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id,
       worker_session_id, worker_session_generation, attempt_no, fence, lease_token_hash,
       lease_expires_at, status, started_at)
     values ($1, $2, $3, $4, $5, 0, 1, 1, $6, clock_timestamp() + interval '5 minutes', 'running', clock_timestamp())`,
    [
      ids.attemptId,
      seed.organizationId,
      ids.jobId,
      ids.hostId,
      ids.sessionId,
      `lease-${ids.attemptId}`,
    ],
  );
  await db.query(
    `insert into bakery.agent_sessions (id, organization_id, run_step_id, conversation_id,
       agent_version_id, harness, status)
     values ($1, $2, $3, $4, $5, 'codex', 'active')`,
    [
      ids.agentSessionId,
      seed.organizationId,
      ids.stepId,
      seed.conversationId,
      seed.agentVersionId,
    ],
  );
  return ids;
}
