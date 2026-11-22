import { assert, assertEquals } from "@std/assert";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import { send, withFixture } from "../helpers/definition-authoring.ts";
import {
  closeWorkerFixture,
  openWorkerFixture,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

// Issue #48 AC2-AC3: the reference workload and its budgets live in
// docs/backend-delivery/load-acceptance-budgets.json, committed before this
// file measured anything. A missed budget fails the lane; nothing here may
// relax a target after observing a run.

type Budgets = {
  workload: {
    tasks: number;
    domainEvents: number;
    workerSlots: number;
    organizations: { noisyShare: number };
  };
  budgets: {
    taskListFirstPageP95Ms: number;
    taskListDeepPageP95Ms: number;
    workerClaimP95Ms: number;
    maxActiveAttemptsPerWorker: number;
    seqScanOnLargeTablesAllowed: boolean;
  };
};

const reference = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../docs/backend-delivery/load-acceptance-budgets.json",
      import.meta.url,
    ),
  ),
) as Budgets;
const { workload, budgets } = reference;
const SAMPLES = 40;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

/** Fails with the measured value and the budget it missed, never relaxes it. */
function withinBudget(name: string, measured: number, budget: number) {
  console.log(`load: ${name} ${measured.toFixed(1)} ms (budget ${budget} ms)`);
  assert(
    measured <= budget,
    `${name}: measured ${measured.toFixed(1)} ms, budget ${budget} ms`,
  );
}

async function sequentialScans(
  database: { query: (sql: string) => Promise<{ rows: unknown[] }> },
): Promise<Record<string, number>> {
  const result = await database.query(
    `select relname, coalesce(seq_scan, 0)::int as seq_scan
       from pg_stat_user_tables
      where schemaname = 'bakery' and relname in ('tasks', 'domain_events')`,
  );
  return Object.fromEntries(
    (result.rows as { relname: string; seq_scan: number }[]).map((row) => [
      row.relname,
      row.seq_scan,
    ]),
  );
}

Deno.test("AC2/AC3: task lists stay inside their latency budget over the reference workload, by index", () =>
  withFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const noisy = await seedOrganization(fixture, "load-noisy", {
      role: "admin",
      agent: false,
    });
    const quiet = await seedOrganization(fixture, "load-quiet", {
      role: "admin",
      agent: false,
    });
    const noisyTasks = Math.round(
      workload.tasks * workload.organizations.noisyShare,
    );
    const seedTasks = (seed: typeof noisy, count: number) =>
      database.query(
        `insert into bakery.tasks (
           organization_id, application_id, conversation_id, title,
           task_type, status, created_by, created_at
         )
         select $1, $2, $3, 'load task ' || n, 'feature', 'draft', $4,
                now() - (n * interval '1 second')
           from generate_series(1, $5::int) as n`,
        [
          seed.organizationId,
          seed.applicationId,
          seed.conversationId,
          seed.principalId,
          count,
        ],
      );
    await seedTasks(noisy, noisyTasks);
    await seedTasks(quiet, workload.tasks - noisyTasks);
    const seedEvents = (seed: typeof noisy, count: number) =>
      database.query(
        `with base as (
           select coalesce(max(organization_sequence), 0) as top
             from bakery.domain_events where organization_id = $1
         ), inserted as (
           insert into bakery.domain_events (
             organization_id, organization_sequence, event_type, aggregate_id,
             aggregate_version, payload
           )
           select $1, base.top + n, 'load.event', gen_random_uuid(), 1,
                  '{}'::jsonb
             from base, generate_series(1, $2::int) as n
           returning organization_sequence
         )
         -- Move the organization's event clock past the seeded rows, as the
         -- live append path would have.
         insert into bakery.event_clock (organization_id, stream, next_seq)
         select $1, 'domain_events', max(organization_sequence) + 1
           from inserted
         on conflict (organization_id, stream) do update
           set next_seq = excluded.next_seq`,
        [seed.organizationId, count],
      );
    const noisyEvents = Math.round(
      workload.domainEvents * workload.organizations.noisyShare,
    );
    await seedEvents(noisy, noisyEvents);
    await seedEvents(quiet, workload.domainEvents - noisyEvents);
    await database.query("analyze bakery.tasks");
    await database.query("analyze bakery.domain_events");

    const before = await sequentialScans(database);
    const firstPage: number[] = [];
    const deepPage: number[] = [];
    // The quiet tenant reads while the noisy one holds nine tenths of the rows.
    for (const seed of [noisy, quiet]) {
      for (let sample = 0; sample < SAMPLES / 2; sample++) {
        const started = performance.now();
        const response = await send(
          fixture,
          { seed },
          "GET",
          "/v1/tasks?limit=50",
        );
        const page = await response.json() as {
          items: unknown[];
          nextCursor: string | null;
        };
        firstPage.push(performance.now() - started);
        assertEquals(response.status, 200);
        assertEquals(page.items.length, 50);
      }
    }
    // Follow the noisy tenant's cursor deep into its list and time those pages.
    let cursor: string | null = null;
    for (let index = 0; index < SAMPLES; index++) {
      const path = `/v1/tasks?limit=50${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const started = performance.now();
      const response = await send(fixture, { seed: noisy }, "GET", path);
      const page = await response.json() as { nextCursor: string | null };
      if (index > 0) deepPage.push(performance.now() - started);
      assertEquals(response.status, 200);
      cursor = page.nextCursor;
      assert(cursor, "the noisy tenant's list ended early");
    }
    const after = await sequentialScans(database);

    withinBudget(
      "task list first page p95",
      p95(firstPage),
      budgets.taskListFirstPageP95Ms,
    );
    withinBudget(
      "task list deep page p95",
      p95(deepPage),
      budgets.taskListDeepPageP95Ms,
    );
    if (!budgets.seqScanOnLargeTablesAllowed) {
      assertEquals(after, before, "a large table was read by sequential scan");
    }
  }));

Deno.test("AC2/AC3: claims on a slot-limited worker stay inside budget and never exceed its slots", async () => {
  const fixture = await openWorkerFixture();
  try {
    const database = fixture.pgDatabase;
    const jobs = workload.workerSlots * 10;
    for (let index = 0; index < jobs; index++) {
      await seedEligibleNonmodelJob(
        database,
        fixture.organizationId,
        fixture.principalId,
      );
    }
    const worker = await registeredWorker(fixture, {
      name: "load-worker",
      slots: workload.workerSlots,
    });
    const timings: number[] = [];
    // Twice the slots in flight at once: half must be refused for capacity.
    const claims = await Promise.all(
      Array.from({ length: workload.workerSlots * 2 }, async () => {
        const claimKey = crypto.randomUUID();
        const started = performance.now();
        const response = await workerRequest(
          fixture,
          worker.credential,
          "/v1/worker/claims",
          {
            claimKey,
            workerHostId: worker.registration.workerHostId,
            capabilities: [...workerFixtureCapabilities],
            supportedActions: ["quality.check"],
          },
          { idempotencyKey: claimKey },
        );
        timings.push(performance.now() - started);
        const status = response.status;
        await response.body?.cancel();
        return status;
      }),
    );
    assert(claims.every((status) => status < 500), claims.join(", "));
    const active = (await database.query<{ count: number }>(
      `select count(*)::int as count from bakery.job_attempts
        where worker_host_id = $1
          and status in ('leased', 'running', 'canceling')`,
      [worker.registration.workerHostId],
    )).rows[0]?.count ?? 0;
    assert(
      active <= budgets.maxActiveAttemptsPerWorker,
      `${active} active attempts on a ${workload.workerSlots}-slot worker`,
    );
    assertEquals(active, workload.workerSlots);
    withinBudget("worker claim p95", p95(timings), budgets.workerClaimP95Ms);
  } finally {
    await closeWorkerFixture(fixture);
  }
});
