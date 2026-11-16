import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { setup } from "../helpers/output-ingestion.ts";

type Fixture = Parameters<typeof setup>[0];

type Seed = {
  artifactId: string;
  versionId: string;
  bytes: Uint8Array;
};

/**
 * Seeds one immutable artifact version for a task, the way a real producer
 * would, and returns what the run pins it by.
 */
async function seedVersion(
  fixture: Fixture,
  taskId: string,
  text: string,
): Promise<Seed> {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(text);
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name)
     values ($1,$2,$3,'document',$4)`,
    [artifactId, fixture.organizationId, taskId, `Pinned input ${artifactId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions
       (id,organization_id,artifact_id,task_id,author_id,revision,content,
        sha256,size_bytes,media_type,retention_class)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      bytes,
      await sha256Bytes(bytes),
      bytes.length,
    ],
  );
  return { artifactId, versionId, bytes };
}

async function pin(fixture: Fixture, runId: string, seed: Seed): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.run_input_pins
       (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      fixture.organizationId,
      runId,
      seed.artifactId,
      seed.versionId,
      await sha256Bytes(seed.bytes),
      seed.bytes.length,
    ],
  );
}

function proof(
  credential: string,
  assignment: { leaseToken: string; fence: string },
  session: { workerSessionId: string; workerSessionGeneration: string },
): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    "X-Bakery-Worker-Protocol-Version": "2",
    "X-Worker-Lease-Token": assignment.leaseToken,
    "X-Worker-Fence": assignment.fence,
    "X-Worker-Session-Id": session.workerSessionId,
    "X-Worker-Session-Generation": session.workerSessionGeneration,
  };
}

function readContext(
  fixture: Fixture,
  attemptId: string,
  headers: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/worker/attempts/${attemptId}/context`,
        { method: "GET", headers },
      ),
    ),
  );
}

Deno.test("a worker reads the bytes its run pinned, and only its own run's", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const mine = await seedVersion(fixture, own.job.taskId, "mine");
    const stranger = await seedVersion(fixture, own.job.taskId, "stranger");
    await pin(fixture, own.job.runId, mine);

    const response = await readContext(
      fixture,
      own.assignment.attemptId,
      proof(own.worker.credential, own.assignment, own.worker.registration),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.items.length, 1);
    const [item] = body.items;
    assertEquals(item.artifactVersionId, mine.versionId);
    assertEquals(item.digest, await sha256Bytes(mine.bytes));
    assertEquals(
      new TextDecoder().decode(
        Uint8Array.from(atob(item.contentBase64), (c) => c.charCodeAt(0)),
      ),
      "mine",
    );
    // Another version of the same task is not pinned to this run, so it is
    // not in this run's context.
    assert(item.artifactVersionId !== stranger.versionId);
  }));

Deno.test("a read without the lease proof is refused", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const response = await readContext(fixture, own.assignment.attemptId, {
      authorization: `Bearer ${own.worker.credential}`,
      "X-Bakery-Worker-Protocol-Version": "2",
    });
    assertEquals(response.status, 400);
  }));

Deno.test("bytes that no longer match the pin fail closed instead of serving", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const seed = await seedVersion(fixture, own.job.taskId, "original");
    await pin(fixture, own.job.runId, seed);
    // Simulate corrupted storage: the pin keeps the original digest, the
    // version's bytes no longer hash to it.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions set content = $2 where id = $1`,
      [seed.versionId, new TextEncoder().encode("tampered")],
    );

    const response = await readContext(
      fixture,
      own.assignment.attemptId,
      proof(own.worker.credential, own.assignment, own.worker.registration),
    );
    assert(
      response.status >= 400,
      `expected a refusal, got ${response.status}`,
    );
    const body = await response.json();
    assertEquals(body.code, "PRECONDITION_FAILED");
  }));
