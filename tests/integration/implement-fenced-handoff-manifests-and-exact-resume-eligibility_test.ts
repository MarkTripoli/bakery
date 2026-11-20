/**
 * #33 slice 1: the fenced handoff manifest through the real worker route and a
 * real database. The unit file pins what the server checks and overwrites; this
 * one pins what only the route and the schema prove: the lease and the fence
 * gate the write, the server's own rows decide what is true, one manifest
 * stands per attempt, and nothing crosses an organization.
 */

import { assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  claimAssignment,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import {
  createWorkerScope,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";

type Json = Record<string, unknown>;
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

async function liveAttempt(fixture: WorkerFixture, name: string) {
  const worker = await registeredWorker(fixture, { name });
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, job.jobId);
  return { worker, job, assignment };
}

/** One immutable artifact version of the job's task, as the manifest cites it. */
async function seedArtifact(
  fixture: WorkerFixture,
  taskId: string,
  text: string,
) {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode(text);
  const sha256 = await sha256Bytes(content);
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'plan','Handoff evidence')",
    [artifactId, fixture.organizationId, taskId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class)
     values($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      content,
      sha256,
      content.length,
    ],
  );
  return { artifactId, versionId, sha256 };
}

async function manifestFor(
  fixture: WorkerFixture,
  job: Awaited<ReturnType<typeof liveAttempt>>["job"],
  overrides: Json = {},
): Promise<Json> {
  const ref = await seedArtifact(fixture, job.taskId, "workspace manifest");
  const session = await fixture.pgDatabase.query<
    { agent_version_id: string; harness: string }
  >(
    "select agent_version_id, harness from bakery.agent_sessions where id = $1",
    [job.sessionId],
  );
  const jobRow = await fixture.pgDatabase.query<{ repository_id: string }>(
    "select repository_id from bakery.jobs where id = $1",
    [job.jobId],
  );
  return {
    manifestVersion: 1,
    mode: "fresh_session",
    taskId: job.taskId,
    runId: job.runId,
    runStepId: job.runStepId,
    sourceSessionId: job.sessionId,
    agentVersionId: session.rows[0].agent_version_id,
    workflowVersionId: job.workflowVersionId,
    harness: session.rows[0].harness,
    harnessVersion: "codex-1.2.3",
    repository: {
      repositoryId: jobRow.rows[0].repository_id,
      commitSha: COMMIT,
      baseSha: COMMIT,
      worktreeId: "wt-1",
      workspaceManifest: ref,
      uncommittedPatch: null,
      binaryChanges: [],
      captureStatus: "complete",
    },
    goal: "Finish the step.",
    decisions: ["Use the pinned plan."],
    context: {
      conversationId: job.conversationId,
      throughConversationSequence: "0",
      artifactRefs: [ref],
      packDigest: SHA,
    },
    tests: [],
    pendingEffects: [],
    nextAction: "Run the tests again.",
    checkpoint: { sequence: "0", digest: SHA, safeBoundary: true },
    grants: { scopeDigest: SHA, recheckOnResume: true },
    ...overrides,
  };
}

function post(
  fixture: WorkerFixture,
  live: Awaited<ReturnType<typeof liveAttempt>>,
  manifest: Json,
  overrides: Json = {},
  key = crypto.randomUUID(),
) {
  return workerRequest(
    fixture,
    live.worker.credential,
    `/v1/worker/attempts/${live.assignment.attemptId}/handoff-manifests`,
    {
      leaseToken: live.assignment.leaseToken,
      fence: live.assignment.fence,
      manifest,
      ...overrides,
    },
    { idempotencyKey: key },
  );
}

function person(fixture: WorkerFixture, path: string, organizationId?: string) {
  return fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      headers: {
        cookie: fixture.adminCookie,
        "bakery-organization-id": organizationId ?? fixture.organizationId,
      },
    }),
  );
}

async function body(response: Response): Promise<Json> {
  return await response.json() as Json;
}

Deno.test("the worker of a live attempt stores one manifest, and a person reads it back", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-store");
    const manifest = await manifestFor(fixture, live.job);

    const created = await post(fixture, live, manifest);
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    assertEquals(record.status, "pending");
    assertEquals(record.sourceAttemptId, live.assignment.attemptId);
    assertEquals(record.runStepId, live.job.runStepId);
    assertEquals(record.safeBoundary, true);
    assertEquals(/^[0-9a-f]{64}$/.test(String(record.digest)), true);

    // The same manifest replays; a different one for the same attempt conflicts.
    const replay = await post(fixture, live, manifest);
    assertEquals(replay.status, 200);
    assertEquals((await body(replay)).digest, record.digest);
    const different = await post(
      fixture,
      live,
      { ...manifest, goal: "A different goal." },
    );
    assertEquals(different.status, 409);
    await different.body?.cancel();

    const read = await person(fixture, "/v1/handoff-manifests/" + record.id);
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals((await body(read)).digest, record.digest);
  }));

Deno.test("the server's journal and effect ledger decide the safe boundary, not the source", () =>
  withWorkerFixture(async (fixture) => {
    const beyond = await liveAttempt(fixture, "handoff-beyond");
    // The source says it is safe at sequence 5, but the journal holds none.
    const response = await post(
      fixture,
      beyond,
      await manifestFor(fixture, beyond.job, {
        checkpoint: { sequence: "5", digest: SHA, safeBoundary: true },
      }),
    );
    assertEquals(response.status, 201, await response.clone().text());
    const record = await body(response);
    assertEquals(record.safeBoundary, false);
    assertEquals(
      ((record.manifest as Json).checkpoint as Json).safeBoundary,
      false,
    );
  }));

Deno.test("a fenced, foreign or malformed write stores nothing", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-refused");
    const manifest = await manifestFor(fixture, live.job);
    const stored = async () =>
      Number(
        (await fixture.pgDatabase.query<{ count: number }>(
          "select count(*)::int as count from bakery.handoff_manifests where source_attempt_id = $1",
          [live.assignment.attemptId],
        )).rows[0].count,
      );

    // A wrong lease token.
    const wrongLease = await post(fixture, live, manifest, {
      leaseToken: "not-the-lease-token",
    });
    assertEquals(wrongLease.status, 409);
    await wrongLease.body?.cancel();

    // An identifier that is not the attempt's run step.
    const wrongStep = await post(fixture, live, {
      ...manifest,
      runStepId: crypto.randomUUID(),
    });
    assertEquals(wrongStep.status, 422);
    await wrongStep.body?.cancel();

    // An artifact reference the server does not hold.
    const ghost = (manifest.context as Json).artifactRefs as Json[];
    const wrongDigest = await post(fixture, live, {
      ...manifest,
      context: {
        ...(manifest.context as Json),
        artifactRefs: [{ ...ghost[0], sha256: "c".repeat(64) }],
      },
    });
    assertEquals(wrongDigest.status, 422);
    await wrongDigest.body?.cancel();

    assertEquals(await stored(), 0);

    // Once the job's fence moves on, the old attempt cannot publish at all.
    await fixture.pgDatabase.query(
      "update bakery.jobs set current_fence = current_fence + 1 where id = $1",
      [live.job.jobId],
    );
    const fenced = await post(fixture, live, manifest);
    assertEquals(fenced.status, 409);
    assertEquals((await body(fenced)).code, "LEASE_FENCED");
    assertEquals(await stored(), 0);
  }));

Deno.test("another organization cannot read a manifest", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-tenant");
    const created = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    const foreign = await createWorkerScope(fixture, "handoff-14", fixture);
    try {
      const read = await person(
        fixture,
        "/v1/handoff-manifests/" + record.id,
        foreign.organizationId,
      );
      assertEquals(read.status, 404);
      await read.body?.cancel();
    } finally {
      const { closeWorkerOrganization } = await import(
        "../helpers/worker-execution.ts"
      );
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));

export type { WorkerAssignment };
