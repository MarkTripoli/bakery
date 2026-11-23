/**
 * #448 slice S6 (O46): an agent's read of a declared input is served from the
 * run's admission pin even after a newer version lands, and every read joins
 * the step's read set: the input read as pinned=true with the pinned version,
 * a non-input read as the latest with pinned=false. Drives a real session call
 * (worker claim, session credential, /session-call).
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  projectArtifactEntry,
  storageQueryOf,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);

async function addVersion(
  fixture: Fixture,
  artifactId: string,
  taskId: string,
  revision: number,
  text: string,
): Promise<{ id: string; sha256: string; size: number }> {
  const id = crypto.randomUUID();
  const bytes = enc(text);
  const sha256 = await sha256Bytes(bytes);
  await fixture.pgDatabase.query(
    "insert into bakery.artifact_versions (id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'text/plain','evidence')",
    [
      id,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      revision,
      bytes,
      sha256,
      bytes.length,
    ],
  );
  await fixture.pgDatabase.query(
    "update bakery.artifacts set current_version_id = $1 where organization_id = $2 and id = $3",
    [id, fixture.organizationId, artifactId],
  );
  return { id, sha256, size: bytes.length };
}

async function recordFile(
  fixture: Fixture,
  taskId: string,
  name: string,
  text: string,
) {
  const artifactId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name) values ($1,$2,$3,'document',$4)",
    [artifactId, fixture.organizationId, taskId, name],
  );
  const first = await addVersion(fixture, artifactId, taskId, 1, text);
  const entryId = await withPgTransaction(
    fixture.pgDatabase,
    (tx) =>
      projectArtifactEntry(storageQueryOf(tx), {
        organizationId: fixture.organizationId,
        artifactId,
      }),
  );
  assert(entryId, "record file projected into the tree");
  return { artifactId, entryId, first };
}

async function sessionContent(response: Response): Promise<string> {
  const text = await response.text();
  assertEquals(response.status, 200, text);
  const body = JSON.parse(text) as { outcome?: string; result?: unknown };
  assertEquals(body.outcome, "allowed", text);
  return new TextDecoder().decode(
    Uint8Array.from(atob(body.result as string), (c) => c.charCodeAt(0)),
  );
}

Deno.test("a declared input reads pinned after a newer version lands; a non-input reads latest", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const worker = await registeredWorker(fixture, {
      name: "read-set-448",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      db,
      fixture.organizationId,
      fixture.principalId,
    );
    const input = await recordFile(fixture, job.taskId, "brief.md", "pinned");
    const other = await recordFile(fixture, job.taskId, "notes.md", "first");
    // The admission pin of the declared input, as pinDeclaredRunInputs writes.
    await db.query(
      "insert into bakery.run_input_pins (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes) values ($1,$2,$3,$4,$5,$6)",
      [
        fixture.organizationId,
        job.runId,
        input.artifactId,
        input.first.id,
        input.first.sha256,
        input.first.size,
      ],
    );
    const assignment = await claimAssignment(fixture, worker) as
      & Awaited<ReturnType<typeof claimAssignment>>
      & { sessionCredential?: string };
    const token = assignment.sessionCredential;
    assert(token, "the claim mints a session credential");
    const call = (args: Json) =>
      workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool: "storageFiles.content", arguments: args },
        { headers: { "x-session-credential": token } },
      );

    // Newer versions land after admission.
    await addVersion(fixture, input.artifactId, job.taskId, 2, "newer");
    const latest = await addVersion(
      fixture,
      other.artifactId,
      job.taskId,
      2,
      "second",
    );

    assertEquals(
      await sessionContent(await call({ id: input.entryId })),
      "pinned",
    );
    assertEquals(
      await sessionContent(await call({ id: other.entryId })),
      "second",
    );

    const rows = await db.query<{
      entry_id: string;
      artifact_version_id: string | null;
      version_id: string | null;
      sha256: string;
      pinned: boolean;
    }>(
      "select entry_id, artifact_version_id, version_id, sha256, pinned" +
        " from bakery.step_read_set where organization_id = $1" +
        " and attempt_id = $2 order by created_at, id",
      [fixture.organizationId, assignment.attemptId],
    );
    assertEquals(rows.rows.map((row) => ({ ...row })), [
      {
        entry_id: input.entryId,
        artifact_version_id: input.first.id,
        version_id: null,
        sha256: input.first.sha256,
        pinned: true,
      },
      {
        entry_id: other.entryId,
        artifact_version_id: latest.id,
        version_id: null,
        sha256: latest.sha256,
        pinned: false,
      },
    ]);
  }));
