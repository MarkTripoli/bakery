import { assert, assertEquals } from "@std/assert";
import {
  readExecutionState,
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

Deno.test(
  "worker terminal receipts accept captured output and zero session generations",
  () =>
    withWorkerFixture(async (fixture) => {
      const worker = await registeredWorker(fixture, {
        name: "issue396-terminal-receipt",
        slots: 2,
      });
      const invalidJob = await seedEligibleNonmodelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const invalidAssignment = await claimAssignment(fixture, worker);
      const invalidResponse = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${invalidAssignment.attemptId}/result`,
        {
          fence: invalidAssignment.fence,
          localSeq: "1",
          status: "completed",
          result: {
            headSha: 42,
            baseSha: "base",
            sessionId: invalidJob.sessionId,
            artifacts: [],
          },
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      assertEquals(invalidResponse.status, 422);
      const invalidProblem = await invalidResponse.json() as {
        code?: string;
        issues?: Array<{ path?: Array<string | number> }>;
      };
      assertEquals(invalidProblem.code, "UNPROCESSABLE");
      const invalidIssues = invalidProblem.issues ?? [];
      assert(
        invalidIssues.some((issue) => issue.path?.includes("leaseToken")) ??
          false,
      );
      assert(
        invalidIssues.some((issue) =>
          JSON.stringify(issue.path) === JSON.stringify(["result", "headSha"])
        ) ?? false,
      );

      const job = await seedEligibleNonmodelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      // Claim a nonmodel fixture so the regression stays independent of live
      // billing admission; terminal ingestion resolves the persisted action.
      await fixture.pgDatabase.query(
        `update bakery.jobs set action = 'harness.implement'
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, assignment.jobId],
      );
      const sessionId = assignment.workerSessionId;
      assert(typeof sessionId === "string");

      // Zero is a valid persisted session generation for legacy/pre-heartbeat
      // attempts. Keep the claimed session identity and exercise the exact
      // terminal result shape emitted by the Claude Code harness.
      await fixture.pgDatabase.query(
        `update bakery.worker_hosts
            set worker_session_generation = 0
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, assignment.workerHostId],
      );
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set worker_session_generation = 0
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, assignment.attemptId],
      );
      const idempotencyKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          workerSessionId: sessionId,
          workerSessionGeneration: "0",
          status: "completed",
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: job.sessionId,
            artifacts: [],
            claudeCodeVersion: "2.0.0",
            model: "claude",
            capabilities: ["git", "shell", "web", "model"],
            events: [],
            telemetry: { providerUsage: null, costUsd: null },
          },
        },
        { idempotencyKey },
      );
      assertEquals(response.status, 200);
      const ack = await response.json();
      assertEquals(ack, {
        eventId: idempotencyKey,
        status: "applied",
        lastEventSeq: "1",
      });

      const state = await readExecutionState(fixture.pgDatabase, job.jobId);
      assertEquals(state.job.status, "completed");
      assertEquals(state.run.status, "completed");
      assertEquals(state.step.status, "completed");
      assertEquals(state.attempts.length, 1);
      assertEquals(state.attempts[0]?.status, "completed");
      assertEquals(state.attempts[0]?.lastEventSeq, "1");
      assertEquals(state.events.length, 1);
      assertEquals(state.events[0]?.eventType, "job.succeeded");
      assertEquals(
        (state.events[0]?.savedAck as { status?: string } | undefined)?.status,
        "applied",
      );
    }),
);
