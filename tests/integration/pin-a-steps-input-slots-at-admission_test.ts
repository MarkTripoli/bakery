import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";

// #527: a step's declared input slots are pinned when its job is admitted. The
// job carries the pins, the claim hands them to the worker on the assignment,
// and a slot that cannot be pinned fails the step before any job exists.

const RUN_REPO = "00000000-0000-4000-8000-0000000000a1";

const gate = (extra: Record<string, unknown> = {}) => ({
  id: "gate",
  needs: ["first"],
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
  ...extra,
});

const withBrief = gate({
  inputs: [{ name: "brief", from: "$input.brief" }],
});

const DECLARED = {
  repo: { type: "uuid", required: true },
  brief: { type: "uuid", required: true },
};

async function seedVersion(
  fixture: WorkerFixture,
  taskId: string,
  versionId: string,
  text: string,
) {
  const artifactId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Bytes(bytes);
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name)
     values ($1,$2,$3,'document',$4)`,
    [artifactId, fixture.organizationId, taskId, `Brief ${artifactId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions
       (id,organization_id,artifact_id,task_id,author_id,revision,content,
        sha256,size_bytes,media_type,retention_class)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'text/markdown','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      bytes,
      sha256,
      bytes.length,
    ],
  );
  return { artifactId, sha256, sizeBytes: bytes.length };
}

/** A run whose first step is done and whose `gate` step is ready to admit. */
async function seedGate(
  fixture: WorkerFixture,
  step: Record<string, unknown>,
  briefVersionId: string,
) {
  const document = await compiled([noop("first"), step], DECLARED);
  const probe = await seedPlanRun(fixture, document, {
    inputs: { repo: RUN_REPO, brief: briefVersionId },
  });
  const repo = (await fixture.pgDatabase.query<{ repositoryId: string }>(
    `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
    [probe.job.runId],
  )).rows[0].repositoryId;
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
      where id = $1`,
    [probe.job.runId, repo],
  );
  await setRow(fixture, probe, probe.firstKey, "completed", {});
  const key = await probe.repository.findNext(probe.job.runId, probe.owner);
  assert(key !== undefined);
  assertEquals(key.stepKey, "gate");
  return { ...probe, key };
}

const gateJob = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<
    { id: string; contextInputs: unknown }
  >(
    `select job.id, job.context_inputs as "contextInputs"
       from bakery.jobs job
       join bakery.run_steps step on step.id = job.run_step_id
      where step.run_id = $1 and step.step_key = 'gate'`,
    [runId],
  )).rows;

async function claimGate(
  fixture: WorkerFixture,
  seeded: Awaited<ReturnType<typeof seedGate>>,
  name: string,
) {
  // The fixture's own first job is finished; only the gate's job is left.
  await fixture.pgDatabase.query(
    `update bakery.jobs set status = 'completed'
      where run_step_id in (select id from bakery.run_steps
                             where run_id = $1 and step_key <> 'gate')`,
    [seeded.job.runId],
  );
  const worker = await registeredWorker(fixture, { name });
  return await claimAssignment(fixture, worker);
}

Deno.test("admission pins a declared slot onto the job and the claim hands it to the worker", () =>
  withWorkerFixture(async (fixture) => {
    const versionId = crypto.randomUUID();
    const seeded = await seedGate(fixture, withBrief, versionId);
    const version = await seedVersion(
      fixture,
      seeded.job.taskId,
      versionId,
      "# The brief",
    );
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    assertEquals(admission.terminal, false);

    const expected = [{
      slot: "brief",
      path: "brief.md",
      digest: version.sha256,
      sizeBytes: version.sizeBytes,
      mediaType: "text/markdown",
      kind: null,
    }];
    const jobs = await gateJob(fixture, seeded.job.runId);
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].contextInputs, expected);

    // The version is pinned for the run, so the context route serves exactly it.
    const pins = (await fixture.pgDatabase.query<
      { artifactVersionId: string; sha256: string }
    >(
      `select artifact_version_id as "artifactVersionId", sha256
         from bakery.run_input_pins where run_id = $1`,
      [seeded.job.runId],
    )).rows;
    assertEquals(pins, [{
      artifactVersionId: versionId,
      sha256: version.sha256,
    }]);

    const assignment = await claimGate(fixture, seeded, "context-pin-claim");
    assertEquals(assignment.jobId, admission.jobId);
    assertEquals(
      (assignment as unknown as { contextInputs?: unknown }).contextInputs,
      expected,
    );
  }));

Deno.test("a step with no declared slot has no pins and an assignment without the field", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture, gate(), crypto.randomUUID());
    await seeded.repository.admit(seeded.key, seeded.owner);
    const jobs = await gateJob(fixture, seeded.job.runId);
    assertEquals(jobs[0].contextInputs, []);
    const assignment = await claimGate(fixture, seeded, "context-pin-none");
    assertEquals(Object.hasOwn(assignment, "contextInputs"), false);
  }));

Deno.test("a slot whose artifact version does not exist fails the step and creates no job", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture, withBrief, crypto.randomUUID());
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    assertEquals(admission.terminal, true);
    assertEquals((await gateJob(fixture, seeded.job.runId)).length, 0);
    const step = (await fixture.pgDatabase.query<
      { status: string; detail: string }
    >(
      `select status, to_jsonb(step)::text as detail
         from bakery.run_steps step
        where run_id = $1 and step_key = 'gate'`,
      [seeded.job.runId],
    )).rows[0];
    assertEquals(step.status, "failed");
    assert(step.detail.includes("STEP_INPUT_UNAVAILABLE"), step.detail);
    assertEquals(
      (await fixture.pgDatabase.query(
        `select 1 from bakery.run_input_pins where run_id = $1`,
        [seeded.job.runId],
      )).rows.length,
      0,
      "a refused slot leaves no pin behind",
    );
  }));
