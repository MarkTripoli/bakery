/**
 * #448: the audit names both identities of an agent's write (O50), a person's
 * and an agent's audit rows share one shape (R1), and the guard's reads are
 * scoped to the caller's organization (layer 5) on a real database.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
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
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { assertAgentFileWrite } from "../../apps/server/src/modules/knowledge/agent-file-guard.ts";
import { stepFilesForAttempt } from "../../apps/server/src/modules/execution/step-files.ts";
import { DEFAULT_STEP_FILES } from "../../packages/contracts/src/workflow-compiler/mod.ts";

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

/** The status, code and named reason of a refusal. */
async function refusal(response: Response) {
  const body = JSON.parse(await response.text()) as Json & {
    issues?: { code?: string }[];
  };
  return {
    status: response.status,
    code: body.code,
    reason: (body.reason as string | undefined) ?? body.issues?.[0]?.code,
  };
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

Deno.test("an agent's write is audited with the person and the session, in the person's shape", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-audit",
      }),
      201,
    );
    const agent = await agentSession(
      fixture,
      "agent-448-audit",
      async (job) => {
        await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    const byAgent = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-audit/a.md"),
      ),
    );
    const byPerson = await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        file("/shared/agent-448-audit/b.md", "person bytes"),
      ),
      200,
    );
    const audit = async (entryId: unknown) =>
      (await fixture.pgDatabase.query<{
        principal_id: string;
        agent_session_id: string | null;
        details: { actor: Record<string, unknown> };
      }>(
        "select principal_id, agent_session_id, details from bakery.audit_events where operation = 'storageFiles.put' and resource_id = $1",
        [entryId],
      )).rows[0];
    const agentRow = await audit(byAgent.id);
    const personRow = await audit(byPerson.id);
    // Both identities: the person acted for, and the session that called.
    assertEquals(agentRow.principal_id, fixture.principalId);
    assert(agentRow.agent_session_id !== null);
    assertEquals(agentRow.details.actor.kind, "agent");
    assertEquals(agentRow.details.actor.attemptId, agent.attemptId);
    assertEquals(
      agentRow.details.actor.agentSessionId,
      agentRow.agent_session_id,
    );
    assert(agentRow.details.actor.fileGrantId);
    // A person's row: same keys, null where an agent's identity would be.
    assertEquals(personRow.agent_session_id, null);
    assertEquals(personRow.details.actor.kind, "person");
    assertEquals(
      Object.keys(personRow.details).sort(),
      Object.keys(agentRow.details).sort(),
    );
    assertEquals(
      Object.keys(personRow.details.actor).sort(),
      Object.keys(agentRow.details.actor).sort(),
    );
  }));

Deno.test("the guard reads only the caller's organization: a foreign organization sees no folder", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-tenancy",
      }),
      201,
    );
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await grantFolder(fixture, job.workflowId, folder.id as string, "write");
    const scope = (organizationId: string) => ({
      organizationId,
      principalId: fixture.principalId,
      workflowId: job.workflowId,
      attemptId: crypto.randomUUID(),
      agentSessionId: null,
      target: {
        id: folder.id as string,
        policy: "working" as const,
        owner_id: null,
        system_key: null,
      },
      rawPath: "/shared/agent-448-tenancy/a.md",
      access: "write" as const,
      now: new Date(),
    });
    // Allowed in its own organization...
    const allowed = await withPgTransaction(
      fixture.pgDatabase,
      (tx) => assertAgentFileWrite(tx, scope(fixture.organizationId)),
    );
    assert(allowed.fileGrantId);
    // ...and not found from any other, with the same folder id and grant.
    const error = await assertRejects(() =>
      withPgTransaction(
        fixture.pgDatabase,
        (tx) => assertAgentFileWrite(tx, scope(crypto.randomUUID())),
      )
    );
    assert(error instanceof StandardError);
    assertEquals(error.code, "RESOURCE_NOT_FOUND");
  }));

Deno.test("a grant is bounded: a person only, a future expiry within 30 days, a revoke names the version", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-bounds",
      }),
      201,
    );
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const create = (expiresAt: string) =>
      asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
        workflowId: job.workflowId,
        folderId: folder.id,
        access: "write",
        expiresAt,
      });
    assertEquals(
      (await refusal(await create(new Date(Date.now() - 1000).toISOString())))
        .status,
      422,
    );
    assertEquals(
      (await refusal(
        await create(new Date(Date.now() + 31 * 86_400_000).toISOString()),
      )).status,
      422,
    );
    assertEquals(
      (await refusal(
        await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
          workflowId: crypto.randomUUID(),
          folderId: folder.id,
          access: "write",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      )).status,
      404,
    );
    const grant = await grantFolder(
      fixture,
      job.workflowId,
      folder.id as string,
      "write",
    );
    const path = "/v1/storage/agent-file-grants/" + grant.id + "/revoke";
    assertEquals(
      (await refusal(await asPerson(fixture, "POST", path))).status,
      428,
    );
    assertEquals(
      (await refusal(await asPerson(fixture, "POST", path, undefined, 99)))
        .status,
      412,
    );
    const revoked = await json(
      await asPerson(fixture, "POST", path, undefined, grant.version as number),
      200,
    );
    assert(revoked.revokedAt);
    assertEquals(revoked.revokedBy, fixture.principalId);
    assertEquals(
      (await refusal(
        await asPerson(
          fixture,
          "POST",
          path,
          undefined,
          revoked.version as number,
        ),
      )).reason,
      "agent_file_grant_revoked",
    );
  }));

Deno.test("the claim mints the step's files section (O44, O45) into the session credential", () =>
  withWorkerFixture(async (fixture) => {
    const agent = await agentSession(
      fixture,
      "agent-448-scopes",
      async () => {},
    );
    // The step has no files section, so the defaults apply on a real run.
    const files = await withPgTransaction(
      fixture.pgDatabase,
      (tx) => stepFilesForAttempt(tx, fixture.organizationId, agent.attemptId),
    );
    assertEquals(files, DEFAULT_STEP_FILES);
    const stored = await fixture.pgDatabase.query<{ scopes: string[] }>(
      "select scopes from bakery.session_operation_credentials" +
        " where organization_id = $1 and attempt_id = $2" +
        " and revoked_at is null",
      [fixture.organizationId, agent.attemptId],
    );
    const scopes = stored.rows[0]?.scopes ?? [];
    for (
      const scope of [
        "files.read",
        "files.read:project",
        "files.read:shared",
        "files.read:library",
        "files.write",
        "files.write:attachments",
        "files.write:assets",
        "files.write:workspaces",
      ]
    ) assert(scopes.includes(scope), scope + " in " + JSON.stringify(scopes));
    // No personal area is ever minted.
    assert(!scopes.some((scope) => scope.includes("users")));
  }));
