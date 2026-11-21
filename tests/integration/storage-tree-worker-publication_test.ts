import { assert, assertEquals } from "@std/assert";
import {
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  resolveStoragePath,
  type StorageQuery,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

// #444: an artifact a worker publishes appears in the storage tree under its
// work item in the same transaction that created it.

async function seedWorkerAdminIdentity(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
): Promise<{ email: string; principalId: string; cookie: string }> {
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const email = `issue44-worker-admin-${providerUserId}@example.test`;
  const now = new Date();
  await withPgTransaction(
    fixture.pgDatabase,
    async (transaction) => {
      await transaction.query(
        `insert into public."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) values ($1, 'Issue 44 Worker Admin', $2, true, $3, $3)`,
        [providerUserId, email, now],
      );
      await transaction.query(
        `insert into bakery.principals (
           id, provider_user_id, display_name, principal_type
         ) values ($1, $2, 'Issue 44 Worker Admin', 'human')`,
        [principalId, providerUserId],
      );
      await transaction.query(
        `insert into public.session (
           id, token, "userId", "expiresAt", "createdAt", "updatedAt"
         ) values ($1, $2, $3, $4, $5, $5)`,
        [
          crypto.randomUUID(),
          sessionToken,
          providerUserId,
          new Date(Date.now() + 60 * 60 * 1000),
          now,
        ],
      );
    },
  );
  return {
    email,
    principalId,
    cookie: await signSessionCookie(sessionToken, fixture.config.auth!.secret),
  };
}

Deno.test("AC: an artifact published by a worker appears in the tree under its work item", async () => {
  const authFixture = await openAuthFixture();
  const admin = await seedWorkerAdminIdentity(authFixture);
  try {
    const scope = await createWorkerScope(authFixture, "storage-tree-worker", {
      email: admin.email,
      principalId: admin.principalId,
      adminCookie: admin.cookie,
    });
    const fixture: WorkerFixture = {
      ...authFixture,
      ...scope,
      releaseFixture: () => {},
      workerHostIds: [],
    };
    try {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", worker.registration.workerSessionId);
      form.set(
        "workerSessionGeneration",
        String(worker.registration.workerSessionGeneration),
      );
      form.set("artifactType", "patch");
      form.set("name", "Worker-Output.txt");
      form.set("contentType", "text/plain");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File(["worker publication"], "worker.txt"));
      const response = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": `storage-tree-${crypto.randomUUID()}`,
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: form,
          },
        ),
      );
      assertEquals(response.status, 201, await response.clone().text());

      const artifact = (await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.artifacts
          where organization_id = $1 and task_id = $2 and name = 'Worker-Output.txt'`,
        [fixture.organizationId, job.taskId],
      )).rows[0];
      assert(artifact, "the artifact was created");
      const entry = (await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.storage_entries
          where organization_id = $1 and artifact_id = $2`,
        [fixture.organizationId, artifact.id],
      )).rows[0];
      assert(entry, "the artifact has a storage entry");

      // The path under the project and work item resolves to that entry.
      const names = (await fixture.pgDatabase.query<
        { slug: string; folder: string }
      >(
        `select application.slug, folder.name as folder
           from bakery.tasks task
           join bakery.applications application
             on application.organization_id = task.organization_id
            and application.id = task.application_id
           join bakery.storage_entries folder
             on folder.organization_id = task.organization_id
            and folder.system_key = 'task:' || task.id::text
          where task.organization_id = $1 and task.id = $2`,
        [fixture.organizationId, job.taskId],
      )).rows[0];
      const db: StorageQuery = {
        query: async <Row>(sql: string, params: unknown[] = []) => ({
          rows: (await fixture.pgDatabase.query(sql, params))
            .rows as unknown as Row[],
        }),
      };
      const resolved = await resolveStoragePath(db, {
        organizationId: fixture.organizationId,
        path:
          `/projects/${names.slug}/artifacts/${names.folder}/worker-output.txt`,
      });
      assertEquals(resolved?.id, entry.id);
    } finally {
      await closeWorkerScope(fixture, fixture);
    }
  } finally {
    await cleanupAuthFixture(authFixture.pgDatabase, [admin.email]);
    await authFixture.close();
  }
});

Deno.test("#448 S8a: a published version names the session and attempt that published it, not the step's later session", async () => {
  const authFixture = await openAuthFixture();
  const admin = await seedWorkerAdminIdentity(authFixture);
  try {
    const scope = await createWorkerScope(authFixture, "version-provenance", {
      email: admin.email,
      principalId: admin.principalId,
      adminCookie: admin.cookie,
    });
    const fixture: WorkerFixture = {
      ...authFixture,
      ...scope,
      releaseFixture: () => {},
      workerHostIds: [],
    };
    try {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      // The step's only session when the attempt publishes (the handed one).
      const publishing = (await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.agent_sessions
          where organization_id = $1 and run_step_id = $2
          order by created_at desc, id desc limit 1`,
        [fixture.organizationId, job.runStepId],
      )).rows[0];
      assert(publishing, "the step has a session when it publishes");
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", worker.registration.workerSessionId);
      form.set(
        "workerSessionGeneration",
        String(worker.registration.workerSessionGeneration),
      );
      form.set("artifactType", "patch");
      form.set("name", "Provenance.txt");
      form.set("contentType", "text/plain");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File(["published once"], "provenance.txt"));
      const response = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": `provenance-${crypto.randomUUID()}`,
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: form,
          },
        ),
      );
      assertEquals(response.status, 201, await response.clone().text());
      // A later session opens on the same step (a retry or a continuation).
      const later = (await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.agent_sessions (organization_id, run_step_id,
           conversation_id, agent_version_id, harness, status, created_at)
         select organization_id, run_step_id, conversation_id,
                agent_version_id, harness, 'active', now() + interval '1 hour'
           from bakery.agent_sessions where organization_id = $1 and id = $2
         returning id`,
        [fixture.organizationId, publishing.id],
      )).rows[0];
      assert(later.id !== publishing.id);
      const entry = (await fixture.pgDatabase.query<{ id: string }>(
        `select entry.id from bakery.storage_entries entry
           join bakery.artifacts artifact
             on artifact.organization_id = entry.organization_id
            and artifact.id = entry.artifact_id
          where entry.organization_id = $1 and artifact.task_id = $2
            and artifact.name = 'Provenance.txt'`,
        [fixture.organizationId, job.taskId],
      )).rows[0];
      assert(entry, "the published artifact has a storage entry");
      const read = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/storage/files/${entry.id}/versions`,
          {
            headers: {
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              Cookie: fixture.adminCookie,
            },
          },
        ),
      );
      const body = await read.text();
      assertEquals(read.status, 200, body);
      const [version] = (JSON.parse(body) as {
        items: Record<string, unknown>[];
      }).items;
      assertEquals(version.makerKind, "step");
      assertEquals(version.stepId, job.runStepId);
      assertEquals(version.runId, job.runId);
      assertEquals(version.attemptId, assignment.attemptId);
      // The old read picked the step's newest session, which is now the later
      // one; the recorded provenance names the one that published.
      assertEquals(version.sessionId, publishing.id);
      assert(version.actingForPrincipalId !== null);
    } finally {
      await closeWorkerScope(fixture, fixture);
    }
  } finally {
    await cleanupAuthFixture(authFixture.pgDatabase, [admin.email]);
    await authFixture.close();
  }
});

Deno.test("#448 S8a: a version published while a newer session is open on the step names the session the attempt was handed", async () => {
  const authFixture = await openAuthFixture();
  const admin = await seedWorkerAdminIdentity(authFixture);
  try {
    const scope = await createWorkerScope(authFixture, "version-provenance", {
      email: admin.email,
      principalId: admin.principalId,
      adminCookie: admin.cookie,
    });
    const fixture: WorkerFixture = {
      ...authFixture,
      ...scope,
      releaseFixture: () => {},
      workerHostIds: [],
    };
    try {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      // The claim handed the attempt its session (the step's admission one).
      const handed = assignment.agentSessionId;
      assert(handed, "the claim hands the attempt a session");
      // A second session opens on the step BEFORE the attempt publishes, newer
      // than the handed one; the old read picked it as "the step's newest".
      const newer = (await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.agent_sessions (organization_id, run_step_id,
           conversation_id, agent_version_id, harness, status, created_at)
         select organization_id, run_step_id, conversation_id,
                agent_version_id, harness, 'active', now() + interval '1 hour'
           from bakery.agent_sessions where organization_id = $1 and id = $2
         returning id`,
        [fixture.organizationId, handed],
      )).rows[0];
      assert(newer.id !== handed);
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", worker.registration.workerSessionId);
      form.set(
        "workerSessionGeneration",
        String(worker.registration.workerSessionGeneration),
      );
      form.set("artifactType", "patch");
      form.set("name", "Provenance-newer.txt");
      form.set("contentType", "text/plain");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File(["published once"], "provenance.txt"));
      const response = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": `provenance-${crypto.randomUUID()}`,
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: form,
          },
        ),
      );
      assertEquals(response.status, 201, await response.clone().text());
      const entry = (await fixture.pgDatabase.query<{ id: string }>(
        `select entry.id from bakery.storage_entries entry
           join bakery.artifacts artifact
             on artifact.organization_id = entry.organization_id
            and artifact.id = entry.artifact_id
          where entry.organization_id = $1 and artifact.task_id = $2
            and artifact.name = 'Provenance-newer.txt'`,
        [fixture.organizationId, job.taskId],
      )).rows[0];
      assert(entry, "the published artifact has a storage entry");
      const read = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/storage/files/${entry.id}/versions`,
          {
            headers: {
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              Cookie: fixture.adminCookie,
            },
          },
        ),
      );
      const body = await read.text();
      assertEquals(read.status, 200, body);
      const [version] = (JSON.parse(body) as {
        items: Record<string, unknown>[];
      }).items;
      assertEquals(version.makerKind, "step");
      assertEquals(version.stepId, job.runStepId);
      assertEquals(version.runId, job.runId);
      assertEquals(version.attemptId, assignment.attemptId);
      assertEquals(version.sessionId, handed);
      assert(version.sessionId !== newer.id);
      assert(version.actingForPrincipalId !== null);
    } finally {
      await closeWorkerScope(fixture, fixture);
    }
  } finally {
    await cleanupAuthFixture(authFixture.pgDatabase, [admin.email]);
    await authFixture.close();
  }
});
