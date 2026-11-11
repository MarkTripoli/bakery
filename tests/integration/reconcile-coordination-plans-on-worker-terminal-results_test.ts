import { assertEquals } from "@std/assert";
import {
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  eventBody,
  type RegisteredWorker,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedLegacyLeasedModelAttempt } from "../helpers/worker-execution/legacy-attempt.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { evaluateLaneAdmission } from "../../apps/server/src/modules/work/coordination-admission.ts";

Deno.test("a lane child completing through the worker result route persists the plan projection and releases the dependant", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const principal = fixture.principalId;
    try {
      const worker = await registeredWorker(fixture, {
        name: "e06-lane-terminal",
      });
      const job = await seedEligibleJob(db, org, principal);
      const scope = (await db.query<{ repository_id: string }>(
        `select repository_id from bakery.tasks where organization_id = $1 and id = $2`,
        [org, job.taskId],
      )).rows[0];

      // Parent and dependant child in the job's application; the job's task is
      // the api lane child, web waits on it for the "contract" artifact.
      const insertTask = async (title: string) => {
        const id = crypto.randomUUID();
        const conversationId = crypto.randomUUID();
        await db.query(
          `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
          [
            conversationId,
            org,
            job.applicationId,
            scope.repository_id,
            title,
            principal,
          ],
        );
        await db.query(
          `insert into bakery.tasks (id, organization_id, application_id, repository_id, conversation_id, title, description, task_type, status, priority, created_by)
         values ($1, $2, $3, $4, $5, $6, '', 'epic', 'draft', 50, $7)`,
          [
            id,
            org,
            job.applicationId,
            scope.repository_id,
            conversationId,
            title,
            principal,
          ],
        );
        return id;
      };
      const parent = await insertTask("parent");
      const webTask = await insertTask("web");
      const planId = crypto.randomUUID();
      const spec = {
        lanes: [
          {
            key: "api",
            repositoryAlias: "api",
            title: "api",
            instructions: "",
            prerequisites: [],
            outputs: [{
              key: "contract",
              kind: "artifact",
              artifactType: "patch",
            }],
            inputs: [],
          },
          {
            key: "web",
            repositoryAlias: "web",
            title: "web",
            instructions: "",
            prerequisites: ["api"],
            outputs: [],
            inputs: [{ fromLane: "api", outputKey: "contract" }],
          },
        ],
        maxConcurrency: 2,
        join: "all-required",
        failurePolicy: "stop-dependent",
      };
      await db.query(
        `insert into bakery.coordination_plans (id, organization_id, application_id, parent_task_id, revision, spec, digest, status, created_by)
       values ($1, $2, $3, $4, 1, $5::jsonb, $6, 'materialized', $7)`,
        [
          planId,
          org,
          job.applicationId,
          parent,
          JSON.stringify(spec),
          "c".repeat(64),
          principal,
        ],
      );
      for (
        const [position, key, child, prereqs, outputs] of [
          [0, "api", job.taskId, [], [{
            key: "contract",
            kind: "artifact",
            artifactType: "patch",
          }]],
          [1, "web", webTask, ["api"], []],
        ] as const
      ) {
        await db.query(
          `insert into bakery.coordination_lanes (organization_id, application_id, plan_id, lane_key, position, repository_id, child_task_id, prerequisites, declared_outputs, lane_digest, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, 'ready')`,
          [
            org,
            job.applicationId,
            planId,
            key,
            position,
            scope.repository_id,
            child,
            prereqs,
            JSON.stringify(outputs),
            "d".repeat(64),
          ],
        );
      }
      const admission = () =>
        withPgTransaction(
          db,
          (transaction) => evaluateLaneAdmission(transaction, org, webTask),
        );
      assertEquals((await admission())?.reason, "lane_prerequisite_incomplete");

      // The real worker result route completes the api child's run and task.
      const assignment = await seedLegacyLeasedModelAttempt(
        fixture,
        worker,
        job.jobId,
      );
      const eventId = crypto.randomUUID();
      const event = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/events`,
        eventBody(assignment, eventId, "1", "2026-09-20T00:00:01.000Z"),
        { idempotencyKey: eventId },
      );
      assertEquals(event.status, 200);
      const result = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "2",
          status: "completed",
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: job.sessionId,
            artifacts: [],
          },
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      assertEquals(result.status, 200);
      assertEquals(
        (await readExecutionState(db, job.jobId)).job.status,
        "completed",
      );

      const task = await db.query<{ status: string }>(
        `select status from bakery.tasks where id = $1`,
        [job.taskId],
      );
      assertEquals(task.rows[0].status, "completed");
      const lanes = await db.query<{ lane_key: string; status: string }>(
        `select lane_key, status from bakery.coordination_lanes where plan_id = $1 order by position`,
        [planId],
      );
      assertEquals(
        Object.fromEntries(lanes.rows.map((l) => [l.lane_key, l.status])),
        { api: "completed", web: "ready" },
      );
      // The plan stays materialized (web unfinished), so no plan-level event is
      // due here; plan status and the coordinationPlan.updated event are covered
      // by the coordination plan integration test.
      const plan = await db.query<{ status: string }>(
        `select status from bakery.coordination_plans where id = $1`,
        [planId],
      );
      assertEquals(plan.rows[0].status, "materialized");

      // Outputs commit, then the dependant is admissible with a typed input.
      const artifactId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      await db.query(
        `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name) values ($1, $2, $3, 'patch', 'contract')`,
        [artifactId, org, job.taskId],
      );
      await db.query(
        `insert into bakery.artifact_versions (id, organization_id, artifact_id, task_id, author_id, revision, content, sha256, size_bytes, media_type)
       values ($1, $2, $3, $4, $5, 1, $6, $7, 1, 'application/json')`,
        [
          versionId,
          org,
          artifactId,
          job.taskId,
          principal,
          new Uint8Array([1]),
          "a".repeat(64),
        ],
      );
      await db.query(
        `update bakery.artifacts set current_version_id = $3 where organization_id = $1 and id = $2`,
        [org, artifactId, versionId],
      );
      const released = await admission();
      assertEquals(released?.reason, null);
      assertEquals(released?.snapshot.inputs[0].artifactVersionId, versionId);
    } finally {
      // The shared worker teardown does not know the coordination tables.
      for (
        const table of [
          "coordination_lanes",
          "coordination_plans",
          "artifact_versions",
          "artifacts",
        ]
      ) {
        await db.query(
          `delete from bakery.${table} where organization_id = $1`,
          [org],
        );
      }
    }
  }));

/** One-lane plan over a fresh lane job; returns the plan and job. */
async function singleLanePlan(fixture: WorkerFixture) {
  const db = fixture.pgDatabase;
  const org = fixture.organizationId;
  const principal = fixture.principalId;
  const job = await seedEligibleJob(db, org, principal);
  const repository = (await db.query<{ repository_id: string }>(
    `select repository_id from bakery.tasks where organization_id = $1 and id = $2`,
    [org, job.taskId],
  )).rows[0].repository_id;
  const parent = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await db.query(
    `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
     values ($1, $2, $3, $4, 'parent', $5)`,
    [conversationId, org, job.applicationId, repository, principal],
  );
  await db.query(
    `insert into bakery.tasks (id, organization_id, application_id, repository_id, conversation_id, title, description, task_type, status, priority, created_by)
     values ($1, $2, $3, $4, $5, 'parent', '', 'epic', 'draft', 50, $6)`,
    [parent, org, job.applicationId, repository, conversationId, principal],
  );
  const planId = crypto.randomUUID();
  await db.query(
    `insert into bakery.coordination_plans (id, organization_id, application_id, parent_task_id, revision, spec, digest, status, created_by)
     values ($1, $2, $3, $4, 1, '{}'::jsonb, $5, 'materialized', $6)`,
    [planId, org, job.applicationId, parent, "c".repeat(64), principal],
  );
  await db.query(
    `insert into bakery.coordination_lanes (organization_id, application_id, plan_id, lane_key, position, repository_id, child_task_id, prerequisites, declared_outputs, lane_digest, status)
     values ($1, $2, $3, 'api', 0, $4, $5, '{}'::text[], '[]'::jsonb, $6, 'running')`,
    [org, job.applicationId, planId, repository, job.taskId, "d".repeat(64)],
  );
  return { planId, job };
}

async function claimOnce(fixture: WorkerFixture, worker: RegisteredWorker) {
  const claimKey = crypto.randomUUID();
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
    },
    { idempotencyKey: claimKey },
  );
  assertEquals([200, 204].includes(response.status), true);
  await response.body?.cancel();
}

async function assertPlanFollowedFailure(
  fixture: WorkerFixture,
  planId: string,
  taskId: string,
) {
  const db = fixture.pgDatabase;
  const task = await db.query<{ status: string }>(
    `select status from bakery.tasks where id = $1`,
    [taskId],
  );
  assertEquals(task.rows[0].status, "failed");
  const lane = await db.query<{ status: string }>(
    `select status from bakery.coordination_lanes where plan_id = $1`,
    [planId],
  );
  assertEquals(lane.rows[0].status, "failed");
  const plan = await db.query<{ status: string }>(
    `select status from bakery.coordination_plans where id = $1`,
    [planId],
  );
  assertEquals(plan.rows[0].status, "failed");
  const events = await db.query(
    `select 1 from bakery.domain_events
      where event_type = 'coordinationPlan.updated' and aggregate_id = $1`,
    [planId],
  );
  assertEquals(events.rows.length, 1);
}

async function deleteCoordination(fixture: WorkerFixture) {
  for (const table of ["coordination_lanes", "coordination_plans"]) {
    await fixture.pgDatabase.query(
      `delete from bakery.${table} where organization_id = $1`,
      [fixture.organizationId],
    );
  }
}

Deno.test("a lane child failed by an invalid assignment payload persists the plan projection", () =>
  withWorkerFixture(async (fixture) => {
    try {
      const worker = await registeredWorker(fixture, {
        name: "e06-lane-invalid-payload",
      });
      const { planId, job } = await singleLanePlan(fixture);
      await fixture.pgDatabase.query(
        `update bakery.jobs set current_checkpoints = $2::jsonb where id = $1`,
        [job.jobId, JSON.stringify({ malformed: true })],
      );
      await claimOnce(fixture, worker);
      assertEquals(
        (await readExecutionState(fixture.pgDatabase, job.jobId)).job.status,
        "failed",
      );
      await assertPlanFollowedFailure(fixture, planId, job.taskId);
    } finally {
      await deleteCoordination(fixture);
    }
  }));

Deno.test("a lane child failed by lease expiry with no attempts left persists the plan projection", () =>
  withWorkerFixture(async (fixture) => {
    try {
      const worker = await registeredWorker(fixture, {
        name: "e06-lane-lease-expiry",
      });
      const { planId, job } = await singleLanePlan(fixture);
      await fixture.pgDatabase.query(
        `update bakery.jobs set max_attempts = 1 where id = $1`,
        [job.jobId],
      );
      const assignment = await seedLegacyLeasedModelAttempt(
        fixture,
        worker,
        job.jobId,
      );
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set lease_expires_at = clock_timestamp() - interval '1 second'
          where id = $1`,
        [assignment.attemptId],
      );
      // The next claim reclaims the expired lease; the attempt budget is spent.
      await claimOnce(fixture, worker);
      assertEquals(
        (await readExecutionState(fixture.pgDatabase, job.jobId)).job.status,
        "failed",
      );
      await assertPlanFollowedFailure(fixture, planId, job.taskId);
    } finally {
      await deleteCoordination(fixture);
    }
  }));
