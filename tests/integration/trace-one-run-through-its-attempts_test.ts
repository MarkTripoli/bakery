import { assert, assertEquals } from "@std/assert";
import { parseTraceparent } from "@bakery/config/telemetry-trace";
import type { TelemetryRecord } from "../../packages/config/src/telemetry.ts";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";
import { encodeOtlpTraces } from "../../apps/server/src/platform/telemetry-sink.ts";
import {
  bindProviderCallIntent,
  recordProviderUsageReceipt,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  expireAndSupersedeAttempt,
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun as admit,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  postWorkerResult,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * AC2 of #739: one trace ID joins every attempt of a run and what each reports,
 * a step retried after a restart is linked to its first attempt, and no secret
 * reaches a span. Real claim, lease renewal and result routes against a real
 * database; the spans are what the OTLP encoder would put on the wire.
 */

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const RUN_SPAN = "00f067aa0ba902b7";
const SECRET = "sk-live-canary-7f3a91c2d5e8b604";

type Span = {
  traceId: string;
  parentSpanId?: string;
  name: string;
  links?: { traceId: string; spanId: string }[];
  attributes: { key: string; value: Record<string, unknown> }[];
};

function spansOf(records: readonly TelemetryRecord[]): Span[] {
  const body = encodeOtlpTraces(records) as {
    resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
  };
  return body.resourceSpans[0].scopeSpans[0].spans;
}

const attributeOf = (span: Span, key: string) =>
  span.attributes.find((attribute) => attribute.key === key)?.value;

Deno.test("one run keeps one trace across a restart retry, and no secret reaches a span", async () => {
  const records: TelemetryRecord[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      records.push(...batch);
    },
  });
  await withWorkerFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    await seedProviderPricingSnapshot(database);
    const worker = await registeredWorker(fixture, { slots: 8 });
    const run = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "trace",
      }),
    );
    // The run's own span, as the request that made it recorded it.
    const recorded = await database.query(
      `update bakery.domain_events set traceparent = $3
        where organization_id = $1 and aggregate_id = $2
          and event_type = 'run.requested'`,
      [fixture.organizationId, run.runId, `00-${TRACE}-${RUN_SPAN}-01`],
    );
    assert(
      (recorded.rowCount ?? 0) >= 1,
      "the run has a run.requested event to carry the trace",
    );

    const first = await claimAssignment(fixture, worker);
    assertEquals(first.jobId, run.jobId);
    const firstContext = parseTraceparent(first.traceparent as string);
    assert(firstContext !== undefined);
    assertEquals(firstContext.traceId, TRACE);
    const kept = await database.query<{ traceparent: string | null }>(
      "select traceparent from bakery.job_attempts where id = $1",
      [first.attemptId],
    );
    assertEquals(
      kept.rows[0].traceparent,
      first.traceparent,
      "the attempt's span is kept as it was handed to the worker",
    );

    const renew = async (assignment: typeof first) => {
      const response = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          leaseSeconds: 30,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      assertEquals(response.status, 200, await response.clone().text());
      await response.arrayBuffer();
    };
    await renew(first);

    // The worker's host restarts: the attempt is lost and the step is claimed again.
    await database.query(
      "update bakery.jobs set max_attempts = 3 where organization_id = $1 and id = $2",
      [fixture.organizationId, run.jobId],
    );
    await expireAndSupersedeAttempt(database, run.jobId);
    const second = await claimAssignment(fixture, worker);
    assertEquals(second.jobId, run.jobId);
    assert(second.attemptId !== first.attemptId, "a new attempt was made");
    const secondContext = parseTraceparent(second.traceparent as string);
    assert(secondContext !== undefined);
    assertEquals(
      secondContext.traceId,
      TRACE,
      "the retry joined the same trace",
    );
    assert(secondContext.spanId !== firstContext.spanId);
    await renew(second);

    const usage: UsageReceipt = {
      usageFactId: `${run.runId}-trace`,
      providerCallId: `${run.runId}-provider-call-trace`,
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
    const result = await postWorkerResult(fixture, worker, second, {
      leaseToken: second.leaseToken,
      fence: second.fence,
      localSeq: "1",
      status: "failed" as const,
      fault: {
        type: "about:blank",
        title: "Worker execution failed",
        status: 500,
        detail: "trace test",
        code: "TRACE_TEST_FAILURE",
        requestId: crypto.randomUUID(),
        retryable: false,
      },
      usage,
    }, crypto.randomUUID());
    assertEquals(result.status, 200, await result.clone().text());
    await result.arrayBuffer();

    // A caller that hands a secret to the telemetry never gets it into a span.
    telemetry.event("lease.renewed", {
      "bakery.attempt.id": SECRET,
      authorization: `Bearer ${SECRET}`,
      "bakery.outcome": SECRET,
      "bakery.retry.count": 1,
    }, {
      context: secondContext,
      links: [{ traceId: firstContext.traceId, spanId: firstContext.spanId }],
    });

    await telemetry.close(2_000);
    const spans = spansOf(records);
    const named = (name: string) => spans.filter((span) => span.name === name);
    const ofAttempt = (name: string, attemptId: string) =>
      named(name).filter((span) =>
        attributeOf(span, "bakery.attempt.id")?.stringValue === attemptId
      );

    // One trace joins everything the two attempts reported.
    const execution = spans.filter((span) =>
      ["attempt.started", "lease.renewed", "job.completed", "usage.settled"]
        .includes(span.name) &&
      attributeOf(span, "bakery.attempt.id")?.stringValue !== SECRET
    );
    assert(
      execution.length >= 6,
      `expected six or more spans, got ${execution.length}`,
    );
    assertEquals(
      new Set(execution.map((span) => span.traceId)),
      new Set([TRACE]),
      "every attempt's events are in the run's one trace",
    );

    // Each attempt's events sit under that attempt's own span.
    for (const name of ["attempt.started", "lease.renewed"]) {
      assertEquals(
        ofAttempt(name, first.attemptId).map((span) => span.parentSpanId),
        [firstContext.spanId],
        `${name} of the first attempt`,
      );
    }
    for (
      const name of [
        "attempt.started",
        "lease.renewed",
        "job.completed",
        "usage.settled",
      ]
    ) {
      assertEquals(
        ofAttempt(name, second.attemptId).map((span) => span.parentSpanId),
        [secondContext.spanId],
        `${name} of the second attempt`,
      );
    }

    // The retry names the first attempt's span; the first links to nothing.
    for (const name of ["attempt.started", "lease.renewed"]) {
      assertEquals(
        ofAttempt(name, first.attemptId).map((span) => span.links ?? []),
        [[]],
        `${name} of the first attempt has no link`,
      );
    }
    for (
      const name of [
        "attempt.started",
        "lease.renewed",
        "job.completed",
        "usage.settled",
      ]
    ) {
      assertEquals(
        ofAttempt(name, second.attemptId).map((span) => span.links),
        [[{ traceId: TRACE, spanId: firstContext.spanId }]],
        `${name} of the retry links to the first attempt`,
      );
    }
    assertEquals(
      attributeOf(
        ofAttempt("lease.renewed", second.attemptId)[0],
        "bakery.retry.count",
      ),
      { intValue: "1" },
    );

    // No secret, and no unregistered field, reached any span.
    const wire = JSON.stringify(spans);
    assert(!wire.includes(SECRET), "a secret reached a span");
    assert(!wire.includes("Bearer"), "an authorization value reached a span");
    assert(
      !wire.includes("authorization"),
      "an unregistered field reached a span",
    );
  }, { telemetry });
});
