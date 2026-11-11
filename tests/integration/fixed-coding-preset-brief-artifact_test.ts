import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  registeredWorker,
  seedFundedModelJob,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  renderTaskBrief,
  taskBriefArtifactName,
} from "../../apps/worker/src/task-brief.ts";
import { reclaimExpiredAttempts } from "../../packages/persistence/src/attempts.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

const profile = {
  id: crypto.randomUUID(),
  revision: 1,
  digest: "c".repeat(64),
  baseSha: null,
};

const TAG_LIKE = [
  "<form action=x>",
  "<script>alert(1)</script>",
  "<!doctype html><html>",
  "<svg onload=x>",
  "\u0001\u000b\u007f<iframe src=x>",
];

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("the server byte boundary accepts rendered briefs for tag-like input and rejects the unescaped bytes", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const client = new WorkerApiClient({
      baseUrl: fixture.config.publicBaseUrl,
      credential: worker.credential,
      fetcher: async (input, init) =>
        await fixture.app.fetch(new Request(input, init)),
    });
    const authority = {
      leaseToken: assignment.leaseToken,
      fence: String(assignment.fence),
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
    };

    // The same bytes without escaping look like markup and are refused, so
    // the escaping in renderTaskBrief is what makes publication succeed.
    const raw = new TextEncoder().encode("<!doctype html><form>");
    await assertRejects(
      () =>
        client.publishArtifact(assignment.attemptId, {
          ...authority,
          idempotencyKey: `raw-${crypto.randomUUID()}`,
          artifactType: "plan",
          mediaType: "application/json",
          name: "raw-markup.json",
          bytes: raw,
        }),
    );

    const published: Array<{ versionId: string; sha256: string }> = [];
    for (const [index, tag] of TAG_LIKE.entries()) {
      const rendered = renderTaskBrief(
        {
          brief: {
            title: tag,
            description: tag.repeat(300),
            taskType: "feature",
          },
          repositoryId: crypto.randomUUID(),
        },
        profile,
      );
      const key = `brief:${crypto.randomUUID()}:1`;
      const ref = await client.publishArtifact(assignment.attemptId, {
        ...authority,
        idempotencyKey: key,
        artifactType: "plan",
        mediaType: rendered.mediaType,
        name: `task-brief-${index}.json`,
        bytes: rendered.bytes,
        metadata: { schema: "bakery.task-brief/v1", immutable: true },
      });
      assertEquals(ref.sha256, await digest(rendered.bytes));
      published.push({ versionId: ref.versionId, sha256: ref.sha256 });

      // An exact retry replays the original version, never a second one.
      const replay = await client.publishArtifact(assignment.attemptId, {
        ...authority,
        idempotencyKey: key,
        artifactType: "plan",
        mediaType: rendered.mediaType,
        name: `task-brief-${index}.json`,
        bytes: rendered.bytes,
        metadata: { schema: "bakery.task-brief/v1", immutable: true },
      });
      assertEquals(replay, ref);
    }

    const stored = await fixture.pgDatabase.query<{
      id: string;
      sha256: string;
      media_type: string;
      run_step_id: string;
    }>(
      `select id, sha256, media_type, run_step_id
         from bakery.artifact_versions
        where organization_id = $1 and id = any($2::uuid[])
        order by id`,
      [fixture.organizationId, published.map((item) => item.versionId)],
    );
    assertEquals(stored.rows.length, TAG_LIKE.length);
    for (const row of stored.rows) {
      assertEquals(row.media_type, "application/json");
      assertEquals(row.run_step_id, job.runStepId);
      assert(published.some((item) => item.sha256 === row.sha256));
    }
  }));

Deno.test("a reclaimed attempt republishes its brief under its own fence-named artifact", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture);
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const client = new WorkerApiClient({
      baseUrl: fixture.config.publicBaseUrl,
      credential: worker.credential,
      fetcher: async (input, init) =>
        await fixture.app.fetch(new Request(input, init)),
    });
    const rendered = renderTaskBrief(
      {
        brief: { title: "Retry", description: "<form>", taskType: "feature" },
        repositoryId: crypto.randomUUID(),
      },
      profile,
    );
    const publishFrom = async (
      assignment: Awaited<ReturnType<typeof claimAssignment>>,
    ) =>
      await client.publishArtifact(assignment.attemptId, {
        leaseToken: assignment.leaseToken,
        fence: String(assignment.fence),
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: String(
          worker.registration.workerSessionGeneration,
        ),
        idempotencyKey: `brief:${assignment.jobId}:${assignment.fence}`,
        artifactType: "plan",
        mediaType: rendered.mediaType,
        name: taskBriefArtifactName(assignment.jobId, assignment.fence),
        bytes: rendered.bytes,
      });

    const first = await claimAssignment(fixture, worker);
    const firstRef = await publishFrom(first);

    // The worker is lost after publishing: expire the lease and reclaim.
    await fixture.pgDatabase.query(
      `update bakery.job_attempts
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, first.attemptId],
    );
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        reclaimExpiredAttempts(
          transaction,
          fixture.organizationId,
          undefined,
          null,
        ),
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set available_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const second = await claimAssignment(fixture, worker);
    assert(second.attemptId !== first.attemptId);
    assert(BigInt(second.fence) > BigInt(first.fence));
    const secondRef = await publishFrom(second);
    assert(secondRef.versionId !== firstRef.versionId);
    assertEquals(secondRef.sha256, firstRef.sha256);

    // Each attempt owns its own version; the admission test proves the
    // implement step consumes the version its brief step completed with.
    const names = await fixture.pgDatabase.query<{ name: string }>(
      `select artifact.name from bakery.artifact_versions version
         join bakery.artifacts artifact
           on artifact.organization_id = version.organization_id
          and artifact.id = version.artifact_id
        where version.organization_id = $1 and version.id = any($2::uuid[])
        order by artifact.name`,
      [fixture.organizationId, [firstRef.versionId, secondRef.versionId]],
    );
    assertEquals(names.rows.length, 2);
    assert(names.rows[0].name !== names.rows[1].name);
  }));
