/**
 * #448 S9a: comments and work-item edits through an agent's session. The power
 * comes from a person's grant, the call runs as the person the run is for, the
 * audit names the session, and a revoked grant stops the next call.
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
 * A session call that has not answered in 30 s fails the test by name. The
 * gateway holds the attempt row while the operation runs on another
 * connection; a lock the two wait on in turn never errors in Postgres (the
 * cycle runs through the client), so without this a regression hangs.
 */
async function bounded(
  call: Promise<Response>,
  tool: string,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("session call " + tool + " hung for 30 s")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
      bounded(
        workerRequest(
          fixture,
          worker.credential,
          "/v1/worker/attempts/" + assignment.attemptId + "/session-call",
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
        tool,
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

type Grant = { id: string; version: number };

async function grantPower(
  fixture: Fixture,
  power: string,
  workflowId: string,
): Promise<Grant> {
  return await json(
    await asPerson(fixture, "POST", "/v1/agent-power-grants", {
      power,
      workflowId,
    }),
    201,
  ) as unknown as Grant;
}

/** One document version in the job's task, for a comment to land on. */
async function seedVersion(
  fixture: Fixture,
  taskId: string,
): Promise<string> {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode("document text");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'document','Session comments')",
    [artifactId, fixture.organizationId, taskId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type)
     values($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      content,
      digest,
      content.length,
    ],
  );
  return versionId;
}

const taskRow = async (fixture: Fixture, taskId: string) =>
  (await fixture.pgDatabase.query<{ title: string; version: number }>(
    "select title, version from bakery.tasks where id = $1",
    [taskId],
  )).rows[0]!;

Deno.test("a session without the powers is offered no comment or work tool and changes nothing", () =>
  withWorkerFixture(async (fixture) => {
    const agent = await agentSession(
      fixture,
      "agent-448-s9a-none",
      async () => {},
    );
    const before = await taskRow(fixture, agent.job.taskId);
    const versionId = await seedVersion(fixture, agent.job.taskId);
    const edit = await agent.call(
      "tasks.update",
      { id: agent.job.taskId, title: "Renamed by an agent" },
      before.version,
    );
    assertEquals(edit.status, 403, await edit.clone().text());
    const comment = await agent.call("artifactComments.create", {
      id: versionId,
      body: "an uninvited comment",
    });
    assertEquals(comment.status, 403, await comment.clone().text());
    assertEquals(await taskRow(fixture, agent.job.taskId), before);
    assertEquals(
      (await fixture.pgDatabase.query<{ n: number }>(
        "select count(*)::int as n from bakery.artifact_comments where organization_id = $1",
        [fixture.organizationId],
      )).rows[0]!.n,
      0,
    );
  }));

Deno.test("granted, an agent comments and edits as the person, audit names its session, and a revoked grant stops the next call", () =>
  withWorkerFixture(async (fixture) => {
    try {
      let comment: Grant | undefined;
      const agent = await agentSession(
        fixture,
        "agent-448-s9a-granted",
        async (job) => {
          comment = await grantPower(fixture, "comment", job.workflowId);
          await grantPower(fixture, "edit_work", job.workflowId);
        },
      );
      const versionId = await seedVersion(fixture, agent.job.taskId);

      const before = await taskRow(fixture, agent.job.taskId);
      const edited = await sessionResult(
        await agent.call(
          "tasks.update",
          { id: agent.job.taskId, title: "Renamed by an agent" },
          before.version,
        ),
      );
      assertEquals(edited.title, "Renamed by an agent");

      const created = await sessionResult(
        await agent.call("artifactComments.create", {
          id: versionId,
          body: "Looks good to me",
        }),
      );
      assertEquals(created.body, "Looks good to me");

      // The call ran as the person the run is for, and each audit row names the
      // session that made it (O50).
      for (
        const [operation, resourceId] of [
          ["tasks.update", agent.job.taskId],
          ["artifactComments.create", created.id],
        ] as const
      ) {
        const row = (await fixture.pgDatabase.query<{
          principal_id: string;
          agent_session_id: string | null;
        }>(
          "select principal_id, agent_session_id from bakery.audit_events where operation = $1 and resource_id = $2",
          [operation, resourceId],
        )).rows[0];
        assert(row, operation + " is audited");
        assertEquals(row.principal_id, fixture.principalId, operation);
        assert(row.agent_session_id !== null, operation + " names the session");
      }
      assertEquals(
        (await fixture.pgDatabase.query<{ n: number }>(
          "select count(*)::int as n from bakery.session_operation_audits where organization_id = $1 and attempt_id = $2 and outcome = 'allowed' and operation in ('tasks.update','artifactComments.create')",
          [fixture.organizationId, agent.attemptId],
        )).rows[0]!.n,
        2,
        "the gateway recorded both calls",
      );

      // A revoke reaches a session already holding the scope: the grant is
      // checked again at every call.
      assertEquals(
        (await asPerson(
          fixture,
          "DELETE",
          "/v1/agent-power-grants/" + comment!.id,
          undefined,
          comment!.version,
        )).status,
        204,
      );
      const after = await agent.call("artifactComments.create", {
        id: versionId,
        body: "a comment after the revoke",
      });
      assertEquals(after.status, 403, await after.clone().text());
      assertEquals(
        (await fixture.pgDatabase.query<{ n: number }>(
          "select count(*)::int as n from bakery.artifact_comments where organization_id = $1",
          [fixture.organizationId],
        )).rows[0]!.n,
        1,
        "only the granted comment exists",
      );
      // The edit power was not revoked and still works.
      const again = await taskRow(fixture, agent.job.taskId);
      await sessionResult(
        await agent.call(
          "tasks.update",
          { id: agent.job.taskId, title: "Renamed twice" },
          again.version,
        ),
      );
    } finally {
      // The fixture's teardown deletes versions, which comments reference.
      await fixture.pgDatabase.query(
        "delete from bakery.artifact_comment_mentions where organization_id = $1",
        [fixture.organizationId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.artifact_comments where organization_id = $1",
        [fixture.organizationId],
      );
    }
  }));
