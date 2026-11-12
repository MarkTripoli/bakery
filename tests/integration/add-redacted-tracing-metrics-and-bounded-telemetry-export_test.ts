import { assert, assertEquals } from "@std/assert";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  bindProviderCallIntent,
  recordProviderUsageReceipt,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import {
  createServerTelemetry,
  SERVER_TELEMETRY_EXPORTER,
} from "../../apps/server/src/platform/telemetry.ts";
import type { ExecutionTelemetry } from "../../apps/server/src/modules/execution/telemetry.ts";
import type { TelemetryRecord } from "../../packages/config/src/telemetry.ts";
import { TELEMETRY_META_METRICS } from "../../packages/config/src/telemetry.ts";
import {
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedLegacyLeasedModelAttempt } from "../helpers/worker-execution/legacy-attempt.ts";
import {
  admitFundedModelRun as admit,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import type { AdmittedJob as Admission } from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  eventBody,
  postWorkerResult,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

// AC1 of #23: given a disabled or slow exporter, when jobs execute, then lease
// renewal, completion and usage settlement continue and queues remain bounded.
//
// One job is run through the real routes (claim, lease renewal, a failed result
// that reports usage, which settles the budget) under each condition telemetry
// can be in. What the database and the responses show must be identical every
// time. The spec's own words: "Disable the telemetry sink: execution and
// exact-once usage settlement must remain correct."

type Observation = {
  renewalStatus: number;
  renewalReplayStatus: number;
  renewalReplayHeader: string | null;
  resultStatus: number;
  resultReplayStatus: number;
  jobStatus: string;
  attemptStatus: string;
  intents: string[];
  usageRecords: number;
  runSettledUsd: string;
  runReservedUsd: string;
};

const fault = {
  type: "about:blank",
  title: "Worker execution failed",
  status: 500,
  detail: "telemetry test",
  code: "TELEMETRY_TEST_FAILURE",
  requestId: crypto.randomUUID(),
  retryable: false,
};

function receipt(run: Admission): UsageReceipt {
  return {
    usageFactId: `${run.runId}-telemetry`,
    providerCallId: `${run.runId}-provider-call-telemetry`,
    provider: "openai",
    billingAccountId: String(run.billing?.billingAccountId),
    model: String(run.billing?.model),
    billingRoute: "api",
    pricingMetadataSnapshot: "budget-test-price-v1",
    inputTokens: "1",
    outputTokens: "2",
    costUsd: "0.04",
    measurement: "reported",
    occurredAt: new Date().toISOString(),
  };
}

async function publishReceipt(
  database: PgDatabase,
  run: Admission,
  usage: UsageReceipt,
): Promise<void> {
  await withPgTransaction(database, async (transaction) => {
    await bindProviderCallIntent(transaction, {
      organizationId: run.organizationId,
      installationReservationId: run.installationReservationId,
      providerCallId: usage.providerCallId,
    });
    const intent = (await transaction.query<{ id: string }>(
      `select provider_call_intent_id as id from bakery.budget_action_intents
        where organization_id = $1 and installation_reservation_id = $2`,
      [run.organizationId, run.installationReservationId],
    )).rows[0];
    assert(intent, "the bound call intent exists");
    await recordProviderUsageReceipt(transaction, {
      organizationId: run.organizationId,
      providerCallIntentId: intent.id,
      receipt: usage,
    });
  });
}

/** Runs one funded job to a settled result; `after` runs with the identifiers. */
async function runJob(
  fixture: WorkerFixture,
  stepKey: string,
): Promise<
  { observation: Observation; attemptId: string; leaseToken: string }
> {
  const database = fixture.pgDatabase;
  await seedProviderPricingSnapshot(database);
  const worker = await registeredWorker(fixture, { slots: 8 });
  const run = await admit(
    database,
    await seedRun(database, fixture.organizationId, fixture.principalId, {
      reservationUsd: "0.1",
      stepKey,
    }),
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, run.jobId);

  const renewalKey = crypto.randomUUID();
  const renewalBody = {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    leaseSeconds: 30,
  };
  const renewal = await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
    renewalBody,
    { idempotencyKey: renewalKey },
  );
  await renewal.arrayBuffer();
  const renewalReplay = await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
    renewalBody,
    { idempotencyKey: renewalKey },
  );
  await renewalReplay.arrayBuffer();

  const usage = receipt(run);
  await publishReceipt(database, run, usage);
  const resultKey = crypto.randomUUID();
  const resultBody = {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: "1",
    status: "failed" as const,
    fault,
    usage,
  };
  const result = await postWorkerResult(
    fixture,
    worker,
    assignment,
    resultBody,
    resultKey,
  );
  await result.arrayBuffer();
  const resultReplay = await postWorkerResult(
    fixture,
    worker,
    assignment,
    resultBody,
    resultKey,
  );
  await resultReplay.arrayBuffer();

  const job = (await database.query<{ status: string }>(
    `select status from bakery.jobs where organization_id = $1 and id = $2`,
    [run.organizationId, run.jobId],
  )).rows[0];
  const attempt = (await database.query<{ status: string }>(
    `select status from bakery.job_attempts where organization_id = $1 and id = $2`,
    [run.organizationId, assignment.attemptId],
  )).rows[0];
  const intents = (await database.query<{ status: string }>(
    `select status from bakery.budget_action_intents
      where organization_id = $1 and run_id = $2 order by status`,
    [run.organizationId, run.runId],
  )).rows.map((row) => row.status);
  const records = (await database.query<{ n: string }>(
    `select count(*)::text as n from bakery.usage_records
      where organization_id = $1 and run_id = $2`,
    [run.organizationId, run.runId],
  )).rows[0];
  const account = (await database.query<
    { settled: string; reserved: string }
  >(
    `select settled_usd::text as settled, reserved_usd::text as reserved
       from bakery.budget_accounts
      where organization_id = $1 and run_id = $2 and scope = 'run'`,
    [run.organizationId, run.runId],
  )).rows[0];
  return {
    attemptId: assignment.attemptId,
    leaseToken: assignment.leaseToken,
    observation: {
      renewalStatus: renewal.status,
      renewalReplayStatus: renewalReplay.status,
      renewalReplayHeader: renewalReplay.headers.get("Idempotent-Replayed"),
      resultStatus: result.status,
      resultReplayStatus: resultReplay.status,
      jobStatus: String(job?.status),
      attemptStatus: String(attempt?.status),
      intents,
      usageRecords: Number(records?.n),
      runSettledUsd: String(account?.settled),
      runReservedUsd: String(account?.reserved),
    },
  };
}

/** The job, run against a fixture with this telemetry, and what it left behind. */
async function observe(
  telemetry: ExecutionTelemetry | undefined,
  stepKey: string,
) {
  return await withWorkerFixture((fixture) => runJob(fixture, stepKey), {
    telemetry,
  });
}

const EXPECTED: Observation = {
  renewalStatus: 200,
  renewalReplayStatus: 200,
  renewalReplayHeader: "true",
  resultStatus: 200,
  resultReplayStatus: 200,
  jobStatus: "failed",
  attemptStatus: "failed",
  intents: ["settled"],
  usageRecords: 1,
  runSettledUsd: "0.040000",
  runReservedUsd: "0.000000",
};

Deno.test("the job behaves exactly one way with no telemetry, and that way is the reference", async () => {
  const { observation } = await observe(undefined, "ac1-reference");
  // Usage is settled exactly once, whatever else is true.
  assertEquals(observation.usageRecords, 1);
  assertEquals(observation.intents, ["settled"]);
  assertEquals(observation.renewalStatus, 200);
  assertEquals(observation.resultStatus, 200);
  assertEquals(observation, EXPECTED);
});

Deno.test("AC1: with the exporter disabled, execution and exact-once settlement are unchanged and nothing is queued", async () => {
  const telemetry = createServerTelemetry();
  const { observation } = await observe(telemetry, "ac1-disabled");
  assertEquals(observation, EXPECTED);
  const stats = telemetry.stats();
  assertEquals(stats.disabled, true);
  assertEquals(stats.queued, 0);
  assertEquals(stats.inFlight, 0);
  // The routes did tell it: one renewal, one completion, one settlement (the
  // replays said nothing), each counted as discarded.
  const discarded = telemetry.metrics.snapshot().find((sample) =>
    sample.name === TELEMETRY_META_METRICS.events &&
    sample.labels.outcome === "discarded"
  )?.value;
  assertEquals(discarded, 3);
  await telemetry.close(100);
});

Deno.test("AC1: with a sink that never answers and a full queue, execution and exact-once settlement are unchanged and the queue stays bounded", async () => {
  const telemetry = createServerTelemetry({
    send: () => new Promise(() => {}),
  });
  // Fill it first, so every event the routes emit meets a full queue.
  for (
    let index = 0;
    index < SERVER_TELEMETRY_EXPORTER.capacity + 2_000;
    index += 1
  ) {
    telemetry.event("lease.renewed", {
      "bakery.attempt.id": crypto.randomUUID(),
    });
  }
  const before = telemetry.stats();
  assert(before.queued <= SERVER_TELEMETRY_EXPORTER.capacity);
  assert(before.dropped.queueFull > 0, "the queue really was full");

  const { observation } = await observe(telemetry, "ac1-hung");
  assertEquals(observation, EXPECTED);

  const stats = telemetry.stats();
  assert(
    stats.queued <= SERVER_TELEMETRY_EXPORTER.capacity,
    `${stats.queued} queued`,
  );
  assert(stats.inFlight <= SERVER_TELEMETRY_EXPORTER.batchSize);
  // The job offered exactly three events (a renewal, a completion and a
  // settlement; the replays said nothing). Each was either queued or dropped,
  // whichever the hung sink's one in-flight batch left room for, and none lost
  // track of: the exporter's accounting balances.
  assertEquals(stats.offered - before.offered, 3);
  assertEquals(
    stats.offered,
    stats.queued + stats.inFlight + stats.exported + stats.discarded +
      stats.dropped.queueFull + stats.dropped.sendFailed +
      stats.dropped.shutdown + stats.dropped.reentrant,
    JSON.stringify(stats),
  );
  assertEquals(stats.exported, 0, "a sink that never answers exports nothing");
  // And the drops it did make are visible as a metric.
  const lost = telemetry.metrics.snapshot().find((sample) =>
    sample.name === TELEMETRY_META_METRICS.lost &&
    sample.labels.reason === "queue_full"
  )?.value;
  assertEquals(lost, stats.dropped.queueFull);
  const closing = performance.now();
  await telemetry.close(500);
  assert(
    performance.now() - closing < 2_500,
    "close ended although the sink never answers",
  );
});

Deno.test("AC1: with a sink that throws or rejects, execution and exact-once settlement are unchanged", async () => {
  for (
    const [name, send] of [
      ["throws", () => {
        throw new Error("collector down");
      }],
      ["rejects", () => Promise.reject(new Error("collector down"))],
      ["rejects with nothing", () => Promise.reject(undefined)],
    ] as const
  ) {
    const telemetry = createServerTelemetry({ send });
    const { observation } = await observe(
      telemetry,
      `ac1-sink-${name.replaceAll(" ", "-")}`,
    );
    assertEquals(observation, EXPECTED, name);
    await telemetry.close(500);
    const stats = telemetry.stats();
    assert(stats.queued <= SERVER_TELEMETRY_EXPORTER.capacity, name);
  }
});

Deno.test("AC1: with a telemetry that itself throws, rejects or hangs when told, the routes still answer and settle once", async () => {
  for (
    const [name, telemetry] of [
      ["throws", {
        event: () => {
          throw new Error("boom");
        },
      }],
      ["throws a string", {
        event: () => {
          throw "boom";
        },
      }],
      ["rejects", { event: () => Promise.reject(new Error("boom")) as never }],
      ["never settles", { event: () => new Promise(() => {}) as never }],
      ["returns a hostile thenable", {
        event: () =>
          ({
            then: () => {
              throw new Error("then");
            },
          }) as never,
      }],
    ] as const
  ) {
    const { observation } = await observe(
      telemetry,
      `ac1-port-${name.replaceAll(" ", "-")}`,
    );
    assertEquals(observation, EXPECTED, name);
  }
});

Deno.test("what a healthy sink receives: three events, ids and a closed outcome, once each despite replays, and no token", async () => {
  const sent: TelemetryRecord[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      sent.push(...batch);
    },
  });
  const { observation, attemptId, leaseToken } = await observe(
    telemetry,
    "ac1-healthy",
  );
  assertEquals(observation, EXPECTED);
  await telemetry.close(1_000);
  const events = sent.flatMap((record) =>
    record.kind === "event" ? [record] : []
  );
  assertEquals(
    events.map((event) => event.name).sort(),
    ["job.completed", "lease.renewed", "usage.settled"],
    "one of each: the replayed renewal and the replayed result added nothing",
  );
  for (const event of events) {
    assertEquals(event.attributes["bakery.attempt.id"], attemptId);
  }
  const completed = events.find((event) => event.name === "job.completed");
  assertEquals(completed?.attributes["bakery.outcome"], "failed");
  const text = JSON.stringify(sent);
  for (
    const forbidden of [
      leaseToken,
      "TELEMETRY_TEST_FAILURE",
      "telemetry test",
      "0.04",
    ]
  ) {
    assert(!text.includes(forbidden), `${forbidden} reached the sink`);
  }
  // Only the two keys the routes pass, and nothing the worker or the database said.
  for (const event of events) {
    for (const key of Object.keys(event.attributes)) {
      assert(["bakery.attempt.id", "bakery.outcome"].includes(key), key);
    }
  }
});

Deno.test("a job that completes with no usage tells telemetry it completed, and nothing about usage or a renewal", async () => {
  const sent: TelemetryRecord[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      sent.push(...batch);
    },
  });
  const attemptId = await withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "telemetry-completed",
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await seedLegacyLeasedModelAttempt(
      fixture,
      worker,
      job.jobId,
    );
    const eventId = crypto.randomUUID();
    const event = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, eventId, "1", "2026-09-20T00:00:01.000Z"),
      { idempotencyKey: eventId },
    );
    assertEquals(event.status, 200);
    const result = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "2",
        status: "completed",
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId: job.sessionId,
          artifacts: [],
        },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(result.status, 200);
    await result.arrayBuffer();
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.status, "completed");
    return assignment.attemptId;
  }, { telemetry });
  await telemetry.close(1_000);
  const events = sent.flatMap((record) =>
    record.kind === "event" ? [record] : []
  );
  assertEquals(events.map((event) => event.name), ["job.completed"]);
  assertEquals(events[0].attributes, {
    "bakery.attempt.id": attemptId,
    "bakery.outcome": "completed",
  });
});
