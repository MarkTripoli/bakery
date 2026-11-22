import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { decideResume } from "../../apps/server/src/modules/workflow-adapter/resume-decision.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, noop, REPO_ID } from "../helpers/workflow-interpreter.ts";

// #43 slice 3. A delivery step is settled by the engine in its admission, like a
// projection: no worker job. The target is called between two short
// transactions; a step that is not done keeps its row pending with the time of
// its next look, so the engine's existing retry path sleeps through it, and a
// step that crashed after the call replays into the same effect.

const SHA = "a".repeat(40);
const PREPARED = {
  releaseId: "release-1",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  environment: "staging",
  status: "prepared",
};

const plan = () =>
  compiled([
    noop("first"),
    {
      id: "prep",
      uses: "delivery.prepare",
      needs: ["first"],
      with: { repositoryId: REPO_ID, headSha: SHA, profileRevision: 1 },
    },
  ]);

async function atTheDeliveryStep(fixture: WorkerFixture) {
  const seeded = await seedPlanRun(fixture, await plan());
  await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
  return seeded;
}

function repositoryWith(
  fixture: WorkerFixture,
  engineSteps?: EngineStepRunner,
) {
  return createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
    ...(engineSteps ? { engineSteps } : {}),
  });
}

const step = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{
    status: string;
    output: unknown;
    error: unknown;
    retryAt: string | null;
  }>(
    `select status, output, error,
            dispatch ->> 'stepRetryAt' as "retryAt"
       from bakery.run_steps where run_id = $1 and step_key = 'prep'`,
    [runId],
  )).rows[0];

const audits = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{ operation: string }>(
    `select operation from bakery.audit_events
      where details ->> 'runId' = $1 and operation like 'workflow.%'
      order by created_at`,
    [runId],
  )).rows.map((row) => row.operation);

Deno.test("a delivery step the target completes is written by the engine with no job (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheDeliveryStep(fixture);
    const seen: EngineStepRequest[] = [];
    const runner: EngineStepRunner = {
      handles: () => true,
      run: (request) => {
        seen.push(request);
        return Promise.resolve({ kind: "completed", output: PREPARED });
      },
    };
    const repository = repositoryWith(fixture, runner);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    assertEquals(key.stepKey, "prep");
    const admitted = await repository.admit(key, seeded.owner);
    assertEquals(admitted.terminal, true);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].action, "delivery.prepare");
    assertEquals(seen[0].stepKey, "prep");
    assertEquals(seen[0].runId, seeded.job.runId);
    const row = await step(fixture, seeded.job.runId);
    assertEquals(row.status, "completed");
    assertEquals(row.output, PREPARED);
    assert(
      (await audits(fixture, seeded.job.runId)).includes(
        "workflow.step.complete",
      ),
    );
    const jobs = await fixture.pgDatabase.query(
      `select 1 from bakery.jobs j join bakery.run_steps s
         on s.organization_id = j.organization_id and s.id = j.run_step_id
        where s.run_id = $1 and s.step_key = 'prep'`,
      [seeded.job.runId],
    );
    assertEquals(jobs.rows.length, 0, "no worker job was made");
  }));

Deno.test("a step that is not done stays pending, reads as retryable until its next look, then is admitted again and finishes (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheDeliveryStep(fixture);
    let calls = 0;
    const runner: EngineStepRunner = {
      handles: () => true,
      run: (): Promise<EngineStepResult> => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? { kind: "pending" }
            : { kind: "completed", output: PREPARED },
        );
      },
    };
    const repository = repositoryWith(fixture, runner);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    const first = await repository.admit(key, seeded.owner);
    assertEquals(first.terminal, false);
    const waiting = await step(fixture, seeded.job.runId);
    assertEquals(waiting.status, "pending");
    assert(waiting.retryAt !== null, "the next look is recorded on the row");
    assert(new Date(waiting.retryAt).getTime() > Date.now());

    // Until it is due the engine reads the step as retryable: it sleeps.
    const state = await repository.read(key, seeded.owner);
    const decision = decideResume(key, state, new Date());
    assertEquals(decision.kind, "retryable");
    assertEquals(calls, 1);

    // Once due it reads as not admitted, so the engine admits it again.
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set dispatch = jsonb_set(dispatch, '{stepRetryAt}',
                                   to_jsonb('2020-01-01T00:00:00.000Z'::text))
        where run_id = $1 and step_key = 'prep'`,
      [seeded.job.runId],
    );
    const due = decideResume(
      key,
      await repository.read(key, seeded.owner),
      new Date(),
    );
    assertEquals(due.kind, "newly-admit");
    const second = await repository.admit(key, seeded.owner);
    assertEquals(second.terminal, true);
    assertEquals(calls, 2);
    assertEquals((await step(fixture, seeded.job.runId)).status, "completed");
  }));

Deno.test("a step that keeps answering not done is failed with a stable code once its wait limit passes (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheDeliveryStep(fixture);
    let calls = 0;
    const runner: EngineStepRunner = {
      handles: () => true,
      run: (): Promise<EngineStepResult> => {
        calls += 1;
        return Promise.resolve({ kind: "pending" });
      },
    };
    const repository = repositoryWith(fixture, runner);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    assertEquals((await repository.admit(key, seeded.owner)).terminal, false);
    const waitingSince = (await fixture.pgDatabase.query<{ since: string }>(
      `select dispatch ->> 'stepWaitingSince' as since
         from bakery.run_steps where run_id = $1 and step_key = 'prep'`,
      [seeded.job.runId],
    )).rows[0].since;
    assert(waitingSince !== null, "the first wait is recorded on the row");

    // A later answer of not done keeps the first time and does not fail yet.
    assertEquals((await repository.admit(key, seeded.owner)).terminal, false);
    assertEquals(
      (await fixture.pgDatabase.query<{ since: string }>(
        `select dispatch ->> 'stepWaitingSince' as since
           from bakery.run_steps where run_id = $1 and step_key = 'prep'`,
        [seeded.job.runId],
      )).rows[0].since,
      waitingSince,
    );
    assertEquals((await step(fixture, seeded.job.runId)).status, "pending");

    // Past the limit the same answer ends the step instead of waiting again.
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set dispatch = jsonb_set(dispatch, '{stepWaitingSince}',
                                   to_jsonb('2020-01-01T00:00:00.000Z'::text))
        where run_id = $1 and step_key = 'prep'`,
      [seeded.job.runId],
    );
    assertEquals((await repository.admit(key, seeded.owner)).terminal, true);
    assertEquals(calls, 3);
    const row = await step(fixture, seeded.job.runId);
    assertEquals(row.status, "failed");
    assert(JSON.stringify(row.error).includes("ENGINE_STEP_TIMED_OUT"));
  }));

Deno.test("a refusal fails the step with its stable code, and no configured runner fails it the same way (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const refused = await atTheDeliveryStep(fixture);
    const runner: EngineStepRunner = {
      handles: () => true,
      run: () =>
        Promise.resolve({
          kind: "failed",
          code: "DELIVERY_PREPARE_ARTIFACT_MISSING",
          message: "The target could not prepare the release.",
        }),
    };
    const repository = repositoryWith(fixture, runner);
    const key = await repository.findNext(refused.job.runId, refused.owner);
    assert(key !== undefined);
    assertEquals((await repository.admit(key, refused.owner)).terminal, true);
    const row = await step(fixture, refused.job.runId);
    assertEquals(row.status, "failed");
    assert(
      JSON.stringify(row.error).includes("DELIVERY_PREPARE_ARTIFACT_MISSING"),
    );
  }));

Deno.test("with no runner configured a delivery step fails with a stable code instead of waiting for a worker nobody has (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheDeliveryStep(fixture);
    const repository = repositoryWith(fixture);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    assertEquals((await repository.admit(key, seeded.owner)).terminal, true);
    const row = await step(fixture, seeded.job.runId);
    assertEquals(row.status, "failed");
    assert(JSON.stringify(row.error).includes("ENGINE_STEP_UNAVAILABLE"));
  }));

Deno.test("a crash after the target answered and before the step was written leaves the step pending and replays it (#43)", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await atTheDeliveryStep(fixture);
    let calls = 0;
    const runner: EngineStepRunner = {
      handles: () => true,
      run: (): Promise<EngineStepResult> => {
        calls += 1;
        // The first call dies after its effect, as a killed process would: the
        // engine never hears the answer and writes nothing.
        if (calls === 1) return Promise.reject(new Error("process killed"));
        return Promise.resolve({ kind: "completed", output: PREPARED });
      },
    };
    const repository = repositoryWith(fixture, runner);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    let failure: unknown;
    try {
      await repository.admit(key, seeded.owner);
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error, "the crash reaches the caller");
    const after = await step(fixture, seeded.job.runId);
    assertEquals(
      after.status,
      "pending",
      "nothing was written for the lost answer",
    );
    assertEquals(after.retryAt, null);
    // The engine function is retried: the same step key reaches the runner again.
    const replayed = await repository.admit(key, seeded.owner);
    assertEquals(replayed.terminal, true);
    assertEquals(calls, 2);
    assertEquals((await step(fixture, seeded.job.runId)).status, "completed");
  }));
