import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import type { WorkerFixture } from "./worker-execution.ts";
import {
  apiCall,
  expectJson,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "./fixed-coding-preset.ts";

// An organization with a funded coding agent, a repository, a published
// workflow version, an automation and one version of it (pinning that target),
// as the automation tests need them (issue #36).

const definition = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec));

/**
 * The run inputs this fixture gives an automation version, which must satisfy
 * the preset the version pins: every declared input the preset requires, and
 * nothing it does not declare. `preset-inputs-match-shared-fixtures_test.ts`
 * pins that against `WORKFLOW_PRESETS`, so a contract change to a preset fails
 * in one named place instead of silently in every suite that shares this
 * fixture (#499 changed `brief` from a string to `TaskBrief` and added
 * `repositoryId` and `instructions`; twelve automation tests went red).
 */
export function automationVersionInputs(
  repositoryId: string,
): Record<string, unknown> {
  return {
    repositoryId,
    instructions: "Retry the failed uploads twice, then report.",
    brief: {
      title: "Retry failed uploads twice",
      description: "Retry failed uploads twice.",
      taskType: "maintenance",
    },
  };
}

type Created = { id: string };

/** A published workflow version, an automation with one version of this target, and a queued firing. */
export async function setUpAutomation(
  fixture: WorkerFixture,
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
    inputs: automationVersionInputs(repository.repositoryId),
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
  const audits = async (firingId: string) =>
    (await fixture.pgDatabase.query<
      { outcome: string; code: string | null }
    >(
      `select outcome, details ->> 'code' as code
         from bakery.audit_events
        where resource_id = $1 and operation = 'automationFirings.start'`,
      [firingId],
    )).rows;
  const counts = async () =>
    (await fixture.pgDatabase.query<{ tasks: string; runs: string }>(
      `select (select count(*) from bakery.tasks where organization_id = $1)::text as tasks,
              (select count(*) from bakery.workflow_runs where organization_id = $1)::text as runs`,
      [scope.organizationId],
    )).rows[0];
  return {
    scope,
    agent,
    repository,
    published,
    automation,
    version,
    createVersion,
    queue,
    firing,
    audits,
    counts,
  };
}
