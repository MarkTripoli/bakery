import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import {
  generateContracts,
  MAX_ARTIFACT_BYTES,
  workerActionCapabilities,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { requestDigest } from "../../apps/server/src/modules/execution/shared.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  type JobSeed,
  problemCode,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerRequest,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  eventBody,
  postWorkerEvent,
  postWorkerResult,
  resultBody,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

Deno.test(
  "publishes artifact content Range transport as a header with 206",
  () => {
    const generated = generateContracts();
    const operation = (generated.openapi.paths as Record<string, unknown>)[
      "/v1/artifact-versions/{id}/content"
    ] as Record<string, unknown>;
    const get = operation.get as {
      parameters: Array<Record<string, unknown>>;
      responses: Record<string, unknown>;
    };
    const range = get.parameters.find((parameter) =>
      parameter.name === "Range"
    );
    assertExists(range);
    assertEquals(range.in, "header");
    assertEquals(Object.hasOwn(get.responses, "206"), true);
  },
);

Deno.test("route bounds multipart overflow and rejects ignored parts without state", async () => {
  await withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const path =
      `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`;
    const send = async (form: FormData, key: string): Promise<Response> =>
      await fixture.app.fetch(
        new Request(path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": key,
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: form,
        }),
      );
    const baseForm = (): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("artifactType", "patch");
      form.set("name", "bounded-route");
      form.set("contentType", "application/octet-stream");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      return form;
    };

    const oversized = baseForm();
    oversized.set(
      "content",
      new File(
        [new Uint8Array(MAX_ARTIFACT_BYTES + 1_048_577)],
        "oversized.bin",
      ),
    );
    const overflowResponse = await send(oversized, crypto.randomUUID());
    assertEquals(overflowResponse.status, 413);
    assertEquals(await problemCode(overflowResponse), "BODY_TOO_LARGE");
    assertEquals(
      overflowResponse.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );

    const artifactOversized = baseForm();
    artifactOversized.set(
      "content",
      new File(
        [new Uint8Array(MAX_ARTIFACT_BYTES + 1)],
        "artifact-oversized.bin",
      ),
    );
    const artifactOverflowResponse = await send(
      artifactOversized,
      crypto.randomUUID(),
    );
    assertEquals(artifactOverflowResponse.status, 413);
    assertEquals(
      await problemCode(artifactOverflowResponse),
      "BODY_TOO_LARGE",
    );

    const streamBoundary = "issue41-stream-boundary";
    const streamResponse = await fixture.app.fetch(
      new Request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${worker.credential}`,
          "idempotency-key": crypto.randomUUID(),
          "X-Bakery-Worker-Protocol-Version": "2",
          "content-type": `multipart/form-data; boundary=${streamBoundary}`,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`--${streamBoundary}\r\n`),
            );
            controller.enqueue(
              new Uint8Array(MAX_ARTIFACT_BYTES + 1_048_577),
            );
            controller.close();
          },
        }),
      }),
    );
    assertEquals(streamResponse.status, 413);
    assertEquals(await problemCode(streamResponse), "BODY_TOO_LARGE");
    const ignored = baseForm();
    ignored.set("content", new File([new Uint8Array([1])], "ignored.bin"));
    ignored.set("ignored", "not-an-artifact-field");
    const ignoredResponse = await send(ignored, crypto.randomUUID());
    assertEquals(ignoredResponse.status, 422);
    assertEquals(await problemCode(ignoredResponse), "UNPROCESSABLE");
    assertEquals(
      ignoredResponse.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );

    const state = await fixture.pgDatabase.query<{
      versions: number;
      replays: number;
    }>(
      `select
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions,
         (select count(*)::int from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $3) as replays`,
      [fixture.organizationId, job.taskId, assignment.attemptId],
    );

    assertEquals(state.rows, [{ versions: 0, replays: 0 }]);
  });
});
Deno.test("rejects malformed prototype and overlong uploads without facts", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const makeForm = (): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", worker.registration.workerSessionId);
      form.set(
        "workerSessionGeneration",
        String(worker.registration.workerSessionGeneration),
      );
      form.set("artifactType", "patch");
      form.set("name", "malformed-upload");
      form.set("contentType", "application/octet-stream");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("metadata", "{}");
      form.set("content", new File(["malformed"], "malformed.bin"));
      return form;
    };
    const send = async (form: FormData): Promise<Response> =>
      await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": crypto.randomUUID(),
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: form,
          },
        ),
      );
    const malformedFence = makeForm();
    malformedFence.set("fence", "abc");
    const prototypeType = makeForm();
    prototypeType.set("artifactType", "constructor");
    const prototypeField = makeForm();
    prototypeField.set("constructor", "not-an-artifact-field");
    const overlongProvenance = makeForm();
    const loneHighValue = makeForm();
    loneHighValue.set("metadata", String.raw`{"ok":"\ud800"}`);
    const loneLowKey = makeForm();
    loneLowKey.set("metadata", String.raw`{"\udc00":"ok"}`);
    overlongProvenance.set("subjectHeadSha", "a".repeat(65_537));
    for (
      const form of [
        malformedFence,
        prototypeType,
        prototypeField,
        overlongProvenance,
        loneHighValue,
        loneLowKey,
      ]
    ) {
      const response = await send(form);
      assertEquals(response.status, 422, await response.clone().text());
      assertEquals(await problemCode(response), "UNPROCESSABLE");
      assertEquals(
        response.headers.get("X-Bakery-Worker-Protocol-Version"),
        "2",
      );
    }
    const facts = await fixture.pgDatabase.query<{
      artifacts: number;
      versions: number;
      events: number;
      replays: number;
    }>(
      `select
         (select count(*)::int from bakery.artifacts
           where organization_id = $1 and task_id = $2) as artifacts,
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1 and task_id = $2
             and event_type = 'artifact.version_created') as events,
         (select count(*)::int from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $3) as replays`,
      [fixture.organizationId, job.taskId, assignment.attemptId],
    );
    assertEquals(facts.rows, [{
      artifacts: 0,
      versions: 0,
      events: 0,
      replays: 0,
    }]);
  });
});

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
async function cleanupPublishedArtifacts(
  fixture: Pick<WorkerFixture, "organizationId" | "pgDatabase">,
): Promise<void> {
  await fixture.pgDatabase.query(
    `delete from bakery.artifact_versions
      where organization_id = $1`,
    [fixture.organizationId],
  );
  await fixture.pgDatabase.query(
    `delete from bakery.artifacts
      where organization_id = $1`,
    [fixture.organizationId],
  );
}

type RelatedFundedJob = JobSeed & { readonly stepKey: string };

/** Two funded steps share the current run/task/profile to promote one artifact. */
async function seedRelatedFundedModelJobs(
  fixture: WorkerFixture,
): Promise<readonly [RelatedFundedJob, RelatedFundedJob]> {
  const seededRun = await seedAdmissibleRun(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    { stepKey: "worker" },
  );
  assertExists(seededRun.billing);
  const firstSessionId = seededRun.sessionId;
  assertExists(firstSessionId);
  const firstRun = { ...seededRun, workflowVersionId: crypto.randomUUID() };
  const laterRun = {
    ...firstRun,
    runStepId: crypto.randomUUID(),
    stepKey: "worker_later",
    sessionId: crypto.randomUUID(),
  };
  // Claims require the task's current run. Two simultaneous publishers must
  // therefore be distinct steps of that run, not competing current runs.
  // Prepare a new pinned workflow version before either production admission;
  // leave the original published version and run.requested trace untouched.
  const expanded = await fixture.pgDatabase.query<{
    spec: Record<string, unknown>;
  }>(
    `select normalized_spec || jsonb_build_object(
       'steps', (normalized_spec->'steps') || jsonb_build_array(
         (normalized_spec->'steps'->0) || jsonb_build_object('id', $3::text)
       )
     ) as spec
       from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, seededRun.workflowVersionId, laterRun.stepKey],
  );
  const spec = expanded.rows[0]?.spec;
  assertExists(spec);
  const digest = await requestDigest(spec);
  await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    await transaction.query(
      `insert into bakery.workflow_versions (
         id, organization_id, workflow_id, revision, source_yaml,
         normalized_spec, digest, status, created_by
       ) select $3, organization_id, workflow_id, revision + 1, '',
                $4::jsonb, $5, 'published', created_by
           from bakery.workflow_versions
          where organization_id = $1 and id = $2`,
      [
        fixture.organizationId,
        seededRun.workflowVersionId,
        firstRun.workflowVersionId,
        JSON.stringify(spec),
        digest,
      ],
    );
    await transaction.query(
      `update bakery.workflow_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, firstRun.workflowId, firstRun.workflowVersionId],
    );
    await transaction.query(
      `update bakery.workflow_runs
          set workflow_version_id = $3,
              snapshot = jsonb_set(
                jsonb_set(snapshot, '{workflow}', jsonb_build_object(
                  'id', $3::uuid, 'revision', 2, 'digest', $4::text,
                  'normalizedSpec', $5::jsonb
                )),
                '{stepAgents}', (snapshot->'stepAgents') || jsonb_build_object(
                  $6::text, snapshot->'stepAgents'->$7::text
                )
              )
        where organization_id = $1 and id = $2`,
      [
        fixture.organizationId,
        firstRun.runId,
        firstRun.workflowVersionId,
        digest,
        JSON.stringify(spec),
        laterRun.stepKey,
        firstRun.stepKey,
      ],
    );
  });
  await fixture.pgDatabase.query(
    `insert into bakery.run_steps (
       id, organization_id, run_id, step_key, position, iteration, status, input
     )
     select $2, organization_id, $3, $5, position + 1, iteration, 'pending', input
       from bakery.run_steps
      where organization_id = $1 and id = $4`,
    [
      fixture.organizationId,
      laterRun.runStepId,
      laterRun.runId,
      firstRun.runStepId,
      laterRun.stepKey,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.agent_sessions (
       id, organization_id, run_step_id, conversation_id, agent_version_id,
       harness, status
     )
     select $2, organization_id, $3, conversation_id, agent_version_id,
            harness, 'active'
       from bakery.agent_sessions
      where organization_id = $1 and id = $4`,
    [
      fixture.organizationId,
      laterRun.sessionId,
      laterRun.runStepId,
      firstSessionId,
    ],
  );
  await seedProviderPricingSnapshot(fixture.pgDatabase, {
    billing: seededRun.billing,
  });
  const firstJob = await admitFundedModelRun(fixture.pgDatabase, firstRun, {
    maxAttempts: 3,
  });
  const laterJob = await admitFundedModelRun(fixture.pgDatabase, laterRun, {
    maxAttempts: 3,
  });
  assertEquals(firstJob.taskId, laterJob.taskId);
  assertEquals(firstJob.runId, laterJob.runId);
  assertEquals(firstJob.runStepId === laterJob.runStepId, false);
  assertEquals(firstJob.jobId === laterJob.jobId, false);
  assertEquals(firstJob.intentId === laterJob.intentId, false);
  assertEquals(
    firstJob.installationReservationId === laterJob.installationReservationId,
    false,
  );
  assertEquals(firstJob.runReservationId === laterJob.runReservationId, false);
  const task = await fixture.pgDatabase.query<{ currentRunId: string }>(
    `select current_run_id as "currentRunId" from bakery.tasks
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, firstJob.taskId],
  );
  assertEquals(task.rows, [{ currentRunId: firstJob.runId }]);
  return [
    { ...firstJob, sessionId: firstSessionId },
    { ...laterJob, sessionId: laterRun.sessionId },
  ];
}

async function withArtifactWorkerFixture<T>(
  work: (fixture: WorkerFixture) => Promise<T>,
): Promise<T> {
  return await withWorkerFixture(async (fixture) => {
    try {
      return await work(fixture);
    } finally {
      await cleanupPublishedArtifacts(fixture);
    }
  });
}

Deno.test(
  "deleting a run step cascades versions and clears current pointer",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const artifactId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const unrelatedArtifactId = crypto.randomUUID();
      const unrelatedVersionId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.artifacts (
           id, organization_id, task_id, artifact_type, name
         ) values
           ($1, $2, $3, 'patch', $4),
           ($5, $2, $3, 'patch', $6)`,
        [
          artifactId,
          fixture.organizationId,
          job.taskId,
          `deletion-${artifactId}`,
          unrelatedArtifactId,
          `unrelated-${unrelatedArtifactId}`,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.artifact_versions (
           id, organization_id, artifact_id, task_id, run_step_id,
           author_id, revision, content, sha256, size_bytes, media_type
         ) values (
           $1, $2, $3, $4, $5, $6, 1, decode('010203', 'hex'), $7, 3,
           'application/octet-stream'
         )`,
        [
          versionId,
          fixture.organizationId,
          artifactId,
          job.taskId,
          job.runStepId,
          fixture.principalId,
          "a".repeat(64),
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.artifact_versions (
           id, organization_id, artifact_id, task_id, author_id,
           revision, content, sha256, size_bytes, media_type
         ) values (
           $1, $2, $3, $4, $5, 1, decode('040506', 'hex'), $6, 3,
           'application/octet-stream'
         )`,
        [
          unrelatedVersionId,
          fixture.organizationId,
          unrelatedArtifactId,
          job.taskId,
          fixture.principalId,
          "b".repeat(64),
        ],
      );
      await fixture.pgDatabase.query(
        `update bakery.artifacts
            set current_version_id = $1
          where organization_id = $2 and id = $3`,
        [versionId, fixture.organizationId, artifactId],
      );
      await fixture.pgDatabase.query(
        `update bakery.artifacts
            set current_version_id = $1
          where organization_id = $2 and id = $3`,
        [unrelatedVersionId, fixture.organizationId, unrelatedArtifactId],
      );

      await fixture.pgDatabase.query(
        `delete from bakery.run_steps
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, job.runStepId],
      );

      const remaining = await fixture.pgDatabase.query<{
        artifacts: number;
        target_versions: number;
        target_current_version_id: string | null;
        unrelated_versions: number;
        unrelated_current_version_id: string | null;
      }>(
        `select
           (select count(*)::int from bakery.artifacts
             where organization_id = $1 and id = $2) as artifacts,
           (select count(*)::int from bakery.artifact_versions
             where organization_id = $1 and id = $3) as target_versions,
           (select current_version_id from bakery.artifacts
             where organization_id = $1 and id = $2)
             as target_current_version_id,
           (select count(*)::int from bakery.artifact_versions
             where organization_id = $1 and id = $5) as unrelated_versions,
           (select current_version_id from bakery.artifacts
             where organization_id = $1 and id = $4)
             as unrelated_current_version_id`,
        [
          fixture.organizationId,
          artifactId,
          versionId,
          unrelatedArtifactId,
          unrelatedVersionId,
        ],
      );
      assertEquals(remaining.rows, [{
        artifacts: 1,
        target_versions: 0,
        target_current_version_id: null,
        unrelated_versions: 1,
        unrelated_current_version_id: unrelatedVersionId,
      }]);

      const pointerError = await assertRejects(
        () =>
          fixture.pgDatabase.query(
            `update bakery.artifacts
                set current_version_id = $1
              where organization_id = $2 and id = $3`,
            [unrelatedVersionId, fixture.organizationId, artifactId],
          ),
        Error,
      );
      const pointerErrorCode = pointerError &&
          typeof pointerError === "object" &&
          "code" in pointerError &&
          typeof pointerError.code === "string"
        ? pointerError.code
        : undefined;
      assertEquals(pointerErrorCode, "23503");
    });
  },
);

Deno.test("publishes fixed workflow artifact bytes through the live route", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const workerSessionId = worker.registration.workerSessionId;
    const workerSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );
    const bytes = new TextEncoder().encode("fixed-workflow-artifact");
    const metadata = { source: "worker", purpose: "phase-1-proof" };
    const idempotencyKey = `artifact-publication-${crypto.randomUUID()}`;
    const contentDigest = "f".repeat(64);
    const traceId = crypto.randomUUID();
    const digest = await sha256Bytes(bytes);

    const createForm = (): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("workerSessionId", workerSessionId);
      form.set("workerSessionGeneration", workerSessionGeneration);
      form.set("fence", assignment.fence);
      form.set("artifactType", "patch");
      form.set("name", `fixed-workflow-${job.jobId}`);
      form.set("contentType", "application/octet-stream");
      form.set("contentDigest", contentDigest);
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("metadata", JSON.stringify(metadata));
      form.set("content", new File([bytes], "artifact.bin"));
      return form;
    };
    const request = (ifMatch?: string): Request => {
      const headers = new Headers({
        authorization: `Bearer ${worker.credential}`,
        "idempotency-key": idempotencyKey,
        "X-Bakery-Worker-Protocol-Version": "2",
        "x-trace-id": traceId,
      });
      if (ifMatch !== undefined) headers.set("if-match", ifMatch);
      return new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers,
          body: createForm(),
        },
      );
    };

    for (const ifMatch of ["", "   "]) {
      const rejected = await fixture.app.fetch(request(ifMatch));
      assertEquals(rejected.status, 412, await rejected.clone().text());
      assertEquals(await problemCode(rejected), "PRECONDITION_FAILED");
    }
    const preconditionFacts = await fixture.pgDatabase.query<{
      artifacts: number;
      versions: number;
    }>(
      `select
         (select count(*)::int from bakery.artifacts
           where organization_id = $1 and task_id = $2) as artifacts,
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions`,
      [fixture.organizationId, job.taskId],
    );
    assertEquals(preconditionFacts.rows, [{ artifacts: 0, versions: 0 }]);
    const first = await fixture.app.fetch(request());

    assertEquals(first.status, 201, await first.clone().text());
    assertEquals(
      first.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const response = await first.json() as {
      artifactId: string;
      id: string;
      sha256: string;
      sizeBytes: number;
      mediaType: string;
      metadata: unknown;
      revision: number;
    };
    assertEquals(response.sha256, digest);
    assertEquals(response.sizeBytes, bytes.byteLength);
    assertEquals(response.mediaType, "application/octet-stream");
    assertEquals(response.metadata, metadata);
    assertEquals(response.revision, 1);
    const missingIfMatch = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": crypto.randomUUID(),
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: createForm(),
        },
      ),
    );
    assertEquals(
      missingIfMatch.status,
      428,
      await missingIfMatch.clone().text(),
    );
    assertEquals(await problemCode(missingIfMatch), "PRECONDITION_REQUIRED");
    const rejectIfMatch = async (ifMatch: string): Promise<void> => {
      const rejected = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": crypto.randomUUID(),
              "if-match": ifMatch,
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: createForm(),
          },
        ),
      );
      assertEquals(rejected.status, 412, await rejected.clone().text());
      assertEquals(await problemCode(rejected), "PRECONDITION_FAILED");
    };
    await rejectIfMatch(response.id);
    await rejectIfMatch(`"${response.id}","${response.id}"`);
    await rejectIfMatch("");
    await rejectIfMatch("   ");
    const rejectedFacts = await fixture.pgDatabase.query<{
      versions: number;
      currentVersionId: string | null;
    }>(
      `select
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions,
         (select current_version_id from bakery.artifacts
           where organization_id = $1 and task_id = $2
             and name = $3) as "currentVersionId"`,
      [fixture.organizationId, job.taskId, `fixed-workflow-${job.jobId}`],
    );
    assertEquals(rejectedFacts.rows, [{
      versions: 1,
      currentVersionId: response.id,
    }]);

    let artifactVersionUpdateCode: string | undefined;
    try {
      await fixture.runtimePgDatabase.query(
        `update bakery.artifact_versions
            set content = content
          where id = $1`,
        [response.id],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        artifactVersionUpdateCode = error.code;
      }
    }
    assertEquals(artifactVersionUpdateCode, "42501");

    const requestFingerprint = await requestDigest({
      idempotencyKey,
      leaseTokenHash: await sha256Bytes(
        new TextEncoder().encode(assignment.leaseToken),
      ),
      fence: assignment.fence,
      artifactType: "patch",
      name: `fixed-workflow-${job.jobId}`,
      contentType: "application/octet-stream",
      contentDigest,
      contentSha256: digest,
      runStepId: job.runStepId,
      subjectHeadSha: null,
      subjectBaseSha: null,
      stepKey: "worker",
      metadata,
      parentVersionId: null,
    });

    const replay = await fixture.app.fetch(request());
    assertEquals(replay.status, 201);
    assertEquals(await replay.json(), response);

    const mismatchForm = createForm();
    mismatchForm.set(
      "metadata",
      JSON.stringify({ source: "worker", purpose: "mismatch" }),
    );
    const mismatch = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": idempotencyKey,
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: mismatchForm,
        },
      ),
    );
    assertEquals(mismatch.status, 422);
    assertEquals(await problemCode(mismatch), "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(
      mismatch.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );

    const versionResult = await fixture.pgDatabase.query<{
      artifactId: string;
      taskId: string;
      runStepId: string;
      revision: number;
      content: Uint8Array;
      sha256: string;
      sizeBytes: number;
      mediaType: string;
      metadata: unknown;
      currentVersionId: string;
      artifactRevision: number;
      artifactVersion: number;
    }>(
      `select version.artifact_id as "artifactId",
              version.task_id as "taskId",
              version.run_step_id as "runStepId",
              version.revision,
              version.content,
              version.sha256,
              version.size_bytes as "sizeBytes",
              version.media_type as "mediaType",
              version.metadata,
              artifact.current_version_id as "currentVersionId",
              artifact.revision as "artifactRevision",
              artifact.version as "artifactVersion"
         from bakery.artifact_versions as version
         join bakery.artifacts as artifact
           on artifact.organization_id = version.organization_id
          and artifact.id = version.artifact_id
        where version.organization_id = $1
          and version.id = $2`,
      [fixture.organizationId, response.id],
    );
    const version = versionResult.rows[0];
    assertExists(version);
    assertEquals(version.artifactId, response.artifactId);
    assertEquals(version.taskId, job.taskId);
    assertEquals(version.runStepId, job.runStepId);
    assertEquals(version.revision, response.revision);
    assertEquals(Array.from(version.content), Array.from(bytes));
    assertEquals(version.sha256, response.sha256);
    assertEquals(version.sizeBytes, response.sizeBytes);
    assertEquals(version.mediaType, response.mediaType);
    assertEquals(version.metadata, response.metadata);
    assertEquals(version.currentVersionId, response.id);
    assertEquals(version.artifactRevision, 2);
    assertEquals(version.artifactVersion, 2);

    const eventResult = await fixture.pgDatabase.query<{
      id: string;
      eventType: string;
      aggregateId: string;
      aggregateVersion: number;
      taskId: string;
      traceId: string;
      payload: unknown;
    }>(
      `select id,
              event_type as "eventType",
              aggregate_id as "aggregateId",
              aggregate_version as "aggregateVersion",
              task_id as "taskId",
              trace_id as "traceId",
              payload
         from bakery.domain_events
        where organization_id = $1
          and event_type = 'artifact.version_created'
          and aggregate_id = $2`,
      [fixture.organizationId, response.artifactId],
    );
    assertEquals(eventResult.rows.length, 1);
    const event = eventResult.rows[0];
    assertExists(event);
    assertEquals(event.eventType, "artifact.version_created");
    assertEquals(event.aggregateId, response.artifactId);
    assertEquals(event.aggregateVersion, response.revision + 1);
    assertEquals(event.taskId, job.taskId);
    assertEquals(event.traceId, traceId);
    assertEquals(event.payload, {
      resourceId: response.artifactId,
      resourceVersion: event.aggregateVersion,
    });

    const outboxResult = await fixture.pgDatabase.query<{
      eventId: string;
      destination: string;
      deliveryKey: string;
    }>(
      `select event_id as "eventId",
              destination,
              delivery_key as "deliveryKey"
         from bakery.outbox
        where organization_id = $1
          and event_id = $2`,
      [fixture.organizationId, event.id],
    );
    assertEquals(outboxResult.rows, [{
      eventId: event.id,
      destination: "inngest",
      deliveryKey: `artifact:${response.id}`,
    }]);

    const replayResult = await fixture.pgDatabase.query<{
      requestDigest: string;
      response: unknown;
    }>(
      `select request_digest as "requestDigest", response
         from bakery.artifact_publication_replays
        where organization_id = $1
          and attempt_id = $2
          and idempotency_key = $3`,
      [fixture.organizationId, assignment.attemptId, idempotencyKey],
    );
    assertEquals(replayResult.rows, [{
      requestDigest: requestFingerprint,
      response,
    }]);

    const counts = await fixture.pgDatabase.query<{
      versions: number;
      events: number;
      outbox: number;
      replays: number;
    }>(
      `select
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and artifact_id = $2) as versions,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1 and aggregate_id = $2
             and event_type = 'artifact.version_created') as events,
         (select count(*)::int from bakery.outbox
           where organization_id = $1 and event_id = $3) as outbox,
         (select count(*)::int from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $4
             and idempotency_key = $5) as replays`,
      [
        fixture.organizationId,
        response.artifactId,
        event.id,
        assignment.attemptId,
        idempotencyKey,
      ],
    );
    assertEquals(counts.rows, [{
      versions: 1,
      events: 1,
      outbox: 1,
      replays: 1,
    }]);
    const secondBytes = new TextEncoder().encode("fixed-workflow-artifact-v2");
    const secondForm = new FormData();
    secondForm.set("leaseToken", assignment.leaseToken);
    secondForm.set("fence", assignment.fence);
    secondForm.set("workerSessionId", workerSessionId);
    secondForm.set("workerSessionGeneration", workerSessionGeneration);
    secondForm.set("artifactType", "patch");
    secondForm.set("name", `fixed-workflow-${job.jobId}`);
    secondForm.set("contentType", "application/octet-stream");
    secondForm.set("contentDigest", "f".repeat(64));
    secondForm.set("runStepId", job.runStepId);
    secondForm.set("stepKey", "worker");
    secondForm.set(
      "metadata",
      JSON.stringify({ source: "worker", purpose: "phase-4-proof" }),
    );
    secondForm.set("content", new File([secondBytes], "artifact-v2.bin"));
    const second = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": `artifact-publication-${crypto.randomUUID()}`,
            "if-match": `"${response.id}"`,
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: secondForm,
        },
      ),
    );
    assertEquals(second.status, 201, await second.clone().text());
    const secondResponse = await second.json() as {
      artifactId: string;
      id: string;
      revision: number;
    };
    assertEquals(secondResponse.artifactId, response.artifactId);
    assertEquals(secondResponse.revision, 2);
    const replayAfterPromotion = await fixture.app.fetch(request());
    assertEquals(replayAfterPromotion.status, 201);
    assertEquals(await replayAfterPromotion.json(), response);

    const resourceRequest = async (
      path: string,
      init: RequestInit = {},
      scope: Pick<WorkerScope, "organizationId" | "adminCookie"> = fixture,
    ): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("cookie", scope.adminCookie);
      headers.set("origin", fixture.config.publicBaseUrl);
      headers.set("Bakery-Organization-Id", scope.organizationId);
      return await fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}${path}`, {
          ...init,
          headers,
        }),
      );
    };

    const listed = await resourceRequest(
      `/v1/artifacts?taskId=${job.taskId}`,
    );
    assertEquals(listed.status, 200, await listed.clone().text());
    const artifactPage = await listed.json() as {
      items: Array<{
        id: string;
        currentVersionId: string;
        version: number;
      }>;
      nextCursor: string | null;
    };
    const listedArtifact = artifactPage.items[0];
    assertExists(listedArtifact);
    assertEquals(listedArtifact.id, response.artifactId);
    assertEquals(listedArtifact.currentVersionId, secondResponse.id);
    assertEquals(listedArtifact.version, 3);
    assertEquals(artifactPage.nextCursor, null);

    const artifactGet = await resourceRequest(
      `/v1/artifacts/${response.artifactId}`,
    );
    assertEquals(artifactGet.status, 200, await artifactGet.clone().text());
    assertEquals(
      (await artifactGet.json()).currentVersionId,
      secondResponse.id,
    );

    const versions = await resourceRequest(
      `/v1/artifacts/${response.artifactId}/versions?limit=1`,
    );
    assertEquals(versions.status, 200, await versions.clone().text());
    const versionPage = await versions.json() as {
      items: Array<{ id: string; revision: number }>;
      nextCursor: string | null;
    };
    const newestVersion = versionPage.items[0];
    assertExists(newestVersion);
    assertEquals(newestVersion.id, secondResponse.id);
    assertEquals(newestVersion.revision, 2);
    assertExists(versionPage.nextCursor);

    const remainingVersions = await resourceRequest(
      `/v1/artifacts/${response.artifactId}/versions?cursor=${
        encodeURIComponent(versionPage.nextCursor)
      }&limit=1`,
    );
    assertEquals(
      remainingVersions.status,
      200,
      await remainingVersions.clone().text(),
    );
    const remainingVersionPage = await remainingVersions.json() as {
      items: Array<{ id: string; revision: number }>;
    };
    const previousVersion = remainingVersionPage.items[0];
    assertExists(previousVersion);
    assertEquals(previousVersion.id, response.id);
    assertEquals(previousVersion.revision, 1);

    const oversizedCursor = await resourceRequest(
      `/v1/artifacts/${response.artifactId}/versions?cursor=${"a".repeat(513)}`,
    );
    assertEquals(oversizedCursor.status, 400);
    const forgedCursor = await resourceRequest(
      `/v1/artifacts/${response.artifactId}/versions?cursor=${
        encodeURIComponent(versionPage.nextCursor.slice(0, -1) + "x")
      }`,
    );
    assertEquals(forgedCursor.status, 400);

    const promoted = await resourceRequest(
      `/v1/artifact-versions/${secondResponse.id}/content`,
    );
    assertEquals(promoted.status, 200);
    assertEquals(await promoted.text(), "fixed-workflow-artifact-v2");

    const whole = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
    );
    assertEquals(whole.status, 200);
    assertEquals(await whole.text(), "fixed-workflow-artifact");
    assertEquals(whole.headers.get("content-length"), String(bytes.byteLength));
    assertEquals(whole.headers.get("etag"), `"${digest}"`);
    assertEquals(whole.headers.get("cache-control"), "no-store");
    assertEquals(whole.headers.get("accept-ranges"), "bytes");
    assertEquals(
      whole.headers.get("content-type"),
      "application/octet-stream",
    );
    assertEquals(
      whole.headers.get("content-disposition"),
      'attachment; filename="artifact.bin"',
    );
    assertEquals(whole.headers.get("content-security-policy"), "sandbox");
    assertEquals(whole.headers.get("x-content-type-options"), "nosniff");

    const ranged = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=0-4" } },
    );
    assertEquals(ranged.status, 206);
    assertEquals(await ranged.text(), "fixed");
    assertEquals(
      ranged.headers.get("content-range"),
      `bytes 0-4/${bytes.byteLength}`,
    );
    assertEquals(ranged.headers.get("content-length"), "5");
    assertEquals(ranged.headers.get("cache-control"), "no-store");
    assertEquals(ranged.headers.get("etag"), `"${digest}"`);
    assertEquals(
      ranged.headers.get("content-type"),
      "application/octet-stream",
    );
    assertEquals(
      ranged.headers.get("content-disposition"),
      'attachment; filename="artifact.bin"',
    );
    const matchingIfRange = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      {
        headers: {
          range: "bytes=0-4",
          "if-range": `"${digest}"`,
        },
      },
    );
    assertEquals(matchingIfRange.status, 206);
    assertEquals(await matchingIfRange.text(), "fixed");
    assertEquals(
      matchingIfRange.headers.get("content-range"),
      `bytes 0-4/${bytes.byteLength}`,
    );

    const mismatchedIfRange = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      {
        headers: {
          range: "bytes=0-4",
          "if-range": `"${"0".repeat(64)}"`,
        },
      },
    );
    assertEquals(mismatchedIfRange.status, 200);
    assertEquals(await mismatchedIfRange.text(), "fixed-workflow-artifact");
    assertEquals(
      mismatchedIfRange.headers.get("content-length"),
      String(bytes.byteLength),
    );
    assertEquals(mismatchedIfRange.headers.get("content-range"), null);

    const mismatchedUnsatisfiableIfRange = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      {
        headers: {
          range: "bytes=999-1000",
          "if-range": `"${"0".repeat(64)}"`,
        },
      },
    );
    assertEquals(mismatchedUnsatisfiableIfRange.status, 200);
    assertEquals(
      await mismatchedUnsatisfiableIfRange.text(),
      "fixed-workflow-artifact",
    );
    assertEquals(
      mismatchedUnsatisfiableIfRange.headers.get("content-length"),
      String(bytes.byteLength),
    );
    assertEquals(
      mismatchedUnsatisfiableIfRange.headers.get("content-range"),
      null,
    );
    const mismatchedUnsafeIfRange = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      {
        headers: {
          range: "bytes=0-9223372036854775807",
          "if-range": `"${"0".repeat(64)}"`,
        },
      },
    );
    assertEquals(mismatchedUnsafeIfRange.status, 200);
    assertEquals(
      await mismatchedUnsafeIfRange.text(),
      "fixed-workflow-artifact",
    );
    assertEquals(
      mismatchedUnsafeIfRange.headers.get("content-length"),
      String(bytes.byteLength),
    );
    assertEquals(mismatchedUnsafeIfRange.headers.get("content-range"), null);
    const hugeStart = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=99999999999999999999-" } },
    );
    assertEquals(hugeStart.status, 416);
    assertEquals(
      hugeStart.headers.get("content-range"),
      `bytes */${bytes.byteLength}`,
    );

    const hugeSuffix = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=-99999999999999999999" } },
    );
    assertEquals(hugeSuffix.status, 206);
    assertEquals(await hugeSuffix.text(), "fixed-workflow-artifact");
    assertEquals(
      hugeSuffix.headers.get("content-range"),
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
    );

    assertEquals(ranged.headers.get("content-security-policy"), "sandbox");
    assertEquals(ranged.headers.get("x-content-type-options"), "nosniff");
    const suffix = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=-5" } },
    );
    assertEquals(suffix.status, 206);
    assertEquals(await suffix.text(), "ifact");
    assertEquals(suffix.headers.get("content-length"), "5");
    assertEquals(
      suffix.headers.get("content-range"),
      `bytes 18-22/${bytes.byteLength}`,
    );
    assertEquals(suffix.headers.get("cache-control"), "no-store");

    const emptySuffix = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=-0" } },
    );
    assertEquals(emptySuffix.status, 416);
    assertEquals((await emptySuffix.arrayBuffer()).byteLength, 0);
    assertEquals(
      emptySuffix.headers.get("content-range"),
      `bytes */${bytes.byteLength}`,
    );
    assertEquals(emptySuffix.headers.get("cache-control"), "no-store");

    const client = createBakeryClient({
      baseUrl: fixture.config.publicBaseUrl,
      getContext: () => ({ organizationId: fixture.organizationId }),
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", fixture.adminCookie);
        headers.set("origin", fixture.config.publicBaseUrl);
        headers.set("Bakery-Organization-Id", fixture.organizationId);
        return await fixture.app.fetch(
          new Request(input, { ...init, headers }),
        );
      },
    });
    const clientFull = await client.actions["artifactVersions.content"]({
      id: response.id,
    });
    assertEquals(clientFull.status, 200);
    assertEquals(Array.from(clientFull.content), Array.from(bytes));
    assertEquals(clientFull.contentLength, bytes.byteLength);
    assertEquals(clientFull.contentDigest, digest);
    const clientRange = await client.actions["artifactVersions.content"]({
      id: response.id,
      range: "bytes=0-4",
    });
    assertEquals(clientRange.status, 206);
    assertEquals(
      Array.from(clientRange.content),
      Array.from(bytes.slice(0, 5)),
    );
    assertEquals(clientRange.contentRange, `bytes 0-4/${bytes.byteLength}`);
    assertEquals(clientRange.contentLength, 5);

    const unsatisfiable = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=999-1000" } },
    );
    assertEquals(unsatisfiable.status, 416);
    assertEquals((await unsatisfiable.arrayBuffer()).byteLength, 0);
    assertEquals(
      unsatisfiable.headers.get("content-range"),
      `bytes */${bytes.byteLength}`,
    );
    assertEquals(unsatisfiable.headers.get("cache-control"), "no-store");
    assertEquals(unsatisfiable.headers.get("content-length"), "0");
    const reversedRange = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=5-4" } },
    );
    assertEquals(reversedRange.status, 416);
    assertEquals((await reversedRange.arrayBuffer()).byteLength, 0);
    assertEquals(
      reversedRange.headers.get("content-range"),
      `bytes */${bytes.byteLength}`,
    );
    assertEquals(reversedRange.headers.get("cache-control"), "no-store");
    assertEquals(reversedRange.headers.get("content-length"), "0");

    const multiple = await resourceRequest(
      `/v1/artifact-versions/${response.id}/content`,
      { headers: { range: "bytes=0-1,3-4" } },
    );
    assertEquals(multiple.status, 400);
    assertEquals(
      (await multiple.text()).includes("fixed-workflow-artifact"),
      false,
    );
    const malformedId = await resourceRequest(
      "/v1/artifact-versions/not-a-uuid/content",
    );
    assertEquals(malformedId.status, 400);
    assertEquals(
      malformedId.headers.get("content-type")?.startsWith(
        "application/problem+json",
      ),
      true,
    );
    assertEquals(await problemCode(malformedId), "MALFORMED_REQUEST");

    const crossOrg = await createWorkerScope(
      fixture,
      "issue41-resource",
      fixture,
    );
    try {
      const denied = await resourceRequest(
        `/v1/artifact-versions/${response.id}/content`,
        {},
        crossOrg,
      );
      assertEquals(denied.status, 404);
      assertEquals(
        (await denied.text()).includes("fixed-workflow-artifact"),
        false,
      );
    } finally {
      await closeWorkerScope(fixture, crossOrg);
    }

    const otherJob = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set run_step_id = $1
        where organization_id = $2 and id = $3`,
      [otherJob.runStepId, fixture.organizationId, response.id],
    );
    try {
      const denied = await resourceRequest(
        `/v1/artifact-versions/${response.id}/content`,
      );
      assertEquals(denied.status, 404);
      assertEquals(
        (await denied.text()).includes("fixed-workflow-artifact"),
        false,
      );
    } finally {
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions
            set run_step_id = $1
          where organization_id = $2 and id = $3`,
        [job.runStepId, fixture.organizationId, response.id],
      );
    }
  });
});

Deno.test(
  "paginates artifacts with task, repository, and type filters",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const repositoryId = crypto.randomUUID();
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
        { input: { repositoryId, planArtifact: crypto.randomUUID() } },
      );
      const artifactIds: string[] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      const baseCreatedAt = new Date("2026-09-22T00:00:00.000Z");
      for (const [index, artifactId] of artifactIds.entries()) {
        const createdAt = new Date(baseCreatedAt.getTime() + index);
        await fixture.pgDatabase.query(
          `insert into bakery.artifacts (
             id, organization_id, task_id, artifact_type, name,
             created_at, updated_at
           ) values ($1, $2, $3, 'patch', $4, $5, $5)`,
          [
            artifactId,
            fixture.organizationId,
            job.taskId,
            `cursor-artifact-${index}`,
            createdAt,
          ],
        );
      }
      const list = async (
        cursor: string | undefined,
        artifactType = "patch",
      ): Promise<Response> => {
        const query = new URLSearchParams({
          taskId: job.taskId,
          repositoryId,
          artifactType,
          limit: "1",
        });
        if (cursor !== undefined) query.set("cursor", cursor);
        return await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/artifacts?${query}`,
            {
              headers: {
                cookie: fixture.adminCookie,
                origin: fixture.config.publicBaseUrl,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
      };
      type ArtifactPage = {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      const first = await list(undefined);
      assertEquals(first.status, 200, await first.clone().text());
      const firstPage = await first.json() as ArtifactPage;
      assertEquals(firstPage.items.length, 1);
      assertExists(firstPage.nextCursor);

      const second = await list(firstPage.nextCursor);
      assertEquals(second.status, 200, await second.clone().text());
      const secondPage = await second.json() as ArtifactPage;
      assertEquals(secondPage.items.length, 1);
      assertExists(secondPage.nextCursor);

      const third = await list(secondPage.nextCursor);
      assertEquals(third.status, 200, await third.clone().text());
      const thirdPage = await third.json() as ArtifactPage;
      assertEquals(thirdPage.items.length, 1);
      assertEquals(
        [
          firstPage.items[0]?.id,
          secondPage.items[0]?.id,
          thirdPage.items[0]?.id,
        ],
        [artifactIds[2], artifactIds[1], artifactIds[0]],
      );
      assertEquals(thirdPage.nextCursor, null);

      const changedFilter = await list(firstPage.nextCursor, "research");
      assertEquals(
        changedFilter.status,
        400,
        await changedFilter.clone().text(),
      );
      assertEquals(await problemCode(changedFilter), "INVALID_CURSOR");
    });
  },
);

Deno.test(
  "continues version pagination across same-millisecond microseconds",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      const publish = async (
        content: string,
        ifMatch?: string,
      ): Promise<{ artifactId: string; id: string }> => {
        const form = new FormData();
        form.set("leaseToken", assignment.leaseToken);
        form.set("workerSessionId", worker.registration.workerSessionId);
        form.set(
          "workerSessionGeneration",
          String(worker.registration.workerSessionGeneration),
        );
        form.set("fence", assignment.fence);
        form.set("artifactType", "patch");
        form.set("name", "same-millisecond");
        form.set("contentType", "application/octet-stream");
        form.set("metadata", "{}");
        form.set("runStepId", job.runStepId);
        form.set("stepKey", "worker");
        form.set("content", new File([content], "same-millisecond.bin"));
        const headers = new Headers({
          authorization: `Bearer ${worker.credential}`,
          "idempotency-key": crypto.randomUUID(),
          "X-Bakery-Worker-Protocol-Version": "2",
        });
        if (ifMatch !== undefined) headers.set("if-match", ifMatch);
        const response = await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
            { method: "POST", headers, body: form },
          ),
        );
        assertEquals(response.status, 201, await response.clone().text());
        return await response.json() as { artifactId: string; id: string };
      };
      const first = await publish("same-millisecond-v1");
      const second = await publish("same-millisecond-v2", `"${first.id}"`);
      const newestCreatedAt = "2026-09-22T00:00:00.123900Z";
      const olderCreatedAt = "2026-09-22T00:00:00.123100Z";
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions
            set created_at = $1::timestamptz
          where organization_id = $2 and id = $3`,
        [newestCreatedAt, fixture.organizationId, second.id],
      );
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions
            set created_at = $1::timestamptz
          where organization_id = $2 and id = $3`,
        [olderCreatedAt, fixture.organizationId, first.id],
      );
      const listVersions = async (cursor?: string): Promise<Response> => {
        const query = new URLSearchParams({ limit: "1" });
        if (cursor !== undefined) query.set("cursor", cursor);
        return await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/artifacts/${first.artifactId}/versions?${query}`,
            {
              headers: {
                cookie: fixture.adminCookie,
                origin: fixture.config.publicBaseUrl,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
      };
      const firstPageResponse = await listVersions();
      assertEquals(
        firstPageResponse.status,
        200,
        await firstPageResponse.clone().text(),
      );
      const firstPage = await firstPageResponse.json() as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      assertEquals(firstPage.items[0]?.id, second.id);
      assertExists(firstPage.nextCursor);

      const secondPageResponse = await listVersions(firstPage.nextCursor);
      assertEquals(
        secondPageResponse.status,
        200,
        await secondPageResponse.clone().text(),
      );
      const secondPage = await secondPageResponse.json() as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      assertEquals(secondPage.items[0]?.id, first.id);
      assertEquals(secondPage.nextCursor, null);
    });
  },
);

Deno.test("admits an immutable ArtifactRef after a later run-step promotion", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 2 });
    const [firstJob, laterJob] = await seedRelatedFundedModelJobs(fixture);
    const firstAssignment = await claimAssignment(fixture, worker);
    assertEquals(firstAssignment.jobId, firstJob.jobId);
    const laterAssignment = await claimAssignment(fixture, worker);
    assertEquals(laterAssignment.jobId, laterJob.jobId);
    const workerSessionId = worker.registration.workerSessionId;
    const workerSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );

    const publish = async (
      assignment: typeof firstAssignment,
      job: typeof firstJob,
      content: string,
      headers: Record<string, string> = {},
    ): Promise<Record<string, unknown>> => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", workerSessionId);
      form.set("workerSessionGeneration", workerSessionGeneration);
      form.set("artifactType", "patch");
      form.set("name", "promoted-reference");
      form.set("contentType", "application/octet-stream");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", job.stepKey);
      form.set("content", new File([content], "promoted.bin"));
      const response = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": crypto.randomUUID(),
              "X-Bakery-Worker-Protocol-Version": "2",
              ...headers,
            },
            body: form,
          },
        ),
      );
      assertEquals(response.status, 201, await response.clone().text());
      assertEquals(
        response.headers.get("X-Bakery-Worker-Protocol-Version"),
        "2",
      );
      return await response.json() as Record<string, unknown>;
    };

    const firstVersion = await publish(
      firstAssignment,
      firstJob,
      "promoted-reference-v1",
    );
    const firstReference = {
      artifactId: firstVersion.artifactId as string,
      versionId: firstVersion.id as string,
      sha256: firstVersion.sha256 as string,
    };
    await publish(
      laterAssignment,
      laterJob,
      "promoted-reference-v2",
      { "if-match": `"${firstReference.versionId}"` },
    );
    let rekeyErrorCode: string | undefined;
    try {
      await fixture.runtimePgDatabase.query(
        `update bakery.artifact_versions
            set id = $1
          where organization_id = $2 and id = $3`,
        [
          crypto.randomUUID(),
          fixture.organizationId,
          firstReference.versionId,
        ],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        rekeyErrorCode = error.code;
      }
    }
    assertEquals(rekeyErrorCode, "42501");

    const lockProbe = await fixture.runtimePgDatabase.query<{ id: string }>(
      `select version.id
         from bakery.artifact_versions as version
         join bakery.artifacts as artifact
           on artifact.organization_id = version.organization_id
          and artifact.id = version.artifact_id
        where version.organization_id = $1
          and version.id = $2
          and version.run_step_id = $3
          and artifact.task_id = $4
          and version.artifact_id = $5
          and version.sha256 = $6
        for key share of version, artifact`,
      [
        fixture.organizationId,
        firstReference.versionId,
        firstJob.runStepId,
        firstJob.taskId,
        firstReference.artifactId,
        firstReference.sha256,
      ],
    );
    assertEquals(lockProbe.rows, [{ id: firstReference.versionId }]);

    const checkpointIdempotencyKey = crypto.randomUUID();
    const checkpoint = await postWorkerEvent(
      fixture,
      worker,
      firstAssignment,
      eventBody(
        firstAssignment,
        checkpointIdempotencyKey,
        "1",
        "2026-09-20T00:00:01.000Z",
        {
          eventType: "job.checkpoint",
          payload: {
            artifact: firstReference,
            resumeHandleRef: "resume-after-promotion",
          },
        },
      ),
      checkpointIdempotencyKey,
      { protocolVersion: 2 },
    );
    assertEquals(checkpoint.status, 200, await checkpoint.clone().text());
    assertEquals(
      checkpoint.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );

    const terminalResultKey = crypto.randomUUID();
    const result = await postWorkerResult(
      fixture,
      worker,
      firstAssignment,
      resultBody(firstAssignment, {
        localSeq: "2",
        result: {
          headSha: "head-after-promotion",
          baseSha: "base-before-promotion",
          sessionId: firstJob.sessionId,
          artifacts: [firstReference],
        },
      }),
      terminalResultKey,
      { protocolVersion: 2 },
    );
    assertEquals(result.status, 200, await result.clone().text());
    const resultRaw = new Uint8Array(await result.arrayBuffer());
    const terminal = await readExecutionState(
      fixture.pgDatabase,
      firstJob.jobId,
    );
    const terminalOutput = workerActionOutputSchema("harness.implement").parse(
      terminal.step.output,
    );
    if (
      terminalOutput === null || typeof terminalOutput !== "object" ||
      !("artifacts" in terminalOutput)
    ) {
      throw new Error("terminal output missing artifacts");
    }
    assertEquals(terminalOutput.artifacts, [firstReference]);
    const terminalEvent = terminal.events.at(-1);
    assertExists(terminalEvent);
    const eventPayload = terminalEvent.payload;
    if (
      eventPayload === null || typeof eventPayload !== "object" ||
      !("result" in eventPayload)
    ) {
      throw new Error("terminal result event payload missing result");
    }
    const eventOutput = workerActionOutputSchema("harness.implement").parse(
      eventPayload.result,
    );
    if (
      eventOutput === null || typeof eventOutput !== "object" ||
      !("artifacts" in eventOutput)
    ) {
      throw new Error("terminal event output missing artifacts");
    }
    assertEquals(eventOutput.artifacts, [firstReference]);
    const replayedResult = await postWorkerResult(
      fixture,
      worker,
      firstAssignment,
      resultBody(firstAssignment, {
        localSeq: "2",
        result: {
          headSha: "head-after-promotion",
          baseSha: "base-before-promotion",
          sessionId: firstJob.sessionId,
          artifacts: [firstReference],
        },
      }),
      terminalResultKey,
      { protocolVersion: 2 },
    );
    assertEquals(replayedResult.status, 200);
    assertEquals(
      replayedResult.headers.get("Idempotent-Replayed"),
      "true",
    );
    assertEquals(new Uint8Array(await replayedResult.arrayBuffer()), resultRaw);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, firstJob.jobId),
      terminal,
    );
    const originalContent = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${firstReference.versionId}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    assertEquals(originalContent.status, 200);
    assertEquals(await originalContent.text(), "promoted-reference-v1");
    assertEquals(
      result.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
  });
});

Deno.test("fences artifact publication from a stale worker process session", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const oldSessionId = worker.registration.workerSessionId;
    const oldGeneration = String(worker.registration.workerSessionGeneration);
    const replacementSessionId = crypto.randomUUID();
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: oldGeneration,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacement.status, 200);
    const replacementBody = await replacement.json() as {
      workerSessionId: string;
      workerSessionGeneration: string;
    };
    assertEquals(replacementBody.workerSessionId, replacementSessionId);

    const form = new FormData();
    form.set("leaseToken", assignment.leaseToken);
    form.set("fence", assignment.fence);
    form.set("workerSessionId", oldSessionId);
    form.set("workerSessionGeneration", oldGeneration);
    form.set("artifactType", "patch");
    form.set("name", "stale-session");
    form.set("contentType", "application/octet-stream");
    form.set("metadata", "{}");
    form.set("runStepId", job.runStepId);
    form.set("stepKey", "worker");
    form.set("content", new File(["stale-session"], "stale.bin"));
    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": crypto.randomUUID(),
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: form,
        },
      ),
    );
    assertEquals(response.status, 409);
    assertEquals(await problemCode(response), "LEASE_FENCED");
    assertEquals(
      response.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const facts = await fixture.pgDatabase.query<{
      artifacts: number;
      versions: number;
      events: number;
      replays: number;
    }>(
      `select
         (select count(*)::int from bakery.artifacts
           where organization_id = $1 and task_id = $2) as artifacts,
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1 and task_id = $2
             and event_type = 'artifact.version_created') as events,
         (select count(*)::int from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $3) as replays`,
      [fixture.organizationId, job.taskId, assignment.attemptId],
    );
    assertEquals(facts.rows, [{
      artifacts: 0,
      versions: 0,
      events: 0,
      replays: 0,
    }]);
  });
});

Deno.test("replays the original upload after a worker gets a new session", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const oldSessionId = worker.registration.workerSessionId;
    const oldGeneration = String(worker.registration.workerSessionGeneration);
    const idempotencyKey = crypto.randomUUID();
    const makeForm = (
      sessionId = oldSessionId,
      sessionGeneration = oldGeneration,
    ): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("workerSessionId", sessionId);
      form.set("workerSessionGeneration", sessionGeneration);
      form.set("artifactType", "patch");
      form.set("name", "new-session-replay");
      form.set("contentType", "application/octet-stream");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File(["replay-me"], "replay.bin"));
      return form;
    };
    const send = async (
      sessionId = oldSessionId,
      sessionGeneration = oldGeneration,
    ): Promise<Response> =>
      await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": idempotencyKey,
              "X-Bakery-Worker-Protocol-Version": "2",
            },
            body: makeForm(sessionId, sessionGeneration),
          },
        ),
      );
    const first = await send();
    assertEquals(first.status, 201, await first.clone().text());
    const firstRaw = new Uint8Array(await first.arrayBuffer());
    const firstReceipt = JSON.parse(new TextDecoder().decode(firstRaw));
    const replacementSessionId = crypto.randomUUID();
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: oldGeneration,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacement.status, 200);
    const replacementBody = await replacement.json() as {
      workerSessionId: string;
      workerSessionGeneration: string;
    };
    assertEquals(replacementBody.workerSessionId, replacementSessionId);
    const replay = await send(
      replacementBody.workerSessionId,
      replacementBody.workerSessionGeneration,
    );
    assertEquals(
      replay.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const replayRaw = new Uint8Array(await replay.arrayBuffer());
    assertEquals(replayRaw, firstRaw);
    assertEquals(
      JSON.parse(new TextDecoder().decode(replayRaw)),
      firstReceipt,
    );
    const facts = await fixture.pgDatabase.query<{
      versions: number;
      replays: number;
      receipt: unknown;
    }>(
      `select
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2) as versions,
         (select count(*)::int from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $3) as replays,
         (select response
            from bakery.artifact_publication_replays
           where organization_id = $1 and attempt_id = $3
           limit 1) as receipt`,
      [fixture.organizationId, job.taskId, assignment.attemptId],
    );
    assertEquals(facts.rows, [{
      versions: 1,
      replays: 1,
      receipt: firstReceipt,
    }]);
  });
});

Deno.test("rejects stale fences and serializes concurrent publishers without partial versions", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const workerSessionId = worker.registration.workerSessionId;
    const workerSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );
    const bytes = new TextEncoder().encode("race-proof");
    const upload = (name: string, fence = assignment.fence): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", fence);
      form.set("workerSessionId", workerSessionId);
      form.set("workerSessionGeneration", workerSessionGeneration);
      form.set("artifactType", "patch");
      form.set("name", name);
      form.set("contentType", "application/octet-stream");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File([bytes], "race.bin"));
      return form;
    };
    const publish = (
      form: FormData,
      key: string,
      headers: Record<string, string> = {},
    ) =>
      fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": key,
              "X-Bakery-Worker-Protocol-Version": "2",
              ...headers,
            },
            body: form,
          },
        ),
      );

    const first = await publish(upload("stale-fence"), crypto.randomUUID());
    assertEquals(first.status, 201, await first.clone().text());
    const firstResponse = await first.json() as { id: string };
    const stale = await publish(
      upload("stale-fence", "0"),
      crypto.randomUUID(),
      { "if-match": `"${firstResponse.id}"` },
    );
    assertEquals(stale.status, 409);
    assertEquals(await problemCode(stale), "LEASE_FENCED");
    assertEquals(
      stale.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const staleFacts = await fixture.pgDatabase.query<{
      versions: number;
      currentVersionId: string | null;
    }>(
      `select
         (select count(*)::int from bakery.artifact_versions
           where organization_id = $1 and task_id = $2
             and artifact_id = (select id from bakery.artifacts
               where organization_id = $1 and task_id = $2
                 and name = 'stale-fence')) as versions,
         (select current_version_id from bakery.artifacts
           where organization_id = $1 and task_id = $2
             and name = 'stale-fence') as "currentVersionId"`,
      [fixture.organizationId, job.taskId],
    );
    assertEquals(staleFacts.rows, [{
      versions: 1,
      currentVersionId: firstResponse.id,
    }]);

    const concurrentKey = crypto.randomUUID();
    const [left, right] = await Promise.all([
      publish(upload("concurrent"), concurrentKey),
      publish(upload("concurrent"), concurrentKey),
    ]);
    assertEquals([left.status, right.status].sort((a, b) => a - b), [201, 201]);
    const leftReceipt = await left.json();
    const rightReceipt = await right.json();
    assertEquals(leftReceipt, rightReceipt);
    const mismatch = await publish(
      upload("concurrent-mismatch"),
      concurrentKey,
    );
    assertEquals(mismatch.status, 422);
    assertEquals(await problemCode(mismatch), "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const count = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_versions
        where organization_id = $1 and task_id = $2
          and artifact_id = (select id from bakery.artifacts
            where organization_id = $1 and task_id = $2
              and name = 'concurrent')`,
      [fixture.organizationId, job.taskId],
    );
    assertEquals(count.rows[0]?.count, 1);

    const parent = await publish(
      upload("same-parent"),
      crypto.randomUUID(),
    );
    assertEquals(parent.status, 201, await parent.clone().text());
    const parentResponse = await parent.json() as { id: string };
    const [casLeft, casRight] = await Promise.all([
      publish(
        upload("same-parent"),
        crypto.randomUUID(),
        { "if-match": `"${parentResponse.id}"` },
      ),
      publish(
        upload("same-parent"),
        crypto.randomUUID(),
        { "if-match": `"${parentResponse.id}"` },
      ),
    ]);
    assertEquals(
      [casLeft.status, casRight.status].sort((a, b) => a - b),
      [201, 412],
    );
    const casConflict = [casLeft, casRight].find((response) =>
      response.status === 412
    );
    assertExists(casConflict);
    assertEquals(await problemCode(casConflict), "PRECONDITION_FAILED");
    assertEquals(
      casLeft.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    assertEquals(
      casRight.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const casCount = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.artifact_versions
        where organization_id = $1 and task_id = $2
          and artifact_id = (select id from bakery.artifacts
            where organization_id = $1 and task_id = $2
              and name = 'same-parent')`,
      [fixture.organizationId, job.taskId],
    );
    assertEquals(casCount.rows[0]?.count, 2);
  });
});

Deno.test(
  "distinct authorized attempts race one parent with one conflict winner",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const workerA = await registeredWorker(fixture, {
        name: `issue41-race-a-${crypto.randomUUID()}`,
      });
      const workerB = await registeredWorker(fixture, {
        name: `issue41-race-b-${crypto.randomUUID()}`,
      });
      const [firstJob, secondJob] = await seedRelatedFundedModelJobs(fixture);
      const assignmentA = await claimAssignment(fixture, workerA);
      assertEquals(assignmentA.jobId, firstJob.jobId);
      const assignmentB = await claimAssignment(fixture, workerB);
      assertEquals(assignmentB.jobId, secondJob.jobId);
      assertEquals(assignmentA.attemptId === assignmentB.attemptId, false);
      const publish = async (
        worker: typeof workerA,
        assignment: typeof assignmentA,
        job: typeof firstJob,
        name: string,
        bytes: Uint8Array,
        ifMatch?: string,
      ): Promise<Response> => {
        const form = new FormData();
        form.set("leaseToken", assignment.leaseToken);
        form.set("fence", assignment.fence);
        form.set("workerSessionId", worker.registration.workerSessionId);
        form.set(
          "workerSessionGeneration",
          String(worker.registration.workerSessionGeneration),
        );
        form.set("artifactType", "patch");
        form.set("name", name);
        form.set("contentType", "application/octet-stream");
        form.set("metadata", "{}");
        form.set("runStepId", job.runStepId);
        form.set("stepKey", job.stepKey);
        const fileBytes = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(fileBytes).set(bytes);
        form.set("content", new File([fileBytes], `${name}.bin`));
        return await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${worker.credential}`,
                "idempotency-key": crypto.randomUUID(),
                "X-Bakery-Worker-Protocol-Version": "2",
                ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
              },
              body: form,
            },
          ),
        );
      };
      const parent = await publish(
        workerA,
        assignmentA,
        firstJob,
        "authorized-race",
        new TextEncoder().encode("parent"),
      );
      assertEquals(parent.status, 201, await parent.clone().text());
      const parentBody = await parent.json() as { id: string };
      const [left, right] = await Promise.all([
        publish(
          workerA,
          assignmentA,
          firstJob,
          "authorized-race",
          new TextEncoder().encode("winner-a"),
          `"${parentBody.id}"`,
        ),
        publish(
          workerB,
          assignmentB,
          secondJob,
          "authorized-race",
          new TextEncoder().encode("winner-b"),
          `"${parentBody.id}"`,
        ),
      ]);
      const responses = [left, right];
      assertEquals(
        responses.map((response) => response.status).sort((a, b) => a - b),
        [201, 412],
      );
      const conflict = responses.find((response) => response.status === 412);
      assertExists(conflict);
      assertEquals(await problemCode(conflict), "PRECONDITION_FAILED");
      const winner = responses.find((response) => response.status === 201);
      assertExists(winner);
      const winnerBody = await winner.json() as { id: string };
      const facts = await fixture.pgDatabase.query<{
        versions: number;
        receipts: number;
        events: number;
        currentVersionId: string;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id = $1 and artifact_id = artifact.id) as versions,
           (select count(*)::int from bakery.artifact_publication_replays
             where organization_id = $1
               and attempt_id in ($3, $4)) as receipts,
           (select count(*)::int from bakery.domain_events
             where organization_id = $1 and aggregate_id = artifact.id
               and event_type = 'artifact.version_created') as events,
           artifact.current_version_id as "currentVersionId"
           from bakery.artifacts as artifact
          where artifact.organization_id = $1 and artifact.task_id = $2
            and artifact.name = 'authorized-race'`,
        [
          fixture.organizationId,
          firstJob.taskId,
          assignmentA.attemptId,
          assignmentB.attemptId,
        ],
      );
      assertEquals(facts.rows, [{
        versions: 2,
        receipts: 2,
        events: 2,
        currentVersionId: winnerBody.id,
      }]);
      const [wildcardLeft, wildcardRight] = await Promise.all([
        publish(
          workerA,
          assignmentA,
          firstJob,
          "authorized-race",
          new TextEncoder().encode("wildcard-a"),
          "*",
        ),
        publish(
          workerB,
          assignmentB,
          secondJob,
          "authorized-race",
          new TextEncoder().encode("wildcard-b"),
          "*",
        ),
      ]);
      const wildcardResponses = [wildcardLeft, wildcardRight];
      assertEquals(
        wildcardResponses.map((response) => response.status).sort((a, b) =>
          a - b
        ),
        [412, 412],
      );
      for (const response of wildcardResponses) {
        assertEquals(await problemCode(response), "PRECONDITION_FAILED");
      }
      const afterWildcard = await fixture.pgDatabase.query<{
        versions: number;
        receipts: number;
        events: number;
        currentVersionId: string;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id = $1 and artifact_id = artifact.id) as versions,
           (select count(*)::int from bakery.artifact_publication_replays
             where organization_id = $1
               and attempt_id in ($3, $4)) as receipts,
           (select count(*)::int from bakery.domain_events
             where organization_id = $1 and aggregate_id = artifact.id
               and event_type = 'artifact.version_created') as events,
           artifact.current_version_id as "currentVersionId"
           from bakery.artifacts as artifact
          where artifact.organization_id = $1 and artifact.task_id = $2
            and artifact.name = 'authorized-race'`,
        [
          fixture.organizationId,
          firstJob.taskId,
          assignmentA.attemptId,
          assignmentB.attemptId,
        ],
      );
      assertEquals(afterWildcard.rows, [{
        versions: 2,
        receipts: 2,
        events: 2,
        currentVersionId: winnerBody.id,
      }]);
    });
  },
);

Deno.test("delivers artifact events to every declared scope and no unrelated scope", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const repositoryId = crypto.randomUUID();
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { input: { repositoryId, planArtifact: crypto.randomUUID() } },
    );
    const unrelatedJob = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const sync = async (
      scopeType: "application" | "repository" | "conversation",
      scopeId: string,
      after?: string,
    ): Promise<{
      highwater: string;
      nextCursor: string | null;
      events: Array<{ type: string; payload: { resourceId?: string } }>;
    }> => {
      const query = new URLSearchParams({ scopeType, scopeId });
      if (after !== undefined) query.set("after", after);
      const response = await fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}/v1/sync?${query}`, {
          headers: {
            cookie: fixture.adminCookie,
            origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as {
        highwater: string;
        nextCursor: string | null;
        events: Array<{ type: string; payload: { resourceId?: string } }>;
      };
    };
    const scopes = [
      ["application", job.applicationId],
      ["repository", repositoryId],
      ["conversation", job.conversationId],
    ] as const;
    const initial: Record<string, string> = {};
    for (const [scopeType, scopeId] of scopes) {
      const snapshot = await sync(scopeType, scopeId);
      assertEquals(snapshot.events, []);
      assertExists(snapshot.nextCursor);
      initial[`${scopeType}:${scopeId}`] = snapshot.nextCursor;
    }
    const unrelatedSnapshot = await sync(
      "application",
      unrelatedJob.applicationId,
    );
    assertEquals(unrelatedSnapshot.events, []);
    assertExists(unrelatedSnapshot.nextCursor);
    const assignment = await claimAssignment(fixture, worker);
    const form = new FormData();
    form.set("leaseToken", assignment.leaseToken);
    form.set("fence", assignment.fence);
    form.set("workerSessionId", worker.registration.workerSessionId);
    form.set(
      "workerSessionGeneration",
      String(worker.registration.workerSessionGeneration),
    );
    form.set("artifactType", "patch");
    form.set("name", "scoped-event");
    form.set("contentType", "application/octet-stream");
    form.set("metadata", "{}");
    form.set("runStepId", job.runStepId);
    form.set("stepKey", "worker");
    form.set("content", new File(["scoped-event"], "scoped.bin"));
    const publication = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.credential}`,
            "idempotency-key": crypto.randomUUID(),
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: form,
        },
      ),
    );
    assertEquals(publication.status, 201, await publication.clone().text());
    const publicationBody = await publication.json() as { artifactId: string };
    for (const [scopeType, scopeId] of scopes) {
      const delivered = await sync(
        scopeType,
        scopeId,
        initial[`${scopeType}:${scopeId}`],
      );
      const artifactEvents = delivered.events.filter((event) =>
        event.type === "artifact.version_created" &&
        event.payload.resourceId === publicationBody.artifactId
      );
      assertEquals(artifactEvents.length, 1);
    }
    const unrelatedDelivered = await sync(
      "application",
      unrelatedJob.applicationId,
      unrelatedSnapshot.nextCursor,
    );
    assertEquals(unrelatedDelivered.events, []);
  });
});

Deno.test(
  "rejects wrong and foreign immutable references without terminal facts",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      const publish = async (
        activeWorker: typeof worker,
        activeAssignment: typeof assignment,
        activeJob: typeof job,
        name: string,
        contents: string,
      ): Promise<Response> => {
        const form = new FormData();
        form.set("leaseToken", activeAssignment.leaseToken);
        form.set("fence", activeAssignment.fence);
        form.set(
          "workerSessionId",
          activeWorker.registration.workerSessionId,
        );
        form.set(
          "workerSessionGeneration",
          String(activeWorker.registration.workerSessionGeneration),
        );
        form.set("artifactType", "patch");
        form.set("name", name);
        form.set("contentType", "application/octet-stream");
        form.set("metadata", "{}");
        form.set("runStepId", activeJob.runStepId);
        form.set("stepKey", "worker");
        form.set("content", new File([contents], `${name}.bin`));
        return await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/worker/attempts/${activeAssignment.attemptId}/artifacts`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${activeWorker.credential}`,
                "idempotency-key": crypto.randomUUID(),
                "X-Bakery-Worker-Protocol-Version": "2",
              },
              body: form,
            },
          ),
        );
      };
      const localPublication = await publish(
        worker,
        assignment,
        job,
        "local-reference",
        "local-reference",
      );
      assertEquals(
        localPublication.status,
        201,
        await localPublication.clone().text(),
      );
      const localBody = await localPublication.json() as {
        artifactId: string;
        id: string;
        sha256: string;
      };
      const localReference = {
        artifactId: localBody.artifactId,
        versionId: localBody.id,
        sha256: localBody.sha256,
      };
      const foreignScope = await createWorkerScope(
        fixture,
        "issue41-foreign-reference",
        fixture,
      );
      try {
        const foreignWorker = await registeredWorker(fixture, {
          scope: foreignScope,
        });
        const foreignJob = await seedFundedModelJob(
          fixture.pgDatabase,
          foreignScope.organizationId,
          foreignScope.principalId,
        );
        const foreignAssignment = await claimAssignment(fixture, foreignWorker);
        const foreignPublication = await publish(
          foreignWorker,
          foreignAssignment,
          foreignJob,
          "foreign-reference",
          "foreign-reference",
        );
        assertEquals(
          foreignPublication.status,
          201,
          await foreignPublication.clone().text(),
        );
        const foreignBody = await foreignPublication.json() as {
          artifactId: string;
          id: string;
          sha256: string;
        };
        const references = [
          { ...localReference, sha256: "b".repeat(64) },
          { ...localReference, artifactId: crypto.randomUUID() },
          {
            artifactId: foreignBody.artifactId,
            versionId: foreignBody.id,
            sha256: foreignBody.sha256,
          },
        ];
        for (const reference of references) {
          const beforeArtifactEvent = await readExecutionState(
            fixture.pgDatabase,
            job.jobId,
          );
          const artifactEventId = crypto.randomUUID();
          const artifactEvent = await postWorkerEvent(
            fixture,
            worker,
            assignment,
            eventBody(
              assignment,
              artifactEventId,
              "1",
              "2026-09-22T00:00:01.000Z",
              {
                eventType: "job.artifact",
                payload: { artifact: reference },
              },
            ),
            artifactEventId,
            { protocolVersion: 2 },
          );
          assertEquals(
            artifactEvent.status,
            404,
            await artifactEvent.clone().text(),
          );
          assertEquals(
            await problemCode(artifactEvent),
            "RESOURCE_NOT_FOUND",
          );
          assertEquals(
            await readExecutionState(fixture.pgDatabase, job.jobId),
            beforeArtifactEvent,
          );
          const response = await postWorkerResult(
            fixture,
            worker,
            assignment,
            resultBody(assignment, {
              localSeq: "1",
              result: {
                headSha: "reference-head",
                baseSha: "reference-base",
                sessionId: job.sessionId,
                artifacts: [reference],
              },
            }),
            crypto.randomUUID(),
            { protocolVersion: 2 },
          );
          assertEquals(response.status, 404, await response.clone().text());
          assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND");
        }
        const foreignAttempt = await publish(
          foreignWorker,
          assignment,
          job,
          "foreign-publication",
          "must-not-publish",
        );
        assertEquals(
          foreignAttempt.status,
          404,
          await foreignAttempt.clone().text(),
        );
        assertEquals(await problemCode(foreignAttempt), "RESOURCE_NOT_FOUND");
        const state = await readExecutionState(
          fixture.pgDatabase,
          job.jobId,
        );
        assertEquals(state.step.output, null);
        assertEquals(state.events, []);
        assertEquals(state.attempts[0]?.result, null);
        const versions = await fixture.pgDatabase.query<{ count: number }>(
          `select count(*)::int as count
             from bakery.artifact_versions
            where organization_id = $1 and task_id = $2`,
          [fixture.organizationId, job.taskId],
        );
        assertEquals(versions.rows[0]?.count, 1);
      } finally {
        await closeWorkerScope(fixture, foreignScope);
      }
    });
  },
);

Deno.test(
  "validates rpi.design singular artifact refs at the result route",
  async () => {
    await withArtifactWorkerFixture(async (fixture) => {
      const capabilities = [...workerActionCapabilities("rpi.design")];
      const worker = await registeredWorker(fixture, {
        capabilities,
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
        {
          action: "rpi.design",
          input: { researchArtifact: crypto.randomUUID() },
        },
      );
      const assignment = await claimAssignment(fixture, worker, {
        capabilities,
        supportedActions: ["rpi.design"],
      });
      const publish = async (
        activeWorker: typeof worker,
        activeAssignment: typeof assignment,
        activeJob: typeof job,
        name: string,
        contents: string,
      ): Promise<{ artifactId: string; id: string; sha256: string }> => {
        const form = new FormData();
        form.set("leaseToken", activeAssignment.leaseToken);
        form.set("fence", activeAssignment.fence);
        form.set(
          "workerSessionId",
          activeWorker.registration.workerSessionId,
        );
        form.set(
          "workerSessionGeneration",
          String(activeWorker.registration.workerSessionGeneration),
        );
        form.set("artifactType", "patch");
        form.set("name", name);
        form.set("contentType", "application/octet-stream");
        form.set("metadata", "{}");
        form.set("runStepId", activeJob.runStepId);
        form.set("stepKey", "worker");
        form.set("content", new File([contents], `${name}.bin`));
        const response = await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/worker/attempts/${activeAssignment.attemptId}/artifacts`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${activeWorker.credential}`,
                "idempotency-key": crypto.randomUUID(),
                "X-Bakery-Worker-Protocol-Version": "2",
              },
              body: form,
            },
          ),
        );
        assertEquals(response.status, 201, await response.clone().text());
        return await response.json() as {
          artifactId: string;
          id: string;
          sha256: string;
        };
      };

      const localPublication = await publish(
        worker,
        assignment,
        job,
        "design-local",
        "design-local",
      );
      const localReference = {
        artifactId: localPublication.artifactId,
        versionId: localPublication.id,
        sha256: localPublication.sha256,
      };

      const foreignScope = await createWorkerScope(
        fixture,
        "issue41-design-foreign-reference",
        fixture,
      );
      try {
        const foreignWorker = await registeredWorker(fixture, {
          capabilities,
          scope: foreignScope,
        });
        const foreignJob = await seedFundedModelJob(
          fixture.pgDatabase,
          foreignScope.organizationId,
          foreignScope.principalId,
          {
            action: "rpi.design",
            input: { researchArtifact: crypto.randomUUID() },
          },
        );
        const foreignAssignment = await claimAssignment(
          fixture,
          foreignWorker,
          {
            capabilities,
            supportedActions: ["rpi.design"],
          },
        );
        const foreignPublication = await publish(
          foreignWorker,
          foreignAssignment,
          foreignJob,
          "design-foreign",
          "design-foreign",
        );
        const references = [
          {
            ...localReference,
            sha256: "b".repeat(64),
          },
          {
            artifactId: foreignPublication.artifactId,
            versionId: foreignPublication.id,
            sha256: foreignPublication.sha256,
          },
        ];
        for (const reference of references) {
          const before = await readExecutionState(
            fixture.pgDatabase,
            job.jobId,
          );
          const response = await postWorkerResult(
            fixture,
            worker,
            assignment,
            resultBody(assignment, {
              localSeq: "1",
              result: { artifact: reference },
            }),
            crypto.randomUUID(),
            { protocolVersion: 2 },
          );
          assertEquals(response.status, 404, await response.clone().text());
          assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND");
          assertEquals(
            await readExecutionState(fixture.pgDatabase, job.jobId),
            before,
          );
        }

        const success = await postWorkerResult(
          fixture,
          worker,
          assignment,
          resultBody(assignment, {
            localSeq: "1",
            result: { artifact: localReference },
          }),
          crypto.randomUUID(),
          { protocolVersion: 2 },
        );
        assertEquals(success.status, 200, await success.clone().text());
        const terminal = await readExecutionState(
          fixture.pgDatabase,
          job.jobId,
        );
        const output = workerActionOutputSchema("rpi.design").parse(
          terminal.step.output,
        );
        if (
          output === null || typeof output !== "object" ||
          !("artifact" in output)
        ) {
          throw new Error("rpi.design output missing artifact");
        }
        assertEquals(output.artifact, localReference);
        const terminalEvent = terminal.events.at(-1);
        assertExists(terminalEvent);
        if (
          terminalEvent.payload === null ||
          typeof terminalEvent.payload !== "object" ||
          !("result" in terminalEvent.payload)
        ) {
          throw new Error("rpi.design event missing result");
        }
        const eventOutput = workerActionOutputSchema("rpi.design").parse(
          terminalEvent.payload.result,
        );
        if (
          eventOutput === null || typeof eventOutput !== "object" ||
          !("artifact" in eventOutput)
        ) {
          throw new Error("rpi.design event result missing artifact");
        }
        assertEquals(eventOutput.artifact, localReference);
      } finally {
        await closeWorkerScope(fixture, foreignScope);
      }
    });
  },
);

Deno.test("revalidates an expired lease after publication lock contention", async () => {
  await withArtifactWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const workerSessionId = worker.registration.workerSessionId;
    const workerSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );
    const makeForm = (content: string): FormData => {
      const form = new FormData();
      form.set("leaseToken", assignment.leaseToken);
      form.set("fence", assignment.fence);
      form.set("artifactType", "patch");
      form.set("workerSessionId", workerSessionId);
      form.set("workerSessionGeneration", workerSessionGeneration);
      form.set("name", "lease-contention");
      form.set("contentType", "application/octet-stream");
      form.set("metadata", "{}");
      form.set("runStepId", job.runStepId);
      form.set("stepKey", "worker");
      form.set("content", new File([content], "contention.bin"));
      return form;
    };
    const publish = async (
      form: FormData,
      key: string,
      headers: Record<string, string> = {},
    ): Promise<Response> =>
      await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${worker.credential}`,
              "idempotency-key": key,
              "X-Bakery-Worker-Protocol-Version": "2",
              ...headers,
            },
            body: form,
          },
        ),
      );

    const first = await publish(makeForm("before"), crypto.randomUUID());
    assertEquals(first.status, 201, await first.clone().text());
    const firstResponse = await first.json() as { id: string };

    const blocker = await fixture.pgDatabase.connect();
    let released = false;
    try {
      await blocker.query("begin");
      await blocker.query(
        `select id
           from bakery.artifacts
          where organization_id = $1 and task_id = $2
            and name = 'lease-contention'
          for update`,
        [fixture.organizationId, job.taskId],
      );
      await fixture.pgDatabase.query(
        `update bakery.job_attempts
            set lease_expires_at = clock_timestamp() + interval '2 seconds'
          where id = $1`,
        [assignment.attemptId],
      );
      const blocked = publish(
        makeForm("after"),
        crypto.randomUUID(),
        { "if-match": `"${firstResponse.id}"` },
      );
      const deadline = performance.now() + 5_000;
      let observedWait = false;
      while (performance.now() < deadline) {
        const waiting = await fixture.runtimePgDatabase.query<
          { waiting: boolean }
        >(
          `select exists (
             select 1
               from pg_stat_activity
              where wait_event_type = 'Lock'
                and state = 'active'
                and cardinality(pg_blocking_pids(pid)) > 0
                and query ilike '%bakery.artifacts%'
           ) as waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          observedWait = true;
          break;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 10);
        await promise;
      }
      assertEquals(observedWait, true);
      const { promise: leaseExpiryWait, resolve: releaseLeaseExpiryWait } =
        Promise.withResolvers<void>();
      setTimeout(releaseLeaseExpiryWait, 2_100);
      await leaseExpiryWait;
      await blocker.query("rollback");
      released = true;
      const expired = await blocked;
      assertEquals(expired.status, 409);
      assertEquals(await problemCode(expired), "LEASE_EXPIRED");
      assertEquals(
        expired.headers.get("X-Bakery-Worker-Protocol-Version"),
        "2",
      );
    } finally {
      if (!released) await blocker.query("rollback");
      blocker.release();
    }

    const versions = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count
         from bakery.artifact_versions
        where organization_id = $1 and task_id = $2
          and artifact_id = (select id from bakery.artifacts
            where organization_id = $1 and task_id = $2
              and name = 'lease-contention')`,
      [fixture.organizationId, job.taskId],
    );
    assertEquals(versions.rows[0]?.count, 1);
  });
});
