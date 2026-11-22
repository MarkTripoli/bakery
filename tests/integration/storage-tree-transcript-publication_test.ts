import { assert, assertEquals } from "@std/assert";
import { batch, setup } from "../helpers/output-ingestion.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  resolveStoragePath,
  type StorageQuery,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

// #444: the transcript artifact a closed session publishes is created by its own
// code path (execution/output-transcript.ts), not by publishArtifact. It must
// appear in the storage tree under its work item in the same transaction.

Deno.test("AC: a session transcript published on close appears in the tree under its work item", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const output = await batch(own.binding, "transcript text for the tree");
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [{
        eventId: crypto.randomUUID(),
        localSeq: "1",
        eventType: "job.output",
        payload: output,
      }],
    });
    await own.client.closeOutput(
      own.assignment.attemptId,
      {
        ...own.open,
        sessionId: own.binding.sessionId,
        writerGeneration: own.binding.writerGeneration,
        capture: "complete",
        reason: "clean-end",
      },
      crypto.randomUUID(),
    );

    // Closing the session publishes the transcript: the grant is `published`.
    // (A projection that failed here left it `retryable`.)
    const grant = await fixture.pgDatabase.query<{ state: string }>(
      `select state from bakery.session_output_finalizations
        where organization_id = $1 and session_id = $2`,
      [fixture.organizationId, own.binding.sessionId],
    );
    assertEquals(grant.rows[0]?.state, "published");

    const artifacts = await fixture.pgDatabase.query<
      { id: string; name: string; artifactType: string }
    >(
      `select id, name, artifact_type as "artifactType" from bakery.artifacts
        where organization_id = $1 and task_id = $2`,
      [fixture.organizationId, own.job.taskId],
    );
    assert(artifacts.rows.length >= 1, "the close created an artifact");
    const transcript = artifacts.rows[0];

    const entry = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and artifact_id = $2`,
      [fixture.organizationId, transcript.id],
    )).rows[0];
    assert(entry, "the transcript artifact has a storage entry");

    // And it resolves by path under the project and the work item's folder.
    const where = (await fixture.pgDatabase.query<
      { slug: string; folder: string }
    >(
      `select application.slug, folder.name as folder
         from bakery.tasks task
         join bakery.applications application
           on application.organization_id = task.organization_id
          and application.id = task.application_id
         join bakery.storage_entries folder
           on folder.organization_id = task.organization_id
          and folder.system_key = 'task:' || task.id::text
        where task.organization_id = $1 and task.id = $2`,
      [fixture.organizationId, own.job.taskId],
    )).rows[0];
    const db: StorageQuery = {
      query: async <Row>(sql: string, params: unknown[] = []) => ({
        rows: (await fixture.pgDatabase.query(sql, params))
          .rows as unknown as Row[],
      }),
    };
    const resolved = await resolveStoragePath(db, {
      organizationId: fixture.organizationId,
      path:
        `/projects/${where.slug}/artifacts/${where.folder}/${transcript.name}`,
    });
    assertEquals(resolved?.id, entry.id);
  }));

Deno.test("#448 S8a: a transcript version names the session its attempt was handed, not a newer session on the step", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const handed = own.assignment.agentSessionId;
    assert(handed, "the claim hands the attempt a session");
    // A second, newer session is open on the step when the transcript is
    // published; the old provenance read named it as "the step's newest".
    const newer = (await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.agent_sessions (organization_id, run_step_id,
         conversation_id, agent_version_id, harness, status, created_at)
       select organization_id, run_step_id, conversation_id,
              agent_version_id, harness, 'active', now() + interval '1 hour'
         from bakery.agent_sessions where organization_id = $1 and id = $2
       returning id`,
      [fixture.organizationId, handed],
    )).rows[0];
    assert(newer.id !== handed);
    const output = await batch(own.binding, "transcript for provenance");
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [{
        eventId: crypto.randomUUID(),
        localSeq: "1",
        eventType: "job.output",
        payload: output,
      }],
    });
    await own.client.closeOutput(
      own.assignment.attemptId,
      {
        ...own.open,
        sessionId: own.binding.sessionId,
        writerGeneration: own.binding.writerGeneration,
        capture: "complete",
        reason: "clean-end",
      },
      crypto.randomUUID(),
    );
    const versions = await fixture.pgDatabase.query<
      { attemptId: string | null; agentSessionId: string | null }
    >(
      `select version.attempt_id as "attemptId",
              version.agent_session_id as "agentSessionId"
         from bakery.artifact_versions version
         join bakery.artifacts artifact
           on artifact.organization_id = version.organization_id
          and artifact.id = version.artifact_id
        where artifact.organization_id = $1 and artifact.task_id = $2`,
      [fixture.organizationId, own.job.taskId],
    );
    assert(versions.rows.length >= 1, "the close wrote transcript versions");
    for (const version of versions.rows) {
      assertEquals(version.attemptId, own.assignment.attemptId);
      assertEquals(version.agentSessionId, handed);
    }
  }));
