import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  closeWorkerScope,
  createWorkerScope,
  readExecutionState,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  admitPresetRun,
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import { problemCode } from "../helpers/worker-execution.ts";
import { signSessionCookie } from "../helpers/auth.ts";

type RunBody = { id: string; workflowVersionId: string };

/** A signed-in principal that holds no membership in the fixture organization. */
async function nonMemberCookie(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
): Promise<{ cookie: string; cleanup: () => Promise<void> }> {
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `preset-nonmember-${crypto.randomUUID()}`;
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Preset outsider', $2, true, $3, $3)`,
    [userId, `preset-outsider-${userId}@example.test`, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Preset outsider', 'human')`,
    [principalId, userId],
  );
  await fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      userId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
    cleanup: async () => {
      await fixture.pgDatabase.query(
        'delete from public.session where "userId" = $1',
        [userId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.principals where id = $1",
        [principalId],
      );
      await fixture.pgDatabase.query(
        'delete from public."user" where id = $1',
        [userId],
      );
    },
  };
}

const withFixture = <T>(work: Parameters<typeof withWorkerFixture<T>>[0]) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

Deno.test("preset discovery and run start are closed to other organizations and anonymous callers", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `sec-${suffix}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    // The same admin acting in another organization cannot see this repository.
    const otherOrganization = await createWorkerScope(
      fixture,
      "preset-other-organization",
      fixture,
    );
    const outsider = await nonMemberCookie(fixture);
    try {
      const foreign = await apiCall(
        fixture,
        otherOrganization,
        "GET",
        `/v1/workflow-presets?repositoryId=${repository.repositoryId}`,
      );
      assertEquals(foreign.status, 404);
      assertEquals((await foreign.json()).code, "RESOURCE_NOT_FOUND");

      // A principal with no membership here can neither list nor start runs.
      const list = await apiCall(
        fixture,
        fixture,
        "GET",
        "/v1/workflow-presets",
        {
          cookie: outsider.cookie,
        },
      );
      // Organizations a principal does not belong to are hidden as not found.
      assertEquals(list.status, 404);
      const start = await apiCall(
        fixture,
        fixture,
        "POST",
        `/v1/tasks/${task.id}/runs`,
        {
          cookie: outsider.cookie,
          body: {
            presetId: "fixed-coding",
            executionMode: "repository",
            repositoryProfileId: repository.profileId,
          },
        },
      );
      // Task-scoped commands hide the task from non-members as not found.
      assertEquals(start.status, 404);

      // Anonymous callers never reach the handler.
      const anonymous = await fixture.app.fetch(
        new Request("http://127.0.0.1:8788/v1/workflow-presets", {
          headers: { "Bakery-Organization-Id": fixture.organizationId },
        }),
      );
      assertEquals(anonymous.status, 401);

      const runs = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.workflow_runs
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(runs.rows[0].count, "0");
      const state = await fixture.pgDatabase.query<{ status: string }>(
        `select status from bakery.tasks where organization_id = $1 and id = $2`,
        [fixture.organizationId, task.id],
      );
      assertEquals(state.rows[0].status, "draft");
    } finally {
      await outsider.cleanup();
      await closeWorkerScope(fixture, otherOrganization);
    }
  }));

Deno.test("another organization's preset rows are never reused or addressable", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `own-${suffix}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );

    const other = await createWorkerScope(fixture, "preset-isolated", fixture);
    try {
      const otherAgent = await seedFundedCodingAgent(
        fixture,
        other,
        `other-${suffix}`,
      );
      const otherRepository = await seedPresetRepository(
        fixture.pgDatabase,
        other,
        { agentVersionId: otherAgent },
      );
      const otherTask = await createPresetTask(fixture, other, otherRepository);
      const otherRun = await expectJson<RunBody>(
        await startPresetRun(fixture, other, otherTask, otherRepository),
        201,
      );
      assertNotEquals(otherRun.workflowVersionId, run.workflowVersionId);
      const owners = await fixture.pgDatabase.query<{
        id: string;
        organization_id: string;
      }>(
        `select id, organization_id from bakery.workflow_versions
          where id = any($1::uuid[])`,
        [[run.workflowVersionId, otherRun.workflowVersionId]],
      );
      const ownerOf = new Map(
        owners.rows.map((row) => [row.id, row.organization_id]),
      );
      assertEquals(ownerOf.get(run.workflowVersionId), fixture.organizationId);
      assertEquals(
        ownerOf.get(otherRun.workflowVersionId),
        other.organizationId,
      );

      // The first organization's materialized version is not addressable here.
      const secondTask = await createPresetTask(
        fixture,
        other,
        otherRepository,
        { title: "Second isolated task" },
      );
      const borrowed = await apiCall(
        fixture,
        other,
        "POST",
        `/v1/tasks/${secondTask.id}/runs`,
        {
          body: {
            workflowVersionId: run.workflowVersionId,
            executionMode: "repository",
            repositoryProfileId: otherRepository.profileId,
          },
        },
      );
      assertEquals(borrowed.status, 404);
    } finally {
      await closeWorkerScope(fixture, other);
    }
  }));

Deno.test("a result cannot reference a harness session that belongs to another run step", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `forge-${suffix}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const runs: Array<Awaited<ReturnType<typeof admitPresetRun>>> = [];
    for (const title of ["First forged", "Second forged"]) {
      const task = await createPresetTask(fixture, fixture, repository, {
        title,
      });
      const run = await expectJson<RunBody>(
        await startPresetRun(fixture, fixture, task, repository),
        201,
      );
      runs.push(await admitPresetRun(fixture.pgDatabase, fixture, run));
    }
    const worker = await registeredWorker(fixture, {
      name: `preset-forgery-${suffix}`,
      capabilities: workerFixtureCapabilities,
    });
    const assignment = await claimAssignment(fixture, worker, {
      supportedActions: ["harness.implement"],
    });
    const claimed = runs.find((run) => run.implementJobId === assignment.jobId);
    const other = runs.find((run) => run.implementJobId !== assignment.jobId);
    assert(claimed && other);
    const sessionOf = async (stepId: string) =>
      (await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.agent_sessions
          where organization_id = $1 and run_step_id = $2`,
        [fixture.organizationId, stepId],
      )).rows[0].id;
    const ownSession = await sessionOf(claimed.implementStepId);
    const foreignSession = await sessionOf(other.implementStepId);
    assertEquals(assignment.agentSessionId, ownSession);
    assertNotEquals(ownSession, foreignSession);

    const submit = (sessionId: string, key: string) =>
      workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "completed",
          result: {
            headSha: `head-${assignment.jobId}`,
            baseSha: `base-${assignment.jobId}`,
            sessionId,
            artifacts: [],
          },
        },
        { idempotencyKey: key },
      );
    const forged = await submit(foreignSession, crypto.randomUUID());
    assertEquals(forged.status, 404);
    assertEquals(await problemCode(forged), "RESOURCE_NOT_FOUND");
    const state = await readExecutionState(
      fixture.pgDatabase,
      assignment.jobId,
    );
    assertEquals(state.attempts[0].lastEventSeq, "0");
    assertEquals(state.step.status === "completed", false);
  }));
