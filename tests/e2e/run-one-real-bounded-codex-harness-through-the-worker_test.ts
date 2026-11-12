import { assertEquals } from "@std/assert";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { readWorkerConfig } from "../../apps/worker/src/config.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { codexHarnessAvailable } from "../helpers/codex-harness.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import {
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  postWorkerResult,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  codexExecutablePath,
  dedicatedCodexTestAuthSource,
  gitText,
  prepareScratchRepository,
} from "../helpers/codex-harness.ts";

/**
 * The full worker stack with the harness env set. The opt-in
 * environment activates the real Codex harness in the worker config, the
 * admitted assignment executes against the prepared worktree, and the
 * terminal result applies with exact usage/reservation behavior: a Codex
 * subscription run reports no usage receipt, so no cost is ever fabricated
 * and the reservation is not settled with invented amounts.
 */
const codexAvailability = await codexHarnessAvailable();

Deno.test(
  "the opt-in codex harness executes an admitted assignment end to end without fabricating usage",
  {
    sanitizeResources: false,
    sanitizeOps: false,
    ignore: codexAvailability !== true,
  },
  () =>
    withWorkerFixture(async (fixture) => {
      const scratch = await prepareScratchRepository("bakery-issue58-e2e-");
      const stateDir = await Deno.makeTempDir({
        prefix: "bakery-issue58-e2e-state-",
      });

      // Opt-in wiring: production default stays deterministic; the env flag
      // plus the prepared repository and explicit time limit activate it.
      const config = readWorkerConfig({
        BAKERY_ENV: "test",
        BAKERY_SERVER_URL: "http://127.0.0.1:1",
        BAKERY_WORKER_CAPABILITIES: "git",
        BAKERY_WORKER_STATE_DIR: stateDir,
        BAKERY_CODEX_HARNESS: "1",
        BAKERY_CODEX_HARNESS_REPOSITORY: scratch.dir,
        BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: "300000",
        BAKERY_CODEX_HARNESS_EXECUTABLE: codexExecutablePath(),
      });
      assertEquals(config.codexHarness?.repository, scratch.dir);
      assertEquals(config.codexHarness?.timeLimitMs, 300_000);
      const plainConfig = readWorkerConfig({
        BAKERY_ENV: "test",
        BAKERY_SERVER_URL: "http://127.0.0.1:1",
        BAKERY_WORKER_CAPABILITIES: "git",
        BAKERY_WORKER_STATE_DIR: stateDir,
      });
      assertEquals(plainConfig.codexHarness, undefined);

      const worker = await registeredWorker(fixture, {
        name: "issue58-codex-e2e",
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, job.jobId);

      // Real worker artifact route: the harness publishes through the same
      // WorkerApiClient the production worker uses.
      const client = new WorkerApiClient({
        baseUrl: fixture.config.publicBaseUrl,
        credential: worker.credential,
        requestTimeoutMs: 30_000,
        fetcher: async (input, init) =>
          await fixture.app.fetch(
            new Request(new URL(String(input), fixture.config.publicBaseUrl), {
              method: init?.method,
              headers: init?.headers,
              body: init?.body ?? undefined,
            }),
          ),
      });

      const executor = createCodexHarnessExecutor({
        publishFor: (owned) => (request, signal) => {
          if (
            owned.workerSessionId === undefined ||
            owned.workerSessionGeneration === undefined
          ) throw new Error("ARTIFACT_PUBLISH_SESSION_MISSING");
          return client.publishArtifact(owned.attemptId, {
            ...request,
            signal,
            leaseToken: owned.leaseToken,
            fence: String(owned.fence),
            workerSessionId: owned.workerSessionId,
            workerSessionGeneration: String(owned.workerSessionGeneration),
          });
        },
        repositoryFor: () => scratch.dir,
        timeLimitMs: 300_000,
        codexExecutable: codexExecutablePath(),
        authSourceDir: dedicatedCodexTestAuthSource(),
      });
      // The production supervisor renews the lease while the harness runs.
      const renewals = setInterval(() => {
        void client.renewLease(
          assignment.attemptId,
          {
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            workerSessionId: worker.registration.workerSessionId,
            workerSessionGeneration:
              worker.registration.workerSessionGeneration,
            leaseSeconds: 300,
          },
          undefined,
          crypto.randomUUID(),
        );
      }, 10_000);
      const outcome = await executor.execute(
        assignment as unknown as JobAssignment,
        new AbortController().signal,
      );
      clearInterval(renewals);
      assertEquals(outcome.status, "completed");
      if (
        outcome.status !== "completed" || outcome.result === null ||
        typeof outcome.result !== "object" || Array.isArray(outcome.result)
      ) throw new Error("unreachable");
      const result = outcome.result as {
        baseSha: string;
        headSha: string;
        artifacts: unknown[];
      };

      const actualHead = await gitText(scratch.dir, ["rev-parse", "HEAD"]);
      assertEquals(result.baseSha, scratch.baseSha);
      assertEquals(result.headSha, actualHead);
      assertEquals(result.artifacts.length, 1);

      const response = await postWorkerResult(
        fixture,
        worker,
        assignment,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "completed",
          result: outcome.result,
        },
        crypto.randomUUID(),
      );
      assertEquals(response.status, 200, await response.clone().text());
      const terminal = await readExecutionState(fixture.pgDatabase, job.jobId);
      assertEquals(terminal.job.status, "completed");
      assertEquals(terminal.attempts[0].status, "completed");
      const storedOutput = terminal.step.output as Record<string, unknown>;
      assertEquals(storedOutput.headSha, actualHead);

      // Exact usage behavior: the subscription harness reports no usage, so
      // no usage record is fabricated and no settled cost is invented.
      const usageRows = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.usage_records
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(usageRows.rows[0].count, "0");
      const unsettled = await fixture.pgDatabase.query<{
        settledCost: string | null;
      }>(
        `select settled_usd::text as "settledCost"
           from bakery.budget_reservations
          where organization_id = $1`,
        [fixture.organizationId],
      );
      for (const row of unsettled.rows) {
        assertEquals(row.settledCost, null);
      }
    }),
);
