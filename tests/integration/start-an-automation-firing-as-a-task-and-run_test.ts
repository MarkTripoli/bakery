import { assert, assertEquals } from "@std/assert";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { startFiring } from "../../apps/server/src/modules/workflows/automations/start.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { closeWorkerOrganization } from "../helpers/worker-execution.ts";
import {
  apiCall,
  expectJson,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";

// #36 slice 4a. A queued firing becomes a task and a run through the same
// commands every other intake uses, as the automation version's actor, in the
// firing's organization, in one transaction: at most one run however often it
// is started, and a refusal that waiting will not change fails the firing with
// a stable code and leaves nothing behind.

const definition = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec));

type Created = { id: string };

/** A published workflow version, an automation with one version of this target, and a queued firing. */
async function setUp(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  options: { budgetLimitUsd?: string } = {},
) {
  const scope = fixture;
  const agent = await seedFundedCodingAgent(fixture, scope, "automation");
  const repository = await seedPresetRepository(fixture.pgDatabase, scope, {
    agentVersionId: agent,
  });
  const workflow = await expectJson<Created>(
    await apiCall(fixture, scope, "POST", "/v1/workflows", {
      body: { slug: "nightly", name: "Nightly", description: "Automated." },
    }),
    201,
  );
  const draft = await expectJson<Created>(
    await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${workflow.id}/versions`,
      { body: { definition } },
    ),
    201,
  );
  const published = await expectJson<Created>(
    await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${workflow.id}/versions/${draft.id}/publish`,
      { body: {}, headers: { "If-Match": '"1"' } },
    ),
    200,
  );
  const automation = await expectJson<Created>(
    await apiCall(fixture, scope, "POST", "/v1/automations", {
      body: {
        slug: "nightly-check",
        name: "Nightly check",
        description: "Runs the nightly check.",
      },
    }),
    201,
  );
  const versionBody = (extra: Record<string, unknown> = {}) => ({
    trigger: { type: "schedule", cron: "0 3 * * *", timezone: "UTC" },
    workflowVersionId: published.id,
    inputs: { brief: "Retry failed uploads twice." },
    applicationId: repository.applicationId,
    repositoryId: repository.repositoryId,
    budgetLimitUsd: options.budgetLimitUsd ?? "5",
    brief: "Run the nightly check and report.",
    misfirePolicy: "coalesce",
    overlapPolicy: "skip",
    ...extra,
  });
  const createVersion = (extra: Record<string, unknown> = {}) =>
    apiCall(
      fixture,
      scope,
      "POST",
      `/v1/automations/${automation.id}/versions`,
      { body: versionBody(extra) },
    );
  const version = await expectJson<
    { id: string; digest: string; budgetLimitUsd: string }
  >(await createVersion(), 201);
  const queue = async (versionId: string, at = "2026-11-14T03:00:00Z") =>
    (await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.automation_firings (
         organization_id, automation_version_id, scheduled_at, status, pending,
         skipped_count
       ) values ($1, $2, $3, 'queued', true, 0)
       returning id`,
      [scope.organizationId, versionId, at],
    )).rows[0].id;
  const firing = async (id: string) =>
    (await fixture.pgDatabase.query<{
      status: string;
      pending: boolean;
      runId: string | null;
      failureCode: string | null;
    }>(
      `select status, pending, run_id as "runId", failure_code as "failureCode"
         from bakery.automation_firings where id = $1`,
      [id],
    )).rows[0];
  const counts = async () =>
    (await fixture.pgDatabase.query<{ tasks: string; runs: string }>(
      `select (select count(*) from bakery.tasks where organization_id = $1)::text as tasks,
              (select count(*) from bakery.workflow_runs where organization_id = $1)::text as runs`,
      [scope.organizationId],
    )).rows[0];
  return {
    scope,
    repository,
    published,
    automation,
    version,
    createVersion,
    queue,
    firing,
    counts,
  };
}

Deno.test("a queued firing starts one task and one run as the version's actor, once however often it is started", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    // The version projects its target; the budget is held in one form.
    assertEquals(s.version.budgetLimitUsd, "5.000000");
    const same = await expectJson<{ digest: string }>(
      await s.createVersion({ budgetLimitUsd: "5.00" }),
      201,
    );
    assertEquals(same.digest, s.version.digest);

    const before = await s.counts();
    const firingId = await s.queue(s.version.id);
    const settled = await Promise.allSettled([
      startFiring({ database: fixture.pgDatabase, firingId }),
      startFiring({ database: fixture.pgDatabase, firingId }),
      startFiring({ database: fixture.pgDatabase, firingId }),
    ]);
    for (const result of settled) {
      if (result.status === "rejected") {
        throw new Error(
          `a start threw: ${String(result.reason)} ${
            String((result.reason as Error)?.stack).slice(0, 1500)
          }`,
        );
      }
    }
    const outcomes = settled.map((result) =>
      (result as PromiseFulfilledResult<
        Awaited<ReturnType<typeof startFiring>>
      >).value
    );
    const started = outcomes.filter((outcome) => outcome.kind === "started");
    assertEquals(started.length, 1, JSON.stringify(outcomes));
    assertEquals(
      outcomes.filter((outcome) => outcome.kind === "not_startable").length,
      2,
    );
    const runId = (started[0] as { runId: string }).runId;
    assertEquals(await s.firing(firingId), {
      status: "started",
      pending: false,
      runId,
      failureCode: null,
    });
    const after = await s.counts();
    assertEquals(Number(after.tasks), Number(before.tasks) + 1);
    assertEquals(Number(after.runs), Number(before.runs) + 1);
    // The run is the pinned workflow version's, for the repository, with the
    // version's budget and inputs; the task carries the name, instant and brief.
    const run = (await fixture.pgDatabase.query<{
      workflowVersionId: string;
      status: string;
      budget: string;
      taskId: string;
      requestedBy: string;
    }>(
      `select workflow_version_id as "workflowVersionId", status,
              budget_limit_usd::text as budget, task_id as "taskId",
              requested_by as "requestedBy"
         from bakery.workflow_runs where id = $1`,
      [runId],
    )).rows[0];
    assertEquals(run.workflowVersionId, s.published.id);
    assertEquals(run.status, "queued");
    assertEquals(run.budget, "5.000000");
    assertEquals(run.requestedBy, s.scope.principalId);
    const task = (await fixture.pgDatabase.query<
      { title: string; description: string; repositoryId: string }
    >(
      `select title, description, repository_id as "repositoryId"
         from bakery.tasks where id = $1`,
      [run.taskId],
    )).rows[0];
    assertEquals(task.title, "Nightly check 2026-11-14T03:00:00.000Z");
    assertEquals(task.description, "Run the nightly check and report.");
    assertEquals(task.repositoryId, s.repository.repositoryId);
    // A later start is a no-op.
    assertEquals(
      await startFiring({ database: fixture.pgDatabase, firingId }),
      { kind: "not_startable" },
    );
    assertEquals(await s.counts(), after);
    assertEquals(
      await startFiring({
        database: fixture.pgDatabase,
        firingId: crypto.randomUUID(),
      }),
      { kind: "not_startable" },
    );
  }));

Deno.test("a refusal that waiting will not change fails the firing with a code and leaves no task or run", () =>
  withWorkerFixture(async (fixture) => {
    // A budget of 0 cannot reserve for the workflow's model step.
    const s = await setUp(fixture, { budgetLimitUsd: "0" });
    const before = await s.counts();
    const firingId = await s.queue(s.version.id);
    const outcome = await startFiring({
      database: fixture.pgDatabase,
      firingId,
    });
    assertEquals(outcome.kind, "failed");
    const failed = await s.firing(firingId);
    assertEquals(failed.status, "failed");
    assertEquals(failed.pending, false);
    assertEquals(failed.runId, null);
    assertEquals(failed.failureCode, (outcome as { code: string }).code);
    assertEquals(failed.failureCode, "budget_below_reservation");
    assert(
      failed.failureCode !== null && failed.failureCode !== "",
      "a code is recorded",
    );
    assertEquals(await s.counts(), before);
    // And it is not tried again.
    assertEquals(
      await startFiring({ database: fixture.pgDatabase, firingId }),
      { kind: "not_startable" },
    );
  }));

Deno.test("an actor who is not in the organization, or a version with no target, fails the firing", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    const before = await s.counts();
    // A version whose actor holds no membership here.
    const stranger = crypto.randomUUID();
    const strangerUser = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'stranger', $2, true, now(), now())`,
      [strangerUser, `stranger-${strangerUser}@example.test`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, 'stranger', 'human')`,
      [stranger, strangerUser],
    );
    const actorVersion = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.automation_versions (
         id, organization_id, automation_id, revision, trigger,
         workflow_version_id, actor_id, inputs, application_id, repository_id,
         budget_limit_usd, misfire_policy, overlap_policy, digest
       ) values ($1, $2, $3, 90, '{"type":"schedule","cron":"0 3 * * *","timezone":"UTC"}'::jsonb,
         $4, $5, '{}'::jsonb, $6, $7, 5, 'coalesce', 'skip', 'digest-actor')`,
      [
        actorVersion,
        s.scope.organizationId,
        s.automation.id,
        s.published.id,
        stranger,
        s.repository.applicationId,
        s.repository.repositoryId,
      ],
    );
    const noTarget = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.automation_versions (
         id, organization_id, automation_id, revision, trigger,
         workflow_version_id, actor_id, inputs, misfire_policy, overlap_policy, digest
       ) values ($1, $2, $3, 91, '{"type":"schedule","cron":"0 3 * * *","timezone":"UTC"}'::jsonb,
         $4, $5, '{}'::jsonb, 'coalesce', 'skip', 'digest-target')`,
      [
        noTarget,
        s.scope.organizationId,
        s.automation.id,
        s.published.id,
        s.scope.principalId,
      ],
    );
    const byActor = await s.queue(actorVersion, "2026-11-14T04:00:00Z");
    const byTarget = await s.queue(noTarget, "2026-11-14T05:00:00Z");
    assertEquals(
      await startFiring({ database: fixture.pgDatabase, firingId: byActor }),
      { kind: "failed", code: "actor_unavailable" },
    );
    assertEquals(
      await startFiring({ database: fixture.pgDatabase, firingId: byTarget }),
      { kind: "failed", code: "target_missing" },
    );
    assertEquals((await s.firing(byActor)).failureCode, "actor_unavailable");
    assertEquals((await s.firing(byTarget)).failureCode, "target_missing");
    assertEquals(await s.counts(), before);
    // The stranger is not an organization member the fixture removes: take it away.
    await fixture.pgDatabase.query(
      `delete from bakery.automation_firings where id = $1`,
      [byActor],
    );
    await fixture.pgDatabase.query(
      `delete from bakery.automation_versions where id = $1`,
      [actorVersion],
    );
    await fixture.pgDatabase.query(
      `delete from bakery.principals where id = $1`,
      [stranger],
    );
    await fixture.pgDatabase.query(`delete from public."user" where id = $1`, [
      strangerUser,
    ]);
  }));

Deno.test("a version's target is checked in its own organization when it is created, and the foreign keys hold it there", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    // Another organization with an application and a repository of its own.
    const otherOrganization = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
       values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
      [otherOrganization, `other-${otherOrganization}`],
    );
    const other = await seedPresetRepository(fixture.pgDatabase, {
      organizationId: otherOrganization,
      principalId: s.scope.principalId,
      adminCookie: s.scope.adminCookie,
    });
    try {
      const problem = async (response: Response) => {
        const body = await expectJson<{
          code: string;
          errors?: { reason?: string }[];
        }>(response, 422);
        return JSON.stringify(body);
      };
      // Unknown here, and known only to the other organization.
      assert(
        (await problem(
          await s.createVersion({ applicationId: crypto.randomUUID() }),
        )).includes("application_not_found"),
      );
      assert(
        (await problem(
          await s.createVersion({
            applicationId: other.applicationId,
            repositoryId: null,
          }),
        )).includes("application_not_found"),
      );
      // A repository of another organization, and of another application.
      assert(
        (await problem(
          await s.createVersion({ repositoryId: other.repositoryId }),
        )).includes("repository_not_found"),
      );
      assert(
        (await problem(
          await s.createVersion({ repositoryId: crypto.randomUUID() }),
        )).includes("repository_not_found"),
      );
      // A repository that belongs to another application of the same organization.
      const secondApplication = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.applications (id, organization_id, slug, name)
         values ($1, $2, $3, 'Second application')`,
        [
          secondApplication,
          s.scope.organizationId,
          `second-${secondApplication}`,
        ],
      );
      assert(
        (await problem(
          await s.createVersion({ applicationId: secondApplication }),
        )).includes("repository_not_in_application"),
      );
      // A budget over the cap is the handler's 422; what is not a decimal never
      // reaches it (the contract refuses the shape).
      assert(
        (await problem(await s.createVersion({ budgetLimitUsd: "201" })))
          .includes("budget_limit_invalid"),
      );
      for (const budgetLimitUsd of ["five", "-1", "1e3"]) {
        const response = await s.createVersion({ budgetLimitUsd });
        assert(
          response.status === 400 || response.status === 422,
          `${budgetLimitUsd}: ${response.status}`,
        );
        await response.body?.cancel();
      }
      // The database holds the same line when a row bypasses the route.
      let refused = 0;
      for (
        const [applicationId, repositoryId] of [
          [other.applicationId, null],
          [s.repository.applicationId, other.repositoryId],
        ]
      ) {
        try {
          await fixture.pgDatabase.query(
            `insert into bakery.automation_versions (
             organization_id, automation_id, revision, trigger,
             workflow_version_id, actor_id, inputs, application_id, repository_id,
             misfire_policy, overlap_policy, digest
           ) values ($1, $2, 95, '{}'::jsonb, $3, $4, '{}'::jsonb, $5, $6,
                     'coalesce', 'skip', 'digest-fk')`,
            [
              s.scope.organizationId,
              s.automation.id,
              s.published.id,
              s.scope.principalId,
              applicationId,
              repositoryId,
            ],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23503") refused += 1;
          else throw error;
        }
      }
      assertEquals(refused, 2);
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, otherOrganization);
    }
  }));
