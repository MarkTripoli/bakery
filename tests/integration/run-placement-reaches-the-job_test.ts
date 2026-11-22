import { assert, assertEquals } from "@std/assert";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";

// #428. Placement is data on the run (migration 0335): the requirements it
// records join every job's own when the engine admits a step. The ledger
// migration (0336) adds a kind beside model usage. Both run on a fresh
// database, because the fixture applies every migration to an empty one.

const plan = () =>
  compiled([
    noop("first"),
    {
      id: "gate",
      needs: ["first"],
      uses: "quality.check",
      with: { repositoryId: "$input.repo", revision: "abc" },
      checks: ["fmt"],
    },
  ], { repo: { type: "uuid", required: true } });

async function seedGate(fixture: WorkerFixture) {
  const probe = await seedPlanRun(fixture, await plan(), {
    inputs: { repo: "00000000-0000-4000-8000-0000000000a1" },
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
  return { ...probe, key };
}

const jobRequirements = async (fixture: WorkerFixture, jobId: string) =>
  (await fixture.pgDatabase.query<{
    requirements: { capabilities: string[]; platform?: string };
  }>(`select requirements from bakery.jobs where id = $1`, [jobId]))
    .rows[0].requirements;

Deno.test("a run with no recorded placement dispatches exactly the job's own requirements", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    const placement = (await fixture.pgDatabase.query<{ placement: unknown }>(
      `select placement from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].placement;
    assertEquals(placement, {});
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    assert(admission.jobId !== undefined);
    const requirements = await jobRequirements(fixture, admission.jobId);
    assert(requirements.capabilities.includes("git"));
    assertEquals(requirements.capabilities.includes("gpu"), false);
  }));

Deno.test("the run's recorded placement is merged into the job's requirements at dispatch", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedGate(fixture);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set placement = $2::jsonb where id = $1`,
      [
        seeded.job.runId,
        JSON.stringify({
          requirements: { capabilities: ["gpu"], platform: "linux" },
          affinityKey: "run-affinity",
        }),
      ],
    );
    const admission = await seeded.repository.admit(seeded.key, seeded.owner);
    assert(admission.jobId !== undefined);
    const requirements = await jobRequirements(fixture, admission.jobId);
    assert(requirements.capabilities.includes("git"), "the job's own stay");
    assert(requirements.capabilities.includes("gpu"), "the run's join them");
    assertEquals(requirements.platform, "linux");
  }));

Deno.test("migration 0336 adds a kind that defaults to model and frees model and provider_call_id for other kinds", () =>
  withWorkerFixture(async (fixture) => {
    const columns = (await fixture.pgDatabase.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'bakery' and table_name = 'usage_records'
          and column_name in ('kind', 'model', 'provider_call_id')`,
    )).rows;
    const by = (name: string) => columns.find((c) => c.column_name === name);
    assertEquals(by("kind")?.is_nullable, "NO");
    assert(by("kind")?.column_default?.includes("'model'"));
    assertEquals(by("model")?.is_nullable, "YES");
    assertEquals(by("provider_call_id")?.is_nullable, "YES");
    const check = (await fixture.pgDatabase.query(
      `select 1 from pg_constraint
        where conrelid = 'bakery.usage_records'::regclass and contype = 'c'`,
    )).rows.length;
    assertEquals(check, 0, "no rule lives in the database");
  }));
