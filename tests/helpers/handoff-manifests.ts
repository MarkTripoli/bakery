/**
 * Shared fixtures for the handoff manifest tests (#33): a live attempt claimed
 * through the real worker protocol, an artifact version the manifest can cite,
 * a manifest that matches the server's rows, and the worker and person requests.
 */

import { assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { claimAssignment } from "./worker-execution/scenarios.ts";
import {
  adminRequest,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerRequest,
  type WorkerScope,
} from "./worker-execution.ts";

export type Json = Record<string, unknown>;
export const SHA = "a".repeat(64);
export const COMMIT = "b".repeat(40);

export async function liveAttempt(fixture: WorkerFixture, name: string) {
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
export async function seedArtifact(
  fixture: WorkerFixture,
  taskId: string,
  text: string,
) {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode(text);
  const sha256 = await sha256Bytes(content);
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'plan',$4)",
    [
      artifactId,
      fixture.organizationId,
      taskId,
      `Handoff evidence ${artifactId}`,
    ],
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

export async function manifestFor(
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

export function post(
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

/** A person's read: the signed-in admin of `scope` (this fixture's organization by default). */
export function person(
  fixture: WorkerFixture,
  path: string,
  scope: WorkerScope = fixture,
) {
  return adminRequest(fixture, path, undefined, { method: "GET", scope });
}

export async function body(response: Response): Promise<Json> {
  return await response.json() as Json;
}
