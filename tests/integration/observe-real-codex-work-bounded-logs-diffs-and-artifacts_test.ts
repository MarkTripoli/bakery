import {
  bindProviderCallIntent,
  recordProviderUsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { assert, assertEquals } from "@std/assert";
import { attemptBrowserClient } from "../helpers/attempt-read.ts";
import { workerRequest } from "../helpers/worker-execution.ts";
import { setup } from "../helpers/output-ingestion.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

Deno.test("task attempt reads expose trusted current identity and bounded authoritative outcome", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await setup(fixture);
    const reader = attemptBrowserClient(fixture);
    assert(seeded.binding.taskId);
    const query = {
      id: seeded.assignment.jobId,
      taskId: seeded.binding.taskId,
    };
    const initial = await reader.actions["jobAttempts.list"](query);
    assertEquals(initial.items.length, 1);
    const attempt = initial.items[0];
    assert(attempt);
    assertEquals(attempt.id, seeded.assignment.attemptId);
    assertEquals(attempt.workerHostId, seeded.worker.registration.workerHostId);
    assertEquals(attempt.isCurrent, true);
    assertEquals(attempt.leaseState, "active");
    assertEquals(attempt.outcome.usage, null);
    assertEquals(attempt.outcome.resultStatus, null);
    assert(attempt.workerName.length > 0);
    const exitedAt = "2026-10-11T12:34:56.000Z";
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status='canceled', result=$2::jsonb where id=$1`,
      [
        attempt.id,
        JSON.stringify({
          status: "canceled",
          cancellation: {
            processExited: true,
            terminationStatus: "confirmed",
            exitedAt,
            credentials: "private-canary",
            leaseToken: seeded.assignment.leaseToken,
          },
          result: { exitCode: 17, secret: "private-canary" },
          fault: { code: "quota_exceeded" },
        }),
      ],
    );
    const canceled = (await reader.actions["jobAttempts.list"](query)).items[0];
    assert(canceled);
    assertEquals(canceled.leaseState, "closed");
    assertEquals(canceled.outcome, {
      resultStatus: "canceled",
      reasonCode: "quota_exceeded",
      exitCode: 17,
      processExited: true,
      terminationStatus: "confirmed",
      exitedAt,
      usage: null,
    });
    const encoded = JSON.stringify(canceled);
    for (
      const forbidden of [
        "private-canary",
        seeded.assignment.leaseToken,
        "leaseToken",
        "credential",
        '"fence"',
        "workerSessionId",
      ]
    ) assert(!encoded.includes(forbidden));
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status='running', lease_expires_at=now()-interval '1 second', result=$2::jsonb where id=$1`,
      [
        attempt.id,
        JSON.stringify({
          status: "unrecognized",
          result: { exitCode: 100000 },
          fault: { code: "NATIVE_OUTPUT_DRAIN_TIMEOUT" },
          cancellation: {
            terminationStatus: "secret-canary",
            exitedAt: "bad",
            processExited: "secret",
          },
          usage: { inputTokens: 999, secret: "canary" },
        }),
      ],
    );
    const expired = (await reader.actions["jobAttempts.list"](query)).items[0];
    assert(expired);
    assertEquals(expired.leaseState, "expired");
    assertEquals(expired.outcome, {
      resultStatus: null,
      reasonCode: null,
      exitCode: null,
      processExited: null,
      terminationStatus: null,
      exitedAt: null,
      usage: null,
    });
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set lease_expires_at=now()+interval '1 hour' where id=$1`,
      [attempt.id],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set current_fence=current_fence+1 where id=$1`,
      [query.id],
    );
    const stale = (await reader.actions["jobAttempts.list"](query)).items[0];
    assertEquals(stale?.isCurrent, false);
    assertEquals(stale?.leaseState, "unknown");
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status='lost' where id=$1`,
      [attempt.id],
    );
    assertEquals(
      (await reader.actions["jobAttempts.list"](query)).items[0]?.leaseState,
      "lost",
    );
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set result='{"status":"completed","result":{"status":"timed_out"},"fault":{"code":"UNKNOWN_FAULT","reason":"timeout"}}'::jsonb where id=$1`,
      [attempt.id],
    );
    const timedOut = (await reader.actions["jobAttempts.list"](query)).items[0]
      ?.outcome;
    assertEquals(timedOut?.reasonCode, "timeout");
    assertEquals(timedOut?.resultStatus, "timed_out");
  }));

Deno.test("attempt history uses stable authenticated cursor pagination without returning fencing tokens", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await setup(fixture);
    assert(seeded.binding.taskId);
    await fixture.pgDatabase.query(
      `insert into bakery.job_attempts (
      organization_id,job_id,worker_host_id,worker_session_id,worker_session_generation,attempt_no,fence,lease_token_hash,lease_expires_at,status,created_at)
      select organization_id,job_id,worker_host_id,worker_session_id,worker_session_generation,attempt_no+1,fence+1,lease_token_hash,lease_expires_at,'lost',created_at+interval '1 second'
      from bakery.job_attempts where id=$1`,
      [seeded.assignment.attemptId],
    );
    const reader = attemptBrowserClient(fixture);
    const query = {
      id: seeded.assignment.jobId,
      taskId: seeded.binding.taskId,
      limit: 1,
    };
    const first = await reader.actions["jobAttempts.list"](query);
    assert(first.nextCursor);
    assertEquals(first.items[0]?.attemptNo, 2);
    const second = await reader.actions["jobAttempts.list"]({
      ...query,
      cursor: first.nextCursor,
    });
    assertEquals(second.items.length, 1);
    assertEquals(second.items[0]?.id, seeded.assignment.attemptId);
    assertEquals(second.nextCursor, null);
  }));

Deno.test("attempt usage requires a matching authoritative provider receipt", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await setup(fixture);
    assert(seeded.binding.taskId);
    const intent = (await fixture.pgDatabase.query<
      { reservationId: string; callId: string }
    >(
      `select installation_reservation_id as "reservationId", provider_call_intent_id as "callId"
       from bakery.budget_action_intents where organization_id=$1 and run_step_id=$2`,
      [fixture.organizationId, seeded.job.runStepId],
    )).rows[0];
    assert(intent);
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        bindProviderCallIntent(transaction, {
          organizationId: fixture.organizationId,
          installationReservationId: intent.reservationId,
          providerCallId: "attempt-read-provider-call",
        }),
    );
    const usage = {
      providerCallId: "attempt-read-provider-call",
      usageFactId: "attempt-read-usage",
      provider: "openai",
      billingAccountId: "budget-test-account",
      model: "gpt-5.6-luna",
      billingRoute: "api" as const,
      pricingMetadataSnapshot: "budget-test-price-v1",
      inputTokens: "11",
      outputTokens: "22",
      costUsd: "0.010000",
      measurement: "reported" as const,
      occurredAt: new Date().toISOString(),
    };
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        recordProviderUsageReceipt(transaction, {
          organizationId: fixture.organizationId,
          providerCallIntentId: intent.callId,
          receipt: usage,
        }),
    );
    const response = await workerRequest(
      fixture,
      seeded.worker.credential,
      `/v1/worker/attempts/${seeded.assignment.attemptId}/result`,
      {
        ...seeded.open,
        localSeq: "1",
        status: "failed",
        fault: {
          type: "about:blank",
          title: "Execution failed",
          status: 500,
          detail: "test failure",
          code: "timeout",
          requestId: crypto.randomUUID(),
          retryable: false,
        },
        usage,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(response.status, 200, await response.text());
    const reader = attemptBrowserClient(fixture);
    const query = {
      id: seeded.assignment.jobId,
      taskId: seeded.binding.taskId,
    };
    const outcome = (await reader.actions["jobAttempts.list"](query)).items[0]
      ?.outcome;
    assertEquals(outcome?.usage, {
      inputTokens: "11",
      outputTokens: "22",
      costUsd: "0.010000",
    });
    assertEquals(outcome?.reasonCode, "timeout");
    await fixture.pgDatabase.query(
      `update bakery.provider_authoritative_receipts set input_tokens=12 where organization_id=$1 and provider_call_intent_id=$2`,
      [fixture.organizationId, intent.callId],
    );
    assertEquals(
      (await reader.actions["jobAttempts.list"](query)).items[0]?.outcome.usage,
      null,
    );
  }));

Deno.test("attempt reads project only real harness timeout faults as timeout", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await setup(fixture);
    const reader = attemptBrowserClient(fixture);
    assert(seeded.binding.taskId);
    const query = {
      id: seeded.assignment.jobId,
      taskId: seeded.binding.taskId,
    };
    const project = async (status: string, code: string) => {
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set status='failed', result=$2::jsonb where id=$1`,
        [
          seeded.assignment.attemptId,
          JSON.stringify({ status, fault: { code, reason: "canary" } }),
        ],
      );
      return (await reader.actions["jobAttempts.list"](query)).items[0]
        ?.outcome;
    };
    for (
      const code of [
        "CLAUDE_HARNESS_TIMEOUT",
        "CODEX_HARNESS_TIMEOUT",
        "PI_HARNESS_TIMEOUT",
      ]
    ) {
      const outcome = await project("failed", code);
      assertEquals(outcome?.resultStatus, "failed", code);
      assertEquals(outcome?.reasonCode, "timeout", code);
    }
    assertEquals(
      (await project("succeeded", "CLAUDE_HARNESS_TIMEOUT"))?.reasonCode,
      null,
    );
    assertEquals(
      (await project("failed", "CLAUDE_HARNESS_EXIT_NONZERO"))?.reasonCode,
      null,
    );
  }));
