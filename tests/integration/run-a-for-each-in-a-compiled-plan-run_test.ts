import { assertEquals } from "@std/assert";
import { rows, seedPlanRun, setRow, state } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { compiled, type Step } from "../helpers/workflow-interpreter.ts";

// #417. A plan run admitted now is pinned to interpreter revision 3, and the
// engine runs a forEach with no code of its own: each iteration's steps are
// appended as rows keyed `<loop>@n.<step>`, one at a time, their input read
// from the item; a list longer than the loop's max fails the run before any
// iteration runs.

/** A step a worker can run: a quality check of the run's own repository. */
const check = (id: string, extra: Step = {}): Step => ({
  id,
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
  ...extra,
});

const inputs = { repo: { type: "uuid", required: true } } as const;

/** `prepare` lists the cases; the loop checks each case's revision. */
const plan = (max: number) =>
  compiled([
    check("prepare"),
    {
      id: "cases",
      forEach: {
        items: "$step.prepare.checkRunIds",
        max,
        as: "case",
        steps: [
          check("run_case", {
            with: { repositoryId: "$input.repo", revision: "$each.case" },
          }),
        ],
      },
    },
    check("after", { needs: ["cases"] }),
  ], inputs);

async function seedRun(fixture: WorkerFixture, max: number) {
  const seeded = await seedPlanRun(fixture, await plan(max), {
    inputs: { repo: "00000000-0000-4000-8000-0000000000a1" },
  });
  const repo = (await fixture.pgDatabase.query<{ repositoryId: string }>(
    `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
    [seeded.job.runId],
  )).rows[0].repositoryId;
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
      where id = $1`,
    [seeded.job.runId, repo],
  );
  return { seeded, repo };
}

const CASE_A = "rev-case-a";
const CASE_B = "rev-case-b";

Deno.test("a new plan run is pinned to revision 4 and runs each item of a forEach as its own keyed step", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded, repo } = await seedRun(fixture, 4);
    const pin = (await fixture.pgDatabase.query<{ revision: string }>(
      `select snapshot #>> '{runtime,pin,interpreterRevision}' as revision
         from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].revision;
    assertEquals(pin, "4");
    assertEquals(seeded.firstKey, "prepare");

    const next = async () =>
      (await seeded.repository.findNext(seeded.job.runId, seeded.owner))
        ?.stepKey;
    await setRow(fixture, seeded, "prepare", "completed", {
      checkRunIds: [CASE_A, CASE_B],
    });
    assertEquals(await next(), "cases@1.run_case");
    // Asked again before it ends: the same step, no new row.
    assertEquals(await next(), "cases@1.run_case");
    await setRow(fixture, seeded, "cases@1.run_case", "completed", {});
    assertEquals(await next(), "cases@2.run_case");
    await setRow(fixture, seeded, "cases@2.run_case", "completed", {});
    assertEquals(await next(), "after");
    await setRow(fixture, seeded, "after", "completed", {});
    assertEquals(await next(), undefined);

    const stored = await rows(fixture, seeded);
    assertEquals(stored.map((row) => [row.stepKey, row.status]), [
      ["prepare", "completed"],
      ["cases@1.run_case", "completed"],
      ["cases@2.run_case", "completed"],
      ["after", "completed"],
    ]);
    // Each iteration's input was read from its own item.
    const inputOf = (key: string) =>
      stored.find((row) => row.stepKey === key)!.input;
    assertEquals(inputOf("cases@1.run_case"), {
      repositoryId: repo,
      revision: CASE_A,
      checks: ["fmt"],
    });
    assertEquals(inputOf("cases@2.run_case"), {
      repositoryId: repo,
      revision: CASE_B,
      checks: ["fmt"],
    });
    assertEquals((await state(fixture, seeded)).run.status, "completed");
  }));

Deno.test("a list longer than the loop's max fails the run before any iteration runs", () =>
  withWorkerFixture(async (fixture) => {
    const { seeded } = await seedRun(fixture, 1);
    await setRow(fixture, seeded, "prepare", "completed", {
      checkRunIds: [CASE_A, CASE_B],
    });
    assertEquals(
      await seeded.repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    assertEquals(
      (await rows(fixture, seeded)).map((row) => row.stepKey),
      ["prepare"],
    );
    assertEquals((await state(fixture, seeded)).run.status, "failed");
  }));
