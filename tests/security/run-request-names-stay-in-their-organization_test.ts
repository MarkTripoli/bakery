import { assertEquals } from "@std/assert";
import { createPeopleTagStepRunner } from "../../apps/server/src/modules/work/people-tag-step.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import {
  addMember,
  api,
  seedArtifactVersion,
  seedRun,
  seedStep,
} from "../helpers/run-requests.ts";

type Request = {
  recipient: { principalId: string };
  ownerFallback: boolean;
  fallbackForName: string | null;
  nextAsk: { who: string | null } | null;
};

Deno.test("a person in another organization is never named on this organization's requests", async () => {
  const fixture = await openSocketFixture();
  const dev = await addMember(fixture, "Asker", "developer");
  const guest = await addMember(fixture, "Asked", "guest");
  const other = await seedOrganization(fixture, "elsewhere-person");
  try {
    const run = await seedRun(fixture);
    const asked = await api(
      fixture,
      dev.cookie,
      "POST",
      `/v1/runs/${run.runId}/requests`,
      { recipientId: other.principalId, intent: "fyi" },
    );
    assertEquals(asked.status, 201, await asked.clone().text());
    const made = await asked.json() as Request;
    assertEquals(made.ownerFallback, true);
    assertEquals(made.recipient.principalId, fixture.principalId);
    assertEquals(made.fallbackForName, "someone");

    await seedStep(fixture, run, "notify");
    const version = await seedArtifactVersion(fixture, run.taskId, run.runId);
    const input = {
      intent: "review",
      recipientId: guest.principalId,
      artifactVersionId: version,
      wait: true,
      ifNobodyAnswers: { afterHours: 24, recipientId: other.principalId },
    };
    await fixture.pgDatabase.query(
      `update bakery.run_steps set input = $3::jsonb
        where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
      [fixture.organizationId, run.runId, JSON.stringify(input)],
    );
    const runner = createPeopleTagStepRunner({
      database: fixture.runtimePgDatabase,
    });
    assertEquals(
      await runner.run({
        organizationId: fixture.organizationId,
        runId: run.runId,
        taskId: run.taskId,
        repositoryId: null,
        requestedBy: fixture.principalId,
        traceId: "trace-tenancy",
        stepKey: "notify",
        iteration: 0,
        action: "people.tag",
        input,
      }),
      { kind: "pending" },
    );
    const listed = await api(
      fixture,
      fixture.cookie,
      "GET",
      `/v1/runs/${run.runId}/requests`,
    );
    const requests = (await listed.json() as { requests: Request[] }).requests;
    const review = requests.find((request) =>
      request.recipient.principalId === guest.principalId
    )!;
    assertEquals(review.nextAsk?.who, null);
    const body = JSON.stringify(requests);
    assertEquals(body.includes("elsewhere-person"), false);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [fixture.organizationId],
    );
    await cleanupSeededOrganizations(fixture);
    await cleanupAuthFixture(fixture.pgDatabase, [dev.email, guest.email]);
    await fixture.close();
  }
});
