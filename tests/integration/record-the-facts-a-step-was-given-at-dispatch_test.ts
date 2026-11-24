import { assert, assertEquals } from "@std/assert";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";

const RUN_REPO = "00000000-0000-4000-8000-0000000000a1";

const gate = {
  id: "gate",
  needs: ["first"],
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
};

const DECLARED = { repo: { type: "uuid", required: true } };

async function seedCitedVersion(fixture: WorkerFixture): Promise<string> {
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1,$2,$3,'Facts source')`,
    [applicationId, fixture.organizationId, `app-${applicationId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
     values ($1,$2,$3,'Facts source',$4)`,
    [
      conversationId,
      fixture.organizationId,
      applicationId,
      fixture.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (id, organization_id, application_id, conversation_id,
       title, task_type, status, priority, created_by)
     values ($1,$2,$3,$4,'Facts source','feature','active',50,$5)`,
    [
      taskId,
      fixture.organizationId,
      applicationId,
      conversationId,
      fixture.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
     values ($1,$2,$3,'research','facts source')`,
    [artifactId, fixture.organizationId, taskId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions (
       id, organization_id, artifact_id, task_id, author_id, revision,
       metadata, content, sha256, size_bytes, media_type
     ) values ($1,$2,$3,$4,$5,1,'{}'::jsonb,$6,$7,1,'text/plain')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      new Uint8Array([1]),
      "a".repeat(64),
    ],
  );
  return versionId;
}

async function seedFact(
  fixture: WorkerFixture,
  input: { repositoryId: string; body: string; sourceVersionId: string },
): Promise<{ memoryId: string; revisionId: string }> {
  const memoryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.memory_entries
       (id, organization_id, repository_id, topic, status, created_at, updated_at)
     values ($1,$2,$3,$4,'active','2026-11-20T10:00:00.000Z','2026-11-20T10:00:00.000Z')`,
    [memoryId, fixture.organizationId, input.repositoryId, `topic ${memoryId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.memory_revisions (
       id, organization_id, memory_id, revision, body,
       source_artifact_version_id, confidence, created_by, created_at
     ) values ($1,$2,$3,1,$4,$5,0.9,$6,'2026-11-20T10:00:00.000Z')`,
    [
      revisionId,
      fixture.organizationId,
      memoryId,
      input.body,
      input.sourceVersionId,
      fixture.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    "update bakery.memory_entries set current_revision_id = $2 where id = $1",
    [memoryId, revisionId],
  );
  return { memoryId, revisionId };
}

Deno.test("dispatch records the facts the step's agent was given, with their revision and time", () =>
  withWorkerFixture(async (fixture) => {
    const document = await compiled([noop("first"), gate], DECLARED);
    const probe = await seedPlanRun(fixture, document, {
      inputs: { repo: RUN_REPO },
    });
    const repositoryId = (await fixture.pgDatabase.query<{
      repositoryId: string;
    }>(
      `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
      [probe.job.runId],
    )).rows[0].repositoryId;
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
        where id = $1`,
      [probe.job.runId, repositoryId],
    );
    const fact = await seedFact(fixture, {
      repositoryId,
      body: "Tests run with pnpm.",
      sourceVersionId: await seedCitedVersion(fixture),
    });
    // The seed's rows hold the cited version open, and the fixture's teardown
    // deletes versions: release them once the assertion has been made.
    try {
      await setRow(fixture, probe, probe.firstKey, "completed", {});
      const key = await probe.repository.findNext(probe.job.runId, probe.owner);
      assert(key !== undefined);
      const admission = await probe.repository.admit(key, probe.owner);
      assertEquals(admission.terminal, false);

      const recorded = (await fixture.pgDatabase.query<{ facts: unknown }>(
        `select dispatch -> 'facts' as facts from bakery.run_steps
        where run_id = $1 and step_key = 'gate'`,
        [probe.job.runId],
      )).rows[0].facts as {
        facts: Array<{
          memoryId: string;
          revisionId: string;
          wording: string;
          recordedAt: string;
        }>;
        omitted: number;
      };
      assertEquals(recorded.facts.length, 1);
      assertEquals(recorded.omitted, 0);
      assertEquals(recorded.facts[0].memoryId, fact.memoryId);
      assertEquals(recorded.facts[0].revisionId, fact.revisionId);
      assertEquals(recorded.facts[0].wording, "Tests run with pnpm.");
      assertEquals(recorded.facts[0].recordedAt.startsWith("2026-11-20"), true);
    } finally {
      await fixture.pgDatabase.query(
        "update bakery.memory_entries set current_revision_id = null where id = $1",
        [fact.memoryId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.memory_revisions where memory_id = $1",
        [fact.memoryId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.memory_entries where id = $1",
        [fact.memoryId],
      );
    }
  }));
