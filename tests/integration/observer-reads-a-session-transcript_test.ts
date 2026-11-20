import { assertEquals } from "@std/assert";
import { batch, setup } from "../helpers/output-ingestion.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { addMember, api, seedRun } from "../helpers/run-requests.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";

/**
 * #456 slice 2b: a person who was asked to look at a run (and holds nothing
 * else) can read the transcript status of the sessions of that run, and only
 * those; removing their access closes it. The transcript is published by a real
 * session close, so what is read is what a real close leaves.
 */

type Own = Awaited<ReturnType<typeof setup>>;

/** Opens, writes to and closes one session, which publishes its transcript. */
async function publish(own: Own, text: string): Promise<void> {
  const output = await batch(own.binding, text);
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
}

Deno.test("an observer reads the transcript status of their run's stream only, until access is removed", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    await publish(own, "the granted run's transcript");
    const guest = await addMember(fixture, "Grantee", "guest");
    const stranger = await addMember(fixture, "Stranger", "guest");
    try {
      // The stream belongs to the job of a step of a run.
      const owner = (await fixture.pgDatabase.query<
        { run_id: string; task_id: string }
      >(
        `select step.run_id, run.task_id
           from bakery.session_output_streams stream
           join bakery.jobs job
             on job.organization_id = stream.organization_id
            and job.id = stream.job_id
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
          where stream.organization_id = $1 and stream.id = $2`,
        [fixture.organizationId, own.binding.sessionId],
      )).rows[0];
      assertEquals(owner !== undefined, true, "the stream belongs to a run");
      // Another run of the same task: a grant on it is not a grant on this one.
      const otherRun = await seedRun(fixture, owner.task_id);
      const grant = (runId: string, principalId: string) =>
        fixture.pgDatabase.query(
          `insert into bakery.run_access_grants (
             organization_id, run_id, task_id, principal_id, via, granted_by,
             granted_by_kind)
           values ($1, $2, $3, $4, 'request', $5, 'person')`,
          [
            fixture.organizationId,
            runId,
            owner.task_id,
            principalId,
            fixture.principalId,
          ],
        );
      const transcript = (cookie: string) =>
        api(
          fixture,
          cookie,
          "GET",
          `/v1/output-streams/${own.binding.sessionId}/transcript?sessionId=${own.binding.sessionId}`,
        ).then((response) => response.status);

      // Nothing before a grant; nothing from a grant on another run; nothing
      // for someone never asked.
      assertEquals(await transcript(guest.cookie), 404);
      await grant(otherRun.runId, guest.principalId);
      assertEquals(await transcript(guest.cookie), 404);
      assertEquals(await transcript(stranger.cookie), 404);
      // A grant on the stream's own run reads it.
      await grant(owner.run_id, guest.principalId);
      assertEquals(await transcript(guest.cookie), 200);
      assertEquals(await transcript(stranger.cookie), 404);
      // Removing the access closes it at once.
      await fixture.pgDatabase.query(
        `update bakery.run_access_grants set revoked_at = now()
          where organization_id = $1 and principal_id = $2 and run_id = $3`,
        [fixture.organizationId, guest.principalId, owner.run_id],
      );
      assertEquals(await transcript(guest.cookie), 404);
    } catch (failure) {
      // The fixture's teardown can throw too, and would hide this.
      console.error("error: observer transcript test body:", failure);
      throw failure;
    } finally {
      // Take the streams this test published away before the fixture deletes
      // the worker hosts, whose producers and finalizations point at them.
      await fixture.pgDatabase.query(
        "delete from bakery.session_output_streams where organization_id = $1",
        [fixture.organizationId],
      );
      await cleanupAuthFixture(fixture.pgDatabase, [
        guest.email,
        stranger.email,
      ]);
    }
  }));
