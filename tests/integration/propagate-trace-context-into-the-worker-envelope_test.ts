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
