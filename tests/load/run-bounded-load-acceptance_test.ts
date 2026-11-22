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
import { openSocketFixture } from "../helpers/events-socket.ts";
import type { WsClient } from "../helpers/ws-client.ts";
import { cleanupAuthFixture, signSessionCookie } from "../helpers/auth.ts";

/**
 * Heap in use after a forced full collection. heapUsed alone depends on when
 * V8 last collected, which made the growth budget flaky (214 to 269 MiB on one
 * head). The load lane runs with --expose-gc; without it this fails closed.
 */
function settledHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    throw new Error("the load lane must run with --v8-flags=--expose-gc");
  }
  gc();
  gc();
  return Deno.memoryUsage().heapUsed;
}

// Issue #48 AC2-AC3: the reference workload and its budgets live in
// docs/backend-delivery/load-acceptance-budgets.json, committed before this
// file measured anything. A missed budget fails the lane; nothing here may
// relax a target after observing a run.

type Budgets = {
  workload: {
    tasks: number;
    domainEvents: number;
    workerSlots: number;
    eventClients: number;
    organizations: { noisyShare: number };
  };
  budgets: {
    taskListFirstPageP95Ms: number;
    taskListDeepPageP95Ms: number;
    workerClaimP95Ms: number;
    eventReplayPageP95Ms: number;
    eventFanoutAllClientsMs: number;
    serverHeapGrowthMiB: number;
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
// Enough samples that the p95 is a percentile, not the second-worst reading: at
// 40 one scheduling stall on a busy host decided the result. 160 deep pages fit
// in the noisy tenant's 9,000 tasks (180 pages of 50).
const SAMPLES = 160;

/** The tables whose sequential scans the lane forbids, when a test made them large. */
type LargeTable = "tasks" | "domain_events";
/** Fewer rows than the smallest reference table is not a large table. */
const LARGE_TABLE_ROWS = 1_000;

/** Postgres 16's idle stats interval (10 s) plus a margin. */
const STATS_PUBLISH_WAIT_MS = 11_000;

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

/**
 * Sequential-scan counters for the large tables, once every backend has
 * published them. On Postgres 15 and later a backend sends its table counters
 * to shared stats at most once a second while busy, and an idle one only after
 * a ten-second idle interval. The reads under test ran on the server's pooled
 * connections, not this one, so wait out that interval before reading;
 * otherwise a seq scan they made would not be counted yet.
 */
async function sequentialScans(
  database: {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  tables: readonly LargeTable[],
): Promise<Record<string, number>> {
  // Only a table the test made large is checked: on a table of a few rows a
  // sequential scan is the planner's right choice, so counting it would fail
  // the lane whenever autovacuum happened to re-analyze a table that an earlier
  // test emptied. Each checked table must really hold the reference rows.
  const sizes = await database.query(
    `select relname, count_rows from (
       select 'tasks' as relname, (select count(*) from bakery.tasks)::int as count_rows
       union all
       select 'domain_events', (select count(*) from bakery.domain_events)::int
     ) sizes where relname = any($1)`,
    [tables],
  );
  for (const row of sizes.rows as { relname: string; count_rows: number }[]) {
    assert(
      row.count_rows >= LARGE_TABLE_ROWS,
      `${row.relname} holds ${row.count_rows} rows, not a large table`,
    );
  }
  const read = async () => {
    const result = await database.query(
      `select relname, coalesce(seq_scan, 0)::int as seq_scan
         from pg_stat_user_tables
        where schemaname = 'bakery' and relname = any($1)`,
      [tables],
    );
    return Object.fromEntries(
      (result.rows as { relname: string; seq_scan: number }[]).map((row) => [
        row.relname,
        row.seq_scan,
      ]),
    );
  };
  // Settled means two reads a full publish interval apart agree: on a busy
  // host a backend's counters can arrive later than the interval, and a late
  // arrival from setup must land in "before", never between the two reads
  // that bracket the measured requests.
  let previous = await read();
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, STATS_PUBLISH_WAIT_MS));
    const current = await read();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  throw new Error("sequential-scan counters never settled");
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
    // vacuum, not only analyze: freshly seeded rows otherwise make the first
    // reader set hint bits and write pages back, which timed the first run on a
    // new database at 581 ms. Autovacuum has done this on any real table.
    await database.query("vacuum analyze bakery.tasks");
    await database.query("vacuum analyze bakery.domain_events");

    const before = await sequentialScans(database, ["tasks", "domain_events"]);
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
    const after = await sequentialScans(database, ["tasks", "domain_events"]);

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
      assertEquals(
        after,
        before,
        `a large table was read by sequential scan: ${
          JSON.stringify({ before, after })
        }`,
      );
    }
  }));

Deno.test("AC2/AC3: claims on a slot-limited worker stay inside budget and never exceed its slots", async () => {
  const fixture = await openWorkerFixture();
  try {
    const database = fixture.pgDatabase;
    // One worker's burst plus ten workers filled one claim at a time.
    const jobs = workload.workerSlots * 12;
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
    const claimOn = async (
      target: Awaited<ReturnType<typeof registeredWorker>>,
    ) => {
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        target.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: target.registration.workerHostId,
          capabilities: [...workerFixtureCapabilities],
          supportedActions: ["quality.check"],
        },
        { idempotencyKey: claimKey },
      );
      const status = response.status;
      await response.body?.cancel();
      return status;
    };
    // Twice the slots in flight at once: half must be refused for capacity.
    // This burst proves the slot cap; it is not timed, because eight claims on
    // one worker queue behind each other and the slowest would time the queue.
    const claims = await Promise.all(
      Array.from({ length: workload.workerSlots * 2 }, () => claimOn(worker)),
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
    // Claim latency: one claim at a time, each filling a slot on one of ten
    // other workers, so every sample is a claim that leases a job.
    const timings: number[] = [];
    for (let host = 0; host < 10; host++) {
      const other = await registeredWorker(fixture, {
        name: `load-worker-${host}`,
        slots: workload.workerSlots,
      });
      for (let slot = 0; slot < workload.workerSlots; slot++) {
        const started = performance.now();
        const status = await claimOn(other);
        timings.push(performance.now() - started);
        assertEquals(status, 200, "a timed claim did not lease a job");
      }
    }
    withinBudget("worker claim p95", p95(timings), budgets.workerClaimP95Ms);
  } finally {
    await closeWorkerFixture(fixture);
  }
});

Deno.test("AC2/AC3: fifty event clients replay and receive live events inside budget", async () => {
  const fixture = await openSocketFixture();
  const clients: WsClient[] = [];
  const emails: string[] = [];
  try {
    const database = fixture.pgDatabase;
    // The reference event history: half on the watched task, half elsewhere.
    await database.query(
      `with base as (
         select coalesce(max(organization_sequence), 0) as top
           from bakery.domain_events where organization_id = $1
       ), inserted as (
         insert into bakery.domain_events (
           organization_id, organization_sequence, event_type, application_id,
           task_id, conversation_id, aggregate_id, aggregate_version, payload
         )
         select $1, base.top + n, 'tasks.updated', $2,
                case when n % 2 = 0 then $3::uuid else null end, $4,
                case when n % 2 = 0 then $3::uuid else gen_random_uuid() end,
                n, jsonb_build_object('resourceId', $3::text, 'resourceVersion', n)
           from base, generate_series(1, $5::int) as n
         returning organization_sequence
       )
       insert into bakery.event_clock (organization_id, stream, next_seq)
       select $1, 'domain_events', max(organization_sequence) + 1 from inserted
       on conflict (organization_id, stream) do update
         set next_seq = excluded.next_seq`,
      [
        fixture.organizationId,
        fixture.applicationId,
        fixture.taskId,
        fixture.conversationId,
        workload.domainEvents,
      ],
    );
    await database.query("vacuum analyze bakery.domain_events");
    const heapBefore = settledHeap();
    const before = await sequentialScans(database, ["domain_events"]);

    const frame = async (client: WsClient, timeoutMs = 10_000) => {
      const value = await client.next(timeoutMs);
      if (typeof value !== "string") {
        throw new Error(`socket closed ${value.code}: ${value.reason}`);
      }
      return JSON.parse(value) as {
        type: string;
        events?: { sequence: string }[];
        highwater?: string;
      };
    };
    const scopes = [{ type: "task", id: fixture.taskId }];
    // Fifty people, each with a session: one person may hold only a few
    // sockets, which this test also checks below.
    const cookies: string[] = [];
    for (let index = 0; index < workload.eventClients; index++) {
      const userId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const token = `load-${crypto.randomUUID()}`;
      const email = `load-client-${userId}@example.test`;
      emails.push(email);
      await database.query(
        `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, 'load client', $2, true, now(), now())`,
        [userId, email],
      );
      await database.query(
        `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
         values ($1, $2, 'load client', 'human')`,
        [principalId, userId],
      );
      await database.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status, joined_at,
           created_at, updated_at, version
         ) values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1)`,
        [crypto.randomUUID(), fixture.organizationId, principalId],
      );
      await database.query(
        `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
         values ($1, $2, $3, now() + interval '1 hour', now(), now())`,
        [crypto.randomUUID(), token, userId],
      );
      cookies.push(await signSessionCookie(token, fixture.config.auth!.secret));
    }
    // Every client replays its first page from the start of the history.
    const replay: number[] = [];
    let highwater = "0";
    /** One replay from the start, timed to its first page, then back to the live edge. */
    const replayOnce = async (connected: WsClient) => {
      const started = performance.now();
      await connected.send(JSON.stringify({
        type: "subscribe",
        requestId: crypto.randomUUID(),
        scopes,
        after: "0",
      }));
      // A cursor frame left from the previous subscription, or a keep-alive
      // ping, may arrive before the replay page.
      let first = await frame(connected);
      while (first.type === "cursor" || first.type === "ping") {
        first = await frame(connected);
      }
      replay.push(performance.now() - started);
      assertEquals(first.type, "events");
      assert((first.events?.length ?? 0) > 0);
      await connected.send(JSON.stringify({
        type: "subscribe",
        requestId: crypto.randomUUID(),
        scopes,
        after: highwater,
      }));
      while ((await frame(connected)).type !== "cursor") {
        // Drain the rest of the replay and the first subscription's pages.
      }
    };
    for (let index = 0; index < workload.eventClients; index++) {
      const connected = await fixture.connect({ cookie: cookies[index] });
      assert(
        "send" in connected,
        `websocket handshake failed: ${
          "status" in connected ? connected.status : "?"
        }`,
      );
      clients.push(connected);
      const hello = await frame(connected);
      assertEquals(hello.type, "hello");
      highwater = hello.highwater ?? highwater;
      await replayOnce(connected);
    }
    // Four more replays per client with all fifty connected, so the p95 rests
    // on 250 samples rather than being the third-worst of fifty.
    for (let round = 0; round < 4; round++) {
      for (const client of clients) await replayOnce(client);
    }

    // Twenty live events reach all fifty clients within the fanout budget.
    const live = 20;
    const started = performance.now();
    const inserted: string[] = [];
    for (let index = 0; index < live; index++) {
      inserted.push(
        (await fixture.insertDomainEvent({
          eventType: "tasks.updated",
          aggregateVersion: workload.domainEvents + index + 1,
          payload: {
            resourceId: fixture.taskId,
            resourceVersion: workload.domainEvents + index + 1,
          },
        })).sequence,
      );
    }
    await Promise.all(clients.map(async (client) => {
      const seen: string[] = [];
      while (seen.length < live) {
        const next = await frame(client, budgets.eventFanoutAllClientsMs);
        if (next.type === "events") {
          seen.push(...(next.events ?? []).map((event) => event.sequence));
        }
      }
      assertEquals(seen, inserted);
    }));
    const fanoutMs = performance.now() - started;
    // One person cannot open sockets without limit: past the cap the next
    // handshake is refused, and the fifty healthy clients above were unaffected.
    const own: WsClient[] = [];
    let refused: number | undefined;
    for (let index = 0; index < 32 && refused === undefined; index++) {
      const next = await fixture.connect({ cookie: fixture.cookie });
      if ("send" in next) own.push(next);
      else refused = next.status;
    }
    clients.push(...own);
    assertEquals(refused, 429, "one person's sockets were not capped");
    const after = await sequentialScans(database, ["domain_events"]);
    // Measured with every socket still open, so the growth is what the server
    // retains for them, not garbage V8 has not collected yet.
    const heapGrowthMiB = (settledHeap() - heapBefore) /
      (1024 * 1024);

    withinBudget(
      "event replay first page p95",
      p95(replay),
      budgets.eventReplayPageP95Ms,
    );
    withinBudget(
      "event fanout to all clients",
      fanoutMs,
      budgets.eventFanoutAllClientsMs,
    );
    console.log(
      `load: heap growth ${
        heapGrowthMiB.toFixed(1)
      } MiB (budget ${budgets.serverHeapGrowthMiB} MiB)`,
    );
    assert(
      heapGrowthMiB <= budgets.serverHeapGrowthMiB,
      `heap grew ${heapGrowthMiB.toFixed(1)} MiB`,
    );
    if (!budgets.seqScanOnLargeTablesAllowed) {
      assertEquals(
        after,
        before,
        `a large table was read by sequential scan: ${
          JSON.stringify({ before, after })
        }`,
      );
    }
  } finally {
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
    await cleanupAuthFixture(fixture.pgDatabase, emails).catch(() => undefined);
    await fixture.close();
  }
});
