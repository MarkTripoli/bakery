/**
 * #448 slice S5: a person reverts a step's writes (section 17.6, O48) on a
 * real database: the tree goes back to how it was, every reversal is audited,
 * a later edit by a person refuses the undo by name and reverts nothing, and a
 * second undo reverts nothing.
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  seedEligibleJob,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

/** A person's own request, as the web app sends it. */
function asPerson(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: number,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
        ...(ifMatch === undefined ? {} : { "If-Match": '"' + ifMatch + '"' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

async function json(response: Response, status: number): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

type Agent = {
  call(tool: string, args: Json, ifMatch?: number): Promise<Response>;
  attemptId: string;
  job: Awaited<ReturnType<typeof seedEligibleJob>>;
};

/**
 * An agent in a real session: a registered worker claims a seeded job and
 * calls Bakery's own operations through the self-connection with the session
 * credential the claim minted.
 */
async function agentSession(
  fixture: Fixture,
  name: string,
  beforeClaim: (
    job: Awaited<ReturnType<typeof seedEligibleJob>>,
  ) => Promise<void>,
): Promise<Agent> {
  const worker = await registeredWorker(fixture, { name, slots: 1 });
  // A nonmodel job (quality.check): the fixture worker claims it with its
  // default capabilities. A model job needs funding and a model route, so a
  // bare seedEligibleJob is never claimed and the claim answers 204.
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  // The write scope is minted at claim only where a grant exists by then.
  await beforeClaim(job);
  const assignment = await claimAssignment(fixture, worker) as
    & Awaited<ReturnType<typeof claimAssignment>>
    & { sessionCredential?: string };
  const token = assignment.sessionCredential;
  assert(token, "the claim mints a session credential");
  return {
    attemptId: assignment.attemptId,
    job,
    call: (tool, args, ifMatch) =>
      workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool, arguments: args },
        {
          headers: {
            "x-session-credential": token,
            ...(ifMatch === undefined
              ? {}
              : { "If-Match": '"' + ifMatch + '"' }),
          },
        },
      ),
  };
}

/**
 * A session call answers the gateway's envelope, `{ outcome, result }`, with
 * the operation's own response under `result` (session-gateway.ts
 * callSessionTool); a refusal is an ordinary problem body.
 */
async function sessionResult(response: Response): Promise<Json> {
  const body = await json(response, 200) as { outcome?: string; result?: Json };
  assertEquals(body.outcome, "allowed", JSON.stringify(body));
  assert(body.result, "the session call returned no result");
  return body.result;
}

async function grantFolder(
  fixture: Fixture,
  workflowId: string,
  folderId: string,
  access: "read" | "write",
): Promise<Json> {
  return await json(
    await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
      workflowId,
      folderId,
      access,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    201,
  );
}

const file = (path: string, content = "agent bytes") => ({
  path,
  mediaType: "text/plain",
  content: btoa(content),
});

/** The attempt ends (lost, as a failed attempt), so its writes can be reverted. */
async function endAttempt(fixture: Fixture, attemptId: string) {
  await fixture.pgDatabase.query(
    "update bakery.job_attempts set status = 'lost'" +
      " where organization_id = $1 and id = $2",
    [fixture.organizationId, attemptId],
  );
}

function revert(fixture: Fixture, agent: Agent): Promise<Response> {
  return asPerson(
    fixture,
    "POST",
    "/v1/runs/" + agent.job.runId + "/steps/worker/writes/revert",
    { reason: "the agent wrote the wrong files" },
  );
}

async function entryById(fixture: Fixture, id: unknown) {
  return (await fixture.pgDatabase.query<{
    trashed_at: Date | null;
    current_version_id: string | null;
  }>(
    "select trashed_at, current_version_id from bakery.storage_entries" +
      " where organization_id = $1 and id = $2",
    [fixture.organizationId, id],
  )).rows[0];
}

async function setUp(fixture: Fixture, name: string) {
  const folder = await json(
    await asPerson(fixture, "POST", "/v1/storage/folders", {
      path: "/shared/" + name,
    }),
    201,
  );
  const before = await json(
    await asPerson(
      fixture,
      "PUT",
      "/v1/storage/files",
      file("/shared/" + name + "/b.md", "person bytes"),
    ),
    200,
  );
  const agent = await agentSession(fixture, name, async (job) => {
    await grantFolder(fixture, job.workflowId, folder.id as string, "write");
  });
  return { folder, before, agent };
}

Deno.test("reverting a step's put, new version and mkdir puts the tree back, audited, once", () =>
  withWorkerFixture(async (fixture) => {
    const { before, agent } = await setUp(fixture, "agent-448-undo");
    const made = await sessionResult(
      await agent.call("storageFolders.create", {
        path: "/shared/agent-448-undo/made",
      }),
    );
    const created = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-undo/made/a.md"),
      ),
    );
    const changed = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-undo/b.md", "agent bytes"),
        before.version as number,
      ),
    );
    assert(changed.currentVersionId !== before.currentVersionId);
    await endAttempt(fixture, agent.attemptId);

    const result = await json(await revert(fixture, agent), 200);
    assertEquals(result.reverted, 3);
    assertEquals(result.entries, 3);
    // Created entries are in trash; the changed file has its old version back.
    assert((await entryById(fixture, made.id)).trashed_at !== null);
    assert((await entryById(fixture, created.id)).trashed_at !== null);
    const restored = await entryById(fixture, before.id);
    assertEquals(restored.trashed_at, null);
    assertEquals(restored.current_version_id, before.currentVersionId);

    const audits = await fixture.pgDatabase.query<{
      operation: string;
      principal_id: string;
    }>(
      "select operation, principal_id from bakery.audit_events" +
        " where organization_id = $1 and operation in" +
        " ('runSteps.revertWrites', 'storageEntries.revertStepWrite')",
      [fixture.organizationId],
    );
    assertEquals(
      audits.rows.filter((row) => row.operation === "runSteps.revertWrites")
        .length,
      1,
    );
    assertEquals(
      audits.rows.filter((row) =>
        row.operation === "storageEntries.revertStepWrite"
      ).length,
      3,
    );
    assert(
      audits.rows.every((row) => row.principal_id === fixture.principalId),
    );
    const marked = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.step_write_set" +
        " where organization_id = $1 and attempt_id = $2" +
        " and reverted_at is not null and reverted_by_principal_id = $3",
      [fixture.organizationId, agent.attemptId, fixture.principalId],
    );
    assertEquals(marked.rows[0].n, "3");

    // A second undo finds nothing left and changes nothing.
    const again = await json(await revert(fixture, agent), 200);
    assertEquals(again.reverted, 0);
    assertEquals(
      (await entryById(fixture, before.id)).current_version_id,
      before.currentVersionId,
    );
  }));

Deno.test("a person's later edit refuses the undo by name, and nothing is reverted", () =>
  withWorkerFixture(async (fixture) => {
    const { before, agent } = await setUp(fixture, "agent-448-undo-conflict");
    const created = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-undo-conflict/a.md"),
      ),
    );
    const changed = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-undo-conflict/b.md", "agent bytes"),
        before.version as number,
      ),
    );
    await endAttempt(fixture, agent.attemptId);
    const edited = await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        file("/shared/agent-448-undo-conflict/b.md", "person edits again"),
        changed.version as number,
      ),
      200,
    );

    const response = await revert(fixture, agent);
    const body = JSON.parse(await response.text()) as Json & {
      issues?: { path?: string[]; code?: string }[];
    };
    assertEquals(response.status, 409);
    assertEquals(body.reason, "step_writes_conflict");
    assertEquals(body.issues?.map((issue) => issue.code), [
      "changed_since_step",
    ]);
    assertEquals(body.issues?.[0].path, [
      "/shared/agent-448-undo-conflict/b.md",
    ]);
    // All or nothing: the agent's other file is still there, the person's edit
    // is current, and no write is marked undone.
    assertEquals((await entryById(fixture, created.id)).trashed_at, null);
    assertEquals(
      (await entryById(fixture, before.id)).current_version_id,
      edited.currentVersionId,
    );
    const marked = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.step_write_set" +
        " where organization_id = $1 and attempt_id = $2" +
        " and reverted_at is not null",
      [fixture.organizationId, agent.attemptId],
    );
    assertEquals(marked.rows[0].n, "0");
  }));
