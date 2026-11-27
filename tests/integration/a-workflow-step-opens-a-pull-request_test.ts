import { assertEquals } from "@std/assert";
import {
  enabledConnection,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import {
  removeSeed,
  seedTaskAndRepository,
} from "../helpers/github-intake/seed.ts";
import { createOpenPullRequestStepRunner } from "../../apps/server/src/modules/delivery/open-pull-request-step.ts";

type Fixture = Awaited<ReturnType<typeof openGitHubAppFixture>>;
type Seed = Awaited<ReturnType<typeof seedTaskAndRepository>>;

async function seedRun(fixture: Fixture, seed: Seed): Promise<string> {
  const ids = {
    workflow: crypto.randomUUID(),
    version: crypto.randomUUID(),
    run: crypto.randomUUID(),
  };
  const db = fixture.pgDatabase;
  await db.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Open a pull request')`,
    [ids.workflow, seed.organizationId, `open-pr-${ids.workflow}`],
  );
  await db.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id,
       revision, source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: open-pr', '{"name":"open-pr"}', $4,
       'published', $5)`,
    [
      ids.version,
      seed.organizationId,
      ids.workflow,
      `open-pr-${ids.version}`,
      fixture.adminId,
    ],
  );
  const profileId = crypto.randomUUID();
  const digest = "a".repeat(64);
  await db.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by)
     select $1, repository.organization_id, repository.application_id,
            repository.id, 1, '{}'::jsonb, $2, $3
       from bakery.repositories as repository
      where repository.organization_id = $4 and repository.id = $5`,
    [
      profileId,
      digest,
      fixture.adminId,
      seed.organizationId,
      seed.repositoryId,
    ],
  );
  await db.query(
    `insert into bakery.workflow_runs (id, organization_id, task_id,
       workflow_version_id, requested_by, status, snapshot, budget_limit_usd,
       application_id, repository_id, repository_profile_id,
       repository_profile_revision, repository_profile_digest)
     select $1, task.organization_id, task.id, $2, $3, 'running',
            '{"name":"open-pr"}', 0, task.application_id, $4, $7, 1, $8
       from bakery.tasks as task
      where task.organization_id = $5 and task.id = $6`,
    [
      ids.run,
      ids.version,
      fixture.adminId,
      seed.repositoryId,
      seed.organizationId,
      seed.taskId,
      profileId,
      digest,
    ],
  );
  return ids.run;
}

Deno.test("a delivery.openPullRequest step opens the pull request as the run's principal, once", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Seed | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    seed = await seedTaskAndRepository(fixture, connection.selected[0]);
    const runId = await seedRun(fixture, seed);
    const runner = createOpenPullRequestStepRunner({
      database: fixture.runtimePgDatabase!,
      registration: {
        database: fixture.runtimePgDatabase!,
        github: fixture.github.client,
        secretsKey: fixture.secretsKey,
        broker: fixture.broker,
      },
    });
    const step = {
      organizationId: seed.organizationId,
      runId,
      taskId: seed.taskId,
      repositoryId: seed.repositoryId,
      requestedBy: fixture.adminId,
      traceId: crypto.randomUUID().replaceAll("-", ""),
      stepKey: "deliver.open",
      iteration: 1,
      action: "delivery.openPullRequest",
      input: { headBranch: "bakery/run-branch", title: "Run changes" },
    };
    assertEquals(runner.handles("delivery.openPullRequest"), true);
    const first = await runner.run(step);
    assertEquals(first.kind, "completed", JSON.stringify(first));
    const output =
      (first as { output: { runId: string; providerNumber: number } })
        .output;
    assertEquals(output.runId, runId);
    const again = await runner.run(step);
    assertEquals(again, first);
    assertEquals(fixture.github.openedPullRequests().length, 1);

    const invalid = await runner.run({
      ...step,
      input: { title: "No branch" },
    });
    assertEquals(invalid.kind, "failed");
    const legal = await runner.run({
      ...step,
      stepKey: "deliver.open-legal",
      input: { headBranch: "fix/#123", title: "Legal name" },
    });
    assertEquals(legal.kind, "completed", JSON.stringify(legal));
    const refused = await runner.run({
      ...step,
      stepKey: "deliver.open-bad",
      input: { headBranch: "a..b", title: "Bad name" },
    });
    assertEquals(
      [refused.kind, (refused as { message?: string }).message],
      ["failed", "branch_name_invalid"],
    );
  } finally {
    if (seed) {
      for (
        const table of [
          "pull_requests",
          "workflow_runs",
          "workflow_versions",
          "workflow_definitions",
        ]
      ) {
        await fixture.pgDatabase.query(
          `delete from bakery.${table} where organization_id = $1`,
          [seed.organizationId],
        );
      }
      await fixture.pgDatabase.query(
        "update bakery.repositories set active_profile_id = null where organization_id = $1",
        [seed.organizationId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.repository_profiles where organization_id = $1",
        [seed.organizationId],
      );
      await removeSeed(fixture, seed);
    }
    await fixture.finish();
  }
});
