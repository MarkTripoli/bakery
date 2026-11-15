import { assert, assertEquals } from "@std/assert";
import type { Inngest } from "inngest";
import { createBakeryFixedWorkflow } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { rows, seedPlanRun, setRow, state } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";

// #397. A step whose action the registry declares `projection_only`
// (`delivery.candidate_evidence`) has no worker: the engine function completes
// it in its own pass. This drives the production engine function, with a fake
// durable step so the order of its steps is visible, over a plan whose last
// step is such a projection: it completes the run without ever waiting for a
// job, and writes the candidate it was given as the step's output.

const EVIDENCE = {
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
  policyDigest: "c".repeat(64),
  checksPassed: true,
  checkRunIds: ["00000000-0000-4000-8000-0000000000c1"],
  failedCheckIds: [],
  blockingFindings: 0,
  reviewId: "00000000-0000-4000-8000-0000000000b1",
  findings: [],
};

const plan = () =>
  compiled([
    noop("first"),
    {
      id: "project",
      needs: ["first"],
      uses: "delivery.candidate_evidence",
      with: EVIDENCE,
    },
  ]);

type Handler = (
  context: { event: unknown; step: FakeStep },
) => Promise<unknown>;
type FakeStep = {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
  waitForEvent(id: string, options: unknown): Promise<unknown>;
  sendEvent(id: string, event: unknown): Promise<void>;
};

function engineFor(fixture: WorkerFixture): Handler {
  const captured: { handler?: Handler } = {};
  const client = {
    createFunction(_config: unknown, handler: Handler) {
      captured.handler = handler;
      return {};
    },
  } as unknown as Inngest;
  createBakeryFixedWorkflow({
    client,
    database: fixture.pgDatabase,
    maxAttempts: 3,
    waitMs: 10,
    jobCompletionTimeout: "1m",
    engineRetries: 3,
  });
  assert(captured.handler !== undefined);
  return captured.handler;
}

function recordingStep(record: string[]): FakeStep {
  return {
    run: async (id, work) => {
      record.push(id);
      return JSON.parse(JSON.stringify((await work()) ?? null));
    },
    sleep: (id) => {
      record.push(id);
      return Promise.resolve();
    },
    // A job completion nobody posts: reaching it means the step had a job.
    waitForEvent: (id) => {
      record.push(id);
      return Promise.reject(new Error("the engine waited for a job"));
    },
    sendEvent: (id) => {
      record.push(id);
      return Promise.resolve();
    },
  };
}

Deno.test("the engine function completes a projection step itself, never waits for a job, and finishes the plan run", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedPlanRun(fixture, await plan());
    await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
    await seeded.repository.releaseEngineOwner(seeded.owner);

    const record: string[] = [];
    const result = await engineFor(fixture)({
      event: {
        id: `projection-${crypto.randomUUID()}`,
        data: { payload: { runId: seeded.job.runId } },
      },
      step: recordingStep(record),
    });
    assertEquals(result, { status: "completed" });
    assertEquals(
      record.filter((id) => id.startsWith("wait-for-job")),
      [],
    );

    const all = await rows(fixture, seeded);
    assertEquals(all.map((row) => row.stepKey), [seeded.firstKey, "project"]);
    const projected = (await fixture.pgDatabase.query<{
      status: string;
      output: unknown;
    }>(
      `select status, output from bakery.run_steps
        where run_id = $1 and step_key = 'project'`,
      [seeded.job.runId],
    )).rows[0];
    assertEquals(projected.status, "completed");
    assertEquals(projected.output, EVIDENCE);
    const jobs = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.jobs job
         join bakery.run_steps step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
        where step.run_id = $1 and step.step_key = 'project'`,
      [seeded.job.runId],
    );
    assertEquals(jobs.rows[0].count, "0");
    assertEquals((await state(fixture, seeded)).run.status, "completed");
  }));
