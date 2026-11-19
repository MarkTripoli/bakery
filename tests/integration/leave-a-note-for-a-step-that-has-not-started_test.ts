import { assert, assertEquals } from "@std/assert";
import { buildWorkflowPlan } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { WorkflowSemanticDocumentSchema } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  presetBudgetPolicy,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";

// #412 slice 2. Chapter 25 section 9: "notes for steps not yet started". A step
// with no session cannot be steered, so a person leaves a note and the agent
// that runs the step receives it once, with its input. These tests drive the
// real operation and the real admission, and prove "once".

type RunBody = { id: string };
type NoteBody = { id: string; runId: string; stepKey: string; body: string };

const withFixture = <T>(work: Parameters<typeof withWorkerFixture<T>>[0]) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];

async function startedRun(fixture: Fixture, label: string) {
  const agent = await seedFundedCodingAgent(fixture, fixture, label);
  const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
    agentVersionId: agent,
  });
  const task = await createPresetTask(fixture, fixture, repository);
  const run = await expectJson<RunBody>(
    await startPresetRun(fixture, fixture, task, repository),
    201,
  );
  // The plan's first step has no row until the engine dispatches it.
  const snapshot = (await fixture.pgDatabase.query<{ snapshot: unknown }>(
    `select snapshot from bakery.workflow_runs where id = $1`,
    [run.id],
  )).rows[0].snapshot as { runtime: { document: unknown } };
  const document = WorkflowSemanticDocumentSchema.parse(
    snapshot.runtime.document,
  );
  const firstKey = buildWorkflowPlan(document).steps[0].keyTemplate;
  return { run, firstKey };
}

const note = (
  fixture: Fixture,
  runId: string,
  stepKey: string,
  body: unknown,
  idempotencyKey?: string,
) =>
  apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/runs/${runId}/steps/${stepKey}/notes`,
    { body, idempotencyKey },
  );

async function admitFirstStep(fixture: Fixture, runId: string) {
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 1,
    budgetPolicy: presetBudgetPolicy,
  });
  const owner = await repository.acquireEngineOwner(
    runId,
    crypto.randomUUID(),
    60_000,
  );
  assert(owner);
  const key = await repository.findNext(runId, owner);
  assert(key !== undefined, "the run has a first step");
  const admission = await repository.admit(key, owner);
  return { repository, owner, key, admission };
}

const jobFor = async (fixture: Fixture, runId: string) =>
  (await fixture.pgDatabase.query<
    { id: string; input: { stepNotes?: string[] } }
  >(
    `select job.id, job.input from bakery.jobs job
       join bakery.run_steps step on step.id = job.run_step_id
      where step.run_id = $1`,
    [runId],
  )).rows;

const deliveries = async (fixture: Fixture, runId: string) =>
  (await fixture.pgDatabase.query<{ noteId: string }>(
    `select delivery.note_id as "noteId"
       from bakery.run_step_note_deliveries delivery
       join bakery.run_step_notes note on note.id = delivery.note_id
      where note.run_id = $1`,
    [runId],
  )).rows;

Deno.test("AC: a note left before a step starts is handed to its job once, and recorded in the ledger", () =>
  withFixture(async (fixture) => {
    const { run, firstKey } = await startedRun(fixture, "note-once");

    const response = await note(fixture, run.id, firstKey, {
      body: "Prefer the existing helper.",
    });
    assertEquals(response.status, 201);
    const created = await response.json() as NoteBody;
    assertEquals(created.runId, run.id);
    assertEquals(created.stepKey, firstKey);

    const ledger = await fixture.pgDatabase.query<
      { text: string; kind: string; mode: string }
    >(
      `select text, kind, detail->>'mode' as mode
         from bakery.decisions_ledger where run_id = $1 and kind = 'steer'`,
      [run.id],
    );
    assertEquals(ledger.rows.length, 1);
    assertEquals(ledger.rows[0].text, "Prefer the existing helper.");
    assertEquals(ledger.rows[0].mode, "note");

    const first = await admitFirstStep(fixture, run.id);
    assert(first.admission.jobId, "the step is admitted with a job");
    const [job] = await jobFor(fixture, run.id);
    assertEquals(job.input.stepNotes, ["Prefer the existing helper."]);
    assertEquals((await deliveries(fixture, run.id)).length, 1);

    // Admitting the same step again must not hand the note over a second time.
    await first.repository.admit(first.key, first.owner);
    const jobs = await jobFor(fixture, run.id);
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].input.stepNotes, ["Prefer the existing helper."]);
    assertEquals((await deliveries(fixture, run.id)).length, 1);
  }));

Deno.test("AC: a started step refuses a note, and a replayed note is not written twice", () =>
  withFixture(async (fixture) => {
    const { run, firstKey } = await startedRun(fixture, "note-started");
    const key = crypto.randomUUID();
    const body = { body: "First.", clientNoteId: crypto.randomUUID() };

    const first = await note(fixture, run.id, firstKey, body, key);
    const replay = await note(fixture, run.id, firstKey, body, key);
    assertEquals(first.status, 201);
    assert(replay.status < 300);
    assertEquals(
      (await replay.json() as NoteBody).id,
      (await first.json() as NoteBody).id,
    );
    const count = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_step_notes where run_id = $1`,
      [run.id],
    );
    assertEquals(count.rows[0].n, "1");

    await admitFirstStep(fixture, run.id);
    const late = await note(fixture, run.id, firstKey, { body: "Too late." });
    assertEquals(late.status, 409);
    const after = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_step_notes where run_id = $1`,
      [run.id],
    );
    assertEquals(after.rows[0].n, "1");
  }));

Deno.test("AC: a step the plan does not declare is not found, and unstorable text is a 400", () =>
  withFixture(async (fixture) => {
    const { run, firstKey } = await startedRun(fixture, "note-unknown");

    const missing = await note(fixture, run.id, "no-such-step", { body: "x" });
    assertEquals(missing.status, 404);
    const bad = await note(fixture, run.id, firstKey, { body: "bad \ud800" });
    assertEquals(bad.status, 400);

    const none = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_step_notes where run_id = $1`,
      [run.id],
    );
    assertEquals(none.rows[0].n, "0");
  }));
