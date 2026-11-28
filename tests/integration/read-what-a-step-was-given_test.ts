import { assertEquals, assertRejects } from "@std/assert";
import { readStepGiven } from "../../apps/server/src/modules/knowledge/step-given.ts";
import { createRunControlRegistry } from "../../apps/server/src/modules/execution/control.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
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
     values ($1,$2,$3,'research',$4)`,
    [
      artifactId,
      fixture.organizationId,
      taskId,
      `facts source ${artifactId}`,
    ],
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

Deno.test(
  "documents are served when the reader may read them, and only counted when not",
  () =>
    withWorkerFixture(async (fixture) => {
      const seeded = await seedStep(fixture);
      const readable = await seedCitedVersion(fixture, seeded.runId);
      const purged = await seedCitedVersion(fixture, seeded.runId);
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions set purged_at = now() where id = $1`,
        [purged],
      );
      for (const versionId of [readable, purged]) {
        await fixture.pgDatabase.query(
          `insert into bakery.run_input_pins (
             organization_id, run_id, artifact_id, artifact_version_id,
             sha256, size_bytes
           ) select $1, $2, v.artifact_id, v.id, v.sha256, v.size_bytes
               from bakery.artifact_versions v
              where v.organization_id = $1 and v.id = $3::uuid`,
          [fixture.organizationId, seeded.runId, versionId],
        );
      }

      const read = (readerMayRead: boolean) =>
        readStepGiven(fixture.pgDatabase, {
          organizationId: fixture.organizationId,
          runId: seeded.runId,
          stepKey: seeded.stepKey,
          readerMayRead,
        });

      const allowed = await read(true);
      assertEquals(allowed?.documents.length, 1);
      assertEquals(allowed?.documents[0].artifactVersionId, readable);
      assertEquals(allowed?.documents[0].state, "available");
      assertEquals(allowed?.documents[0].kind, "research");
      assertEquals(allowed?.documentsGone, 1);
      assertEquals(allowed?.documentsHidden, 0);

      const refused = await read(false);
      assertEquals(refused?.documents, []);
      assertEquals(refused?.documentsHidden, 2);
      assertEquals(refused?.documentsGone, 0);
      await releaseFacts(fixture);
    }),
);

Deno.test(
  "given facts are served with their current state, its documents and whether it ran an agent",
  () =>
    withWorkerFixture(async (fixture) => {
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
           select $1::uuid, $2, repository_id, 'given read ' || $4, $4
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
          readerMayRead: true,
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
        assertEquals(given?.documentsHidden, 0);
        assertEquals(given?.documentsGone, 0);
        assertEquals(given?.documentsUnchecked, 0);
      } finally {
        await releaseFacts(fixture);
      }
    }),
);

Deno.test(
  "the runSteps.given operation answers a started step and hides documents its reader cannot open",
  () =>
    withWorkerFixture(async (fixture) => {
      const seeded = await seedStep(fixture);
      const document = await seedCitedVersion(fixture, seeded.runId);
      await fixture.pgDatabase.query(
        `insert into bakery.run_input_pins (
           organization_id, run_id, artifact_id, artifact_version_id,
           sha256, size_bytes
         ) select $1, $2, v.artifact_id, v.id, v.sha256, v.size_bytes
             from bakery.artifact_versions v
            where v.organization_id = $1 and v.id = $3::uuid`,
        [fixture.organizationId, seeded.runId, document],
      );
      await fixture.pgDatabase.query(
        `update bakery.run_steps
            set started_at = '2026-11-24T16:42:07.890428Z'
          where organization_id = $1 and run_id = $2 and step_key = $3`,
        [fixture.organizationId, seeded.runId, seeded.stepKey],
      );

      const operation = createRunControlRegistry({
        database: fixture.pgDatabase,
        secret: "step-given-operation-secret",
      }).get("runSteps.given");
      const context = (
        stepKey: string,
        capabilities: readonly string[],
      ) =>
        ({
          transaction: fixture.pgDatabase,
          authority: {
            organizationId: fixture.organizationId,
            subject: {
              principalId: fixture.principalId,
              principalType: "human",
              displayName: "Grace Guest",
            },
            role: "guest",
            capabilities,
          },
          params: { id: seeded.runId, stepKey },
          requestId: "req-step-given",
          traceId: "trace-step-given",
        }) as unknown as ActionContext;
      const read = (stepKey: string, capabilities: readonly string[]) =>
        operation.handler(
          context(stepKey, capabilities),
          contractSchemas.StepGivenQuery.parse({}),
        );

      const withRead = contractSchemas.StepGiven.parse(
        await read(seeded.stepKey, ["runSteps.given", "artifactVersions.list"]),
      );
      assertEquals(withRead.stepKey, seeded.stepKey);
      assertEquals(
        withRead.startedAt,
        new Date("2026-11-24T16:42:07.890Z").toISOString(),
      );
      assertEquals(withRead.documents.map((entry) => entry.artifactVersionId), [
        document,
      ]);
      assertEquals(withRead.documentsHidden, 0);

      const withoutRead = contractSchemas.StepGiven.parse(
        await read(seeded.stepKey, ["runSteps.given"]),
      );
      assertEquals(withoutRead.documents, []);
      assertEquals(withoutRead.documentsHidden, 1);

      const refused = await assertRejects(
        async () => {
          await read("no-such-step", ["runSteps.given"]);
        },
        StandardError,
      ) as StandardError;
      assertEquals(refused.code, "RESOURCE_NOT_FOUND");
    }),
);

Deno.test(
  "a repeated step answers for the pass the reader names, and for its latest pass by default",
  () =>
    withWorkerFixture(async (fixture) => {
      const seeded = await seedStep(fixture);
      const firstPass = (await fixture.pgDatabase.query<{ id: string }>(
        `update bakery.run_steps
            set started_at = '2026-11-20T09:00:00Z',
                dispatch = '{"facts":{"facts":[],"omitted":1}}'::jsonb
          where organization_id = $1 and run_id = $2 and step_key = $3
          returning id`,
        [fixture.organizationId, seeded.runId, seeded.stepKey],
      )).rows[0].id;
      const secondPass = (await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.run_steps
         select (json_populate_record(
                   null::bakery.run_steps,
                   (to_jsonb(step) || jsonb_build_object(
                     'id', gen_random_uuid(),
                     'iteration', step.iteration + 1,
                     'started_at', '2026-11-21T09:00:00Z',
                     'dispatch', '{"facts":{"facts":[],"omitted":2}}'::jsonb
                   ))::json)).*
           from bakery.run_steps step
          where step.organization_id = $1 and step.id = $2
         returning id`,
        [fixture.organizationId, firstPass],
      )).rows[0].id;

      const read = (runStepId?: string) =>
        readStepGiven(fixture.pgDatabase, {
          organizationId: fixture.organizationId,
          runId: seeded.runId,
          stepKey: seeded.stepKey,
          ...(runStepId === undefined ? {} : { runStepId }),
          readerMayRead: true,
        });

      const latest = await read();
      assertEquals(latest?.startedAt, "2026-11-21T09:00:00.000Z");
      assertEquals(latest?.factsOmitted, 2);
      assertEquals(latest?.ranAnAgent, false);

      const named = await read(secondPass);
      assertEquals(named?.factsOmitted, 2);

      const earlier = await read(firstPass);
      assertEquals(earlier?.startedAt, "2026-11-20T09:00:00.000Z");
      assertEquals(earlier?.factsOmitted, 1);
      assertEquals(earlier?.ranAnAgent, true);

      assertEquals(await read(crypto.randomUUID()), null);
    }),
);

async function releaseFacts(fixture: WorkerFixture) {
  const entries = await fixture.pgDatabase.query<{ id: string }>(
    "update bakery.memory_entries set current_revision_id = null where organization_id = $1 returning id",
    [fixture.organizationId],
  );
  if (entries.rows.length === 0) return;
  await fixture.pgDatabase.query(
    "delete from bakery.memory_revisions where organization_id = $1",
    [fixture.organizationId],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.memory_entries where organization_id = $1",
    [fixture.organizationId],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.run_input_pins where organization_id = $1",
    [fixture.organizationId],
  );
}
