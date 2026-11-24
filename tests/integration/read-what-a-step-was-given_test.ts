import { assertEquals } from "@std/assert";
import { readStepGiven } from "../../apps/server/src/modules/knowledge/step-given.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { openWorkerFixture } from "../helpers/worker-execution.ts";
import { compiled } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun } from "../helpers/plan-run.ts";

const gate = {
  id: "gate",
  uses: "quality.check",
  with: {
    repositoryId: "00000000-0000-4000-8000-0000000000a1",
    revision: "abc",
  },
  checks: ["fmt"],
};

type Db = Awaited<ReturnType<typeof openWorkerFixture>>["pgDatabase"];

async function seedStep(
  fixture: WorkerFixture,
): Promise<{ runId: string; stepKey: string }> {
  const document = await compiled([gate]);
  const probe = await seedPlanRun(fixture, document);
  return { runId: probe.job.runId, stepKey: probe.firstKey };
}

async function seedCitedVersion(
  fixture: WorkerFixture,
  runId: string,
): Promise<string> {
  const taskId = (await fixture.pgDatabase.query<{ taskId: string }>(
    `select task_id as "taskId" from bakery.workflow_runs where id = $1`,
    [runId],
  )).rows[0].taskId;
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
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

Deno.test("a step's given facts are served with their current state, its documents and whether it ran an agent", async () => {
  const fixture = await openWorkerFixture({});
  try {
    const seeded = await seedStep(fixture);
    const memoryNow = crypto.randomUUID();
    const memoryStopped = crypto.randomUUID();
    for (
      const [id, status] of [
        [memoryNow, "active"],
        [memoryStopped, "retired"],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `insert into bakery.memory_entries (id, organization_id, repository_id, topic, status)
         select $1::uuid, $2, repository_id, 'given read', $4
           from bakery.workflow_runs where id = $3`,
        [id, fixture.organizationId, seeded.runId, status],
      );
    }
    const revisionId = crypto.randomUUID();
    const source = await seedCitedVersion(fixture, seeded.runId);
    await fixture.pgDatabase.query(
      `insert into bakery.memory_revisions (
         id, organization_id, memory_id, revision, body,
         source_artifact_version_id, confidence, created_by
       ) values ($1,$2,$3,1,'newer wording',$4,0.9,$5)`,
      [
        revisionId,
        fixture.organizationId,
        memoryNow,
        source,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.memory_entries set current_revision_id = $2 where id = $1`,
      [memoryNow, revisionId],
    );

    const dispatch = JSON.stringify({
      facts: {
        facts: [{
          memoryId: memoryNow,
          revisionId: "00000000-0000-4000-8000-0000000000d5",
          wording: "corrected wording",
          recordedAt: "2026-11-20T10:00:00.000Z",
        }, {
          memoryId: memoryStopped,
          revisionId: "00000000-0000-4000-8000-0000000000d6",
          wording: "stopped wording",
          recordedAt: "2026-11-20T10:00:00.000Z",
        }, {
          memoryId: "00000000-0000-4000-8000-0000000000d7",
          revisionId: "00000000-0000-4000-8000-0000000000d8",
          wording: "gone wording",
          recordedAt: "2026-11-20T10:00:00.000Z",
        }],
        omitted: 4,
      },
    });
    await fixture.pgDatabase.query(
      `update bakery.run_steps set dispatch = $4::jsonb
        where organization_id = $1 and run_id = $2 and step_key = $3`,
      [fixture.organizationId, seeded.runId, seeded.stepKey, dispatch],
    );

    const given = await readStepGiven(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      runId: seeded.runId,
      stepKey: seeded.stepKey,
    });

    assertEquals(given?.stepKey, "gate");
    assertEquals(/^\d{4}-\d{2}-\d{2}/.test(given?.startedAt ?? ""), true);
    assertEquals(given?.ranAnAgent, true);
    assertEquals(given?.factsOmitted, 4);
    assertEquals(given?.facts.map((fact) => fact.state), [
      "corrected_since",
      "stopped_since",
      "stopped_since",
    ]);
    assertEquals(given?.facts.map((fact) => fact.wording), [
      "corrected wording",
      "stopped wording",
      "gone wording",
    ]);
    assertEquals(given?.documents, []);
    assertEquals(
      await readStepGiven(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        runId: seeded.runId,
        stepKey: "no-such-step",
      }),
      null,
    );
  } finally {
    await fixture.close();
  }
});
