import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import {
  formatTraceparent,
  parseTraceparent,
} from "@bakery/config/telemetry-trace";
import { appendDomainEvent } from "../../packages/persistence/src/event-audit.ts";
import { claudeChildEnvironment } from "../../apps/worker/src/claude-harness.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * The claim SQL and the executeClaim wiring, against a real Postgres.
 *
 * Every unit test for this feature stops at a helper: they prove that
 * `assignmentTraceparent` computes a child context and that the adapters pass a
 * variable along. None of them reads the query production runs, so QA found
 * three mutants that survive all eleven - the candidate row's
 * `original_traceparent` dropped, the subquery filtering the wrong
 * `event_type`, and `executeClaim` not passing `job.originalTraceparent` at
 * all. This drives the whole path instead: a real `run.requested` event with a
 * traceparent, a real POST to /v1/worker/claims, and the assignment a worker
 * would receive.
 */

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

Deno.test("a claim continues the run's recorded trace in a new span", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    const seeded = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );

    // The caller's context, recorded on the run's requesting event. This is the
    // only durable evidence of who asked for the work: the job row stores no
    // trace, and the worker's claim request carries none.
    const callerContext = formatTraceparent({
      traceId: TRACE,
      spanId: CALLER_SPAN,
      sampled: true,
    });
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        appendDomainEvent(transaction, {
          organizationId: fixture.organizationId,
          applicationId: seeded.applicationId,
          repositoryId: null,
          taskId: seeded.taskId,
          conversationId: seeded.conversationId,
          eventType: "run.requested",
          aggregateId: seeded.runId,
          aggregateVersion: 1,
          payload: { runId: seeded.runId },
          traceId: TRACE,
          traceparent: callerContext,
        }),
    );

    const assignment = await claimAssignment(fixture, worker) as unknown as {
      traceparent?: string;
    };

    assert(
      typeof assignment.traceparent === "string",
      "the assignment carries no trace context at all",
    );
    const continued = parseTraceparent(assignment.traceparent);
    assert(
      continued !== undefined,
      "the assignment's context is not parseable",
    );

    // Same trace, new span: the worker's work is a leg of the caller's trace,
    // not an unrelated root and not a copy of the caller's span.
    assertEquals(
      continued.traceId,
      TRACE,
      "the claim did not continue the run's trace",
    );
    assert(
      continued.spanId !== CALLER_SPAN,
      "the claim reused the caller's span instead of starting a child",
    );

    // And the value a harness would actually launch with.
    const environment = claudeChildEnvironment(
      { home: "/tmp/h", path: "/tmp/h/c" },
      { traceparent: assignment.traceparent },
    );
    assertEquals(environment.TRACEPARENT, assignment.traceparent);
  }));

Deno.test("a run with no recorded context still yields a frozen root", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    // seedEligibleJob writes its run.requested event without a traceparent,
    // which is the ordinary case for seeded work. A claim must still succeed:
    // refusing work over a missing tracing header is a worse failure than a
    // broken trace.
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      traceparent?: string;
    };
    const context = parseTraceparent(assignment.traceparent ?? "");
    assert(context !== undefined, "no valid context was issued");
    assertEquals(context.spanId.length, 16);
    assertEquals(context.traceId.length, 32);
  }));

// A test that fails must fail in its own time.
//
// QA saw this file take 3m13s and a sibling 4m22s under a mutant: the assertion
// threw, but a claim still held a transaction, so `pool.end()` in teardown
// waited on that client and the run inherited the database's statement timeout.
// The kill was correct; the failure mode was not, because a slow failure reads
// as infrastructure and teaches people to re-run rather than to read.
//
// This does not reproduce that - on a healthy host at load 27-35 the mutant
// asserts in 2s and I never saw the hang. It holds the condition that produced
// it (a client checked out, in a transaction, when the body throws) and fails if
// teardown is ever allowed to wait on one again.
Deno.test("a failing case does not let teardown wait on a held transaction", async () => {
  const started = performance.now();
  let observed: unknown;

  try {
    await withWorkerFixture(async (fixture) => {
      // Held open on purpose and never released from here: teardown is what has
      // to cope with it, so releasing it would test nothing.
      const client = await fixture.pgDatabase.connect();
      await client.query("begin");
      await client.query("select 1");
      throw new Error("the case failed while a claim held its transaction");
    });
  } catch (error) {
    observed = error;
  }

  const elapsed = performance.now() - started;
  assert(
    observed instanceof Error &&
      observed.message === "the case failed while a claim held its transaction",
    "the original failure did not reach the caller, so its reason was lost",
  );
  assert(
    elapsed < 30_000,
    `teardown waited on the held transaction: ${Math.round(elapsed)}ms`,
  );
});
