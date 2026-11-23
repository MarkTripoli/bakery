import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
  SESSION_TOOLS_PATH,
} from "../../apps/server/src/modules/execution/session-routes.ts";

// #401 QA findings on 771010d9, driven through the real app (`createApp`).
//
// The earlier gateway tests listed tools and unit-tested refusal against a stub
// guard, so a gateway that refused every call, for everyone, still passed.
// These call a real list tool as the person the run is for and as someone with
// no membership, and pin the typed refusals and the replay behaviour.

type Claimed = { attemptId: string; sessionCredential?: string };

async function claimFor(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  requesterId: string,
) {
  const worker = await registeredWorker(fixture, { slots: 1 });
  await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    requesterId,
  );
  const claimKey = crypto.randomUUID();
  const assignment = await claimAssignment(fixture, worker, {
    claimKey,
  }) as unknown as Claimed;
  assert(typeof assignment.sessionCredential === "string", "no credential");
  return { worker, claimKey, assignment };
}

function callTool(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  attemptId: string,
  token: string,
  tool: string,
) {
  return workerRequest(
    fixture,
    worker.credential,
    SESSION_CALL_PATH.replace(":id", attemptId),
    { tool, arguments: {} },
    { headers: { [SESSION_CREDENTIAL_HEADER]: token } },
  );
}

Deno.test("a session acts as the person: the admin is served", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment } = await claimFor(
      fixture,
      fixture.principalId,
    );
    const response = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      assignment.sessionCredential!,
      "agents.list",
    );
    const text = await response.text();
    assertEquals(response.status, 200, text);
  }));

Deno.test("a session for a person with no membership is not served", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment } = await claimFor(
      fixture,
      fixture.principalId,
    );
    // The person loses access after the run starts. A session never exceeds
    // the person, so it loses it too: the guard reads live membership.
    await fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    const response = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      assignment.sessionCredential!,
      "agents.list",
    );
    const text = await response.text();
    assertEquals(response.status, 404, text);
  }));

Deno.test("session refusals are typed, not 500", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, assignment } = await claimFor(
      fixture,
      fixture.principalId,
    );
    const token = assignment.sessionCredential!;

    const bogus = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      "not-a-real-token",
      "agents.list",
    );
    assertEquals(bogus.status, 401, await bogus.text());

    // A tool that is not offered.
    const unlisted = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      token,
      "workflows.delete",
    );
    assertEquals(unlisted.status, 404, await unlisted.text());

    // No credential header at all.
    const missing = await workerRequest(
      fixture,
      worker.credential,
      SESSION_CALL_PATH.replace(":id", assignment.attemptId),
      { tool: "agents.list", arguments: {} },
    );
    assertEquals(missing.status, 401, await missing.text());
  }));

Deno.test("a replayed claim revokes the old credential and mints a fresh one", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, claimKey, assignment } = await claimFor(
      fixture,
      fixture.principalId,
    );
    const first = assignment.sessionCredential!;

    const replay = await claimAssignment(fixture, worker, {
      claimKey,
    }) as unknown as Claimed;
    assertEquals(replay.attemptId, assignment.attemptId);
    const second = replay.sessionCredential;
    assert(typeof second === "string", "the replay carried no credential");
    assertNotEquals(second, first, "the replay re-served the old token");

    const old = await workerRequest(
      fixture,
      worker.credential,
      SESSION_TOOLS_PATH.replace(":id", assignment.attemptId),
      undefined,
      { method: "GET", headers: { [SESSION_CREDENTIAL_HEADER]: first } },
    );
    assertEquals(old.status, 401, await old.text());

    const fresh = await workerRequest(
      fixture,
      worker.credential,
      SESSION_TOOLS_PATH.replace(":id", assignment.attemptId),
      undefined,
      { method: "GET", headers: { [SESSION_CREDENTIAL_HEADER]: second } },
    );
    assertEquals(fresh.status, 200, await fresh.text());

    // The fresh token can act, and the first cannot, through the call route.
    const freshCall = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      second,
      "agents.list",
    );
    assertEquals(freshCall.status, 200, await freshCall.text());
    const oldCall = await callTool(
      fixture,
      worker,
      assignment.attemptId,
      first,
      "agents.list",
    );
    assertEquals(oldCall.status, 401, await oldCall.text());

    // Digest only: neither token is stored.
    const stored = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.session_operation_credentials
        where attempt_id = $1 and revoked_at is null`,
      [assignment.attemptId],
    );
    assertEquals(stored.rows[0].n, "1");
  }));
