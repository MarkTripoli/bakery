import { codexHarnessAvailable } from "../helpers/codex-harness.ts";
import { assert, assertEquals } from "@std/assert";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function gitBytes(
  cwd: string,
  args: string[],
): Promise<Uint8Array> {
  const command = new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.code, 0);
  return output.stdout;
}

/**
 * AC1: an authorized fixture repository task runs through one real
 * bounded `codex exec` invocation, and the recorded revision and artifact
 * evidence pass deterministic checks against the actual worktree state.
 */
const codexAvailability = await codexHarnessAvailable();

Deno.test(
  "one real bounded codex harness run records the actual revision and a digest-verified patch artifact",
  {
    sanitizeResources: false,
    sanitizeOps: false,
    ignore: codexAvailability !== true,
  },
  () =>
    withWorkerFixture(async (fixture) => {
      const scratch = await prepareScratchRepository("bakery-issue58-");
      const worker = await registeredWorker(fixture, {
        name: "issue58-codex-harness",
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, job.jobId);

      // The worker client talks to the fixture app in-process; artifact and
      // result routes hit the real server implementation with real evidence.
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
      // The seeded job names no change, so a real model may legitimately leave
      // the tree alone. Pin one small edit so "the run must change HEAD" is a
      // statement about the harness, not about model initiative.
      const assignmentContract = {
        ...assignment,
        input: {
          ...(assignment.input as Record<string, unknown>),
          instructions:
            "Append the single line codex-proof to the file notes.txt in the repository root, then stop. Do not commit.",
        },
      } as unknown as JobAssignment;
      // The real codex batch run outlives the seeded lease; renew it the way
      // the production supervisor does while the harness is running.
      const renewalBody = {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
        leaseSeconds: 300,
      };
      const renewals = setInterval(() => {
        void client.renewLease(
          assignment.attemptId,
          renewalBody,
          undefined,
          crypto.randomUUID(),
        );
      }, 10_000);
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

      const outcome = await executor.execute(
        assignmentContract,
        new AbortController().signal,
      );
      clearInterval(renewals);
      assertEquals(outcome.status, "completed");
      if (
        outcome.status !== "completed" || outcome.result === null ||
        typeof outcome.result !== "object" || Array.isArray(outcome.result)
      ) {
        throw new Error("unreachable");
      }
      const result = outcome.result as {
        baseSha: string;
        headSha: string;
        artifacts: Array<
          { artifactId: string; versionId: string; sha256: string }
        >;
        sessionId?: string;
      };

      // The actual Git revision changed and is exactly what the harness
      // reported; the recorded revision is evidence, not a fabricated id.
      const actualHead = await gitText(scratch.dir, ["rev-parse", "HEAD"]);
      assertEquals(result.baseSha, scratch.baseSha);
      assertEquals(result.headSha, actualHead);
      assert(actualHead !== scratch.baseSha, "the run must change HEAD");
      assertEquals(result.artifacts.length, 1);

      // Deterministic artifact check: the published digest is the SHA-256 of
      // the exact patch between the recorded base and head revisions.
      const patch = await gitBytes(scratch.dir, [
        "diff",
        "--binary",
        `${scratch.baseSha}..${actualHead}`,
      ]);
      assertEquals(
        result.artifacts[0].sha256,
        await sha256Hex(patch),
      );

      // The durable journal records the same actual revision as the
      // attempt's terminal result, with no fabricated usage receipt.
      const resultResponse = await postWorkerResult(
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
      assertEquals(
        resultResponse.status,
        200,
        await resultResponse.clone().text(),
      );
      const terminal = await readExecutionState(fixture.pgDatabase, job.jobId);
      assertEquals(terminal.job.status, "completed");
      assertEquals(terminal.attempts[0].status, "completed");
      const storedOutput = terminal.step.output as Record<string, unknown>;
      assertEquals(storedOutput.headSha, actualHead);
      assertEquals(storedOutput.baseSha, scratch.baseSha);
      const usageRows = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.usage_records
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(usageRows.rows[0].count, "0");
    }),
);
