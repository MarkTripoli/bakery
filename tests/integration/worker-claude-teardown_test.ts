import { assert, assertEquals, assertExists } from "@std/assert";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { createClaudeHarnessExecutor } from "../../apps/worker/src/claude-harness.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import {
  closeWorkerFixture,
  openWorkerFixture,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
} from "../helpers/worker-execution.ts";
import {
  fastSleep,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";
import { prepareScratchRepository } from "../helpers/harness.ts";
import {
  FAKE_CLAUDE_VERSION_PRELUDE,
  SYNTHETIC_CLAUDE_CREDENTIALS,
} from "../helpers/harness-auth.ts";

async function fakeClaude(dir: string, sessionId: string): Promise<string> {
  const authSource = `${dir}/auth-source`;
  await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${authSource}/.credentials.json`,
    SYNTHETIC_CLAUDE_CREDENTIALS,
  );
  const executable = `${dir}/fake-claude`;
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
set -eu
${FAKE_CLAUDE_VERSION_PRELUDE}
cat >/dev/null
printf '%s\n' 'teardown regression change' >> notes.txt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"${sessionId}","claude_code_version":"2.1.0","model":"fake-claude","capabilities":["git"]}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${sessionId}","total_cost_usd":0}'
`,
  );
  await Deno.chmod(executable, 0o755);
  return executable;
}

async function runTeardownScenario(
  injectBeforeCloseRoute: boolean,
): Promise<void> {
  const fixture = await openWorkerFixture();
  const directory = await Deno.makeTempDir({
    prefix: "bakery-claude-teardown-",
  });
  let scratchDir: string | undefined;
  try {
    const worker = await registeredWorker(fixture, {
      name: "claude-teardown-regression",
    });
    const scratch = await prepareScratchRepository(
      "bakery-claude-teardown-scratch-",
    );
    scratchDir = scratch.dir;
    const stateDir = `${directory}/worker-state`;
    const repositoryId = crypto.randomUUID();
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        input: {
          repositoryId,
          planArtifact: crypto.randomUUID(),
        },
      },
    );
    const fake = await fakeClaude(scratch.dir, job.sessionId);
    const registrationStore = new RegistrationStore(
      `${stateDir}/registration.json`,
    );
    await registrationStore.saveRegistered(
      worker.credential,
      worker.registration,
    );
    const spool = await EventSpool.open({
      path: `${stateDir}/spool.json`,
      maxRecords: 100,
      maxBytes: 1_000_000,
    });

    let closeFailures = 0;
    let closeRouteResponses = 0;
    const nonOkRoutes: string[] = [];
    let successfulResultPosts = 0;
    const supervisorRef: { current?: WorkerSupervisor } = {};
    const client = new WorkerApiClient({
      baseUrl: fixture.config.publicBaseUrl,
      credential: worker.credential,
      requestTimeoutMs: 2_000,
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const request = new Request(
          new URL(String(input), fixture.config.publicBaseUrl),
          {
            method: init?.method,
            headers: init?.headers,
            body: init?.body ?? undefined,
          },
        );
        const shouldInjectCloseFailure =
          path.endsWith("/output-bindings/close") && closeFailures === 0;
        if (shouldInjectCloseFailure && injectBeforeCloseRoute) {
          closeFailures++;
          nonOkRoutes.push(`${path}:422`);
          return Response.json({
            code: "UNPROCESSABLE",
            detail: "injected output close failure",
            requestId: "teardown-close-422",
          }, {
            status: 422,
            headers: {
              "content-type": "application/problem+json",
              "X-Bakery-Worker-Protocol-Version": "2",
            },
          });
        }
        const response = await fixture.app.fetch(request);
        if (shouldInjectCloseFailure) {
          assertEquals(
            response.status,
            200,
            await response.clone().text(),
          );
          closeFailures++;
          closeRouteResponses++;
          nonOkRoutes.push(`${path}:422`);
          // The real close route accepts the payload and commits the stream.
          // Replace only its response to reproduce the maintenance response
          // failure that previously escaped teardown as a fatal error.
          return Response.json({
            code: "UNPROCESSABLE",
            detail: "injected output close failure",
            requestId: "teardown-close-422",
          }, {
            status: 422,
            headers: {
              "content-type": "application/problem+json",
              "X-Bakery-Worker-Protocol-Version": "2",
            },
          });
        }
        if (!response.ok) nonOkRoutes.push(`${path}:${response.status}`);
        if (path.endsWith("/result") && response.ok) {
          successfulResultPosts++;
          setTimeout(() => {
            supervisorRef.current?.requestStop("TEST_COMPLETE");
          }, 0);
        }
        return response;
      },
    });
    const executor = createClaudeHarnessExecutor({
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
      claudeExecutable: fake,
      stateDir: `${directory}/claude-state`,
      authSourceDir: `${scratch.dir}/auth-source`,
      timeLimitMs: 10_000,
    });
    const supervisor = new WorkerSupervisor({
      config: {
        ...supervisorConfig(stateDir),
        serverUrl: fixture.config.publicBaseUrl,
      },
      client,
      registrationStore,
      spool,
      executor,
      sleep: fastSleep,
    });
    supervisorRef.current = supervisor;

    await supervisor.run();

    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(closeFailures, 1);
    assertEquals(closeRouteResponses, injectBeforeCloseRoute ? 0 : 1);
    assertEquals(successfulResultPosts, 1);
    assertEquals(nonOkRoutes.length, 1);
    assert(nonOkRoutes[0]!.endsWith("/output-bindings/close:422"));
    assertEquals(supervisor.fatalReason, null);
    assert(supervisor.stopReason?.includes("WORKER_SUPERVISOR_FAULT"));
    assertEquals(state.attempts.length, 1);
    assertEquals(state.attempts[0]!.status, "completed");
    assertEquals(state.job.status, "completed");
    assertEquals(state.run.status, "completed");
    assertEquals(state.step.status, "completed");
    assertExists(state.step.output);
    assertEquals(state.events.at(-1)?.eventType, "job.succeeded");
    assert(state.events.some(({ eventType }) => eventType === "job.output"));
    assertEquals(spool.records().length, 0);
    assertEquals(spool.pendingOutputCloses().length, 0);
    const streamRow = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.session_output_streams
        where organization_id=$1 and job_id=$2 order by id limit 1`,
      [fixture.organizationId, job.jobId],
    )).rows[0];
    assertExists(streamRow);
    const transcriptResponse = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/output-streams/${streamRow.id}/transcript?sessionId=${streamRow.id}`,
        {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    const transcriptBody = await transcriptResponse.clone().json() as {
      capture: string;
      captureReason: string;
      exportDisposition: string;
      segments: Array<{ versionId: string }>;
      manifest: { versionId: string } | null;
    };
    assert(
      ["complete", "truncated", "interrupted"].includes(
        transcriptBody.capture,
      ),
    );
    assert(
      ["clean-end", "text-limit", "source-lost", "lease-lost"].includes(
        transcriptBody.captureReason,
      ),
    );
    assert(
      ["published", "incomplete"].includes(transcriptBody.exportDisposition),
    );
    if (injectBeforeCloseRoute) {
      assertEquals(transcriptBody.capture, "interrupted");
      assertEquals(transcriptBody.captureReason, "source-lost");
    }
    assertEquals(transcriptResponse.status, 200);
    assertExists(transcriptBody.manifest);
    const artifactVersionId = transcriptBody.segments[0]?.versionId ??
      transcriptBody.manifest.versionId;
    assertExists(artifactVersionId);
    const artifactResponse = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${artifactVersionId}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    const artifactText = await artifactResponse.text();
    assertEquals(artifactResponse.status, 200, artifactText);
    const segmentArtifact = JSON.parse(artifactText) as {
      batches?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    assert(
      segmentArtifact.batches?.some((batch) =>
        batch.parts?.some((part) => part.text?.includes('"type":"result"'))
      ) === true,
    );
    const manifestVersionId = transcriptBody.manifest.versionId;
    const manifestResponse = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${manifestVersionId}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    const manifestText = await manifestResponse.text();
    assertEquals(manifestResponse.status, 200, manifestText);
    assert(manifestText.includes('"segments"'));
  } finally {
    if (scratchDir) {
      await Deno.remove(scratchDir, { recursive: true }).catch(() => undefined);
    }
    await closeWorkerFixture(fixture);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}
Deno.test("output close 422 does not kill real Claude worker teardown", () =>
  runTeardownScenario(false));

Deno.test(
  "terminal result force-closes output after close 422 before mutation",
  () => runTeardownScenario(true),
);
