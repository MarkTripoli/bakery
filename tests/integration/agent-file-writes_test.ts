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
import {
  compileWorkflowDocument,
  DEFAULT_STEP_FILES,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

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

Deno.test("an agent's put writes exactly one write-set row, and its version reads as the agent's", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-write-set",
      }),
      201,
    );
    const agent = await agentSession(
      fixture,
      "agent-448-write-set",
      async (job) => {
        await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    const written = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-write-set/a.md"),
      ),
    );
    // A person's own write in the same folder is in no step's set.
    await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        file("/shared/agent-448-write-set/b.md", "person bytes"),
      ),
      200,
    );
    const rows = await fixture.pgDatabase.query<{
      attempt_id: string;
      agent_session_id: string | null;
      entry_id: string;
      op: string;
      previous_version_id: string | null;
      new_version_id: string | null;
    }>(
      "select attempt_id, agent_session_id, entry_id, op," +
        " previous_version_id, new_version_id from bakery.step_write_set" +
        " where organization_id = $1 and attempt_id = $2",
      [fixture.organizationId, agent.attemptId],
    );
    assertEquals(rows.rows.length, 1);
    const row = rows.rows[0];
    assertEquals(row.entry_id, written.id);
    assertEquals(row.op, "put");
    assertEquals(row.previous_version_id, null);
    assertEquals(row.new_version_id, written.currentVersionId);
    const audit = await fixture.pgDatabase.query<
      { agent_session_id: string | null }
    >(
      "select agent_session_id from bakery.audit_events" +
        " where organization_id = $1 and operation = 'storageFiles.put'" +
        " and resource_id = $2",
      [fixture.organizationId, written.id],
    );
    assertEquals(audit.rows.length, 1);
    assert(audit.rows[0].agent_session_id !== null);
    assertEquals(audit.rows[0].agent_session_id, row.agent_session_id);
    const person = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.step_write_set w" +
        " join bakery.storage_entries e on e.organization_id = w.organization_id" +
        " and e.id = w.entry_id" +
        " where w.organization_id = $1 and e.name = 'b.md'",
      [fixture.organizationId],
    );
    assertEquals(person.rows[0].n, "0");
    // The version the agent wrote reads as the agent's, naming the person.
    const versions = await json(
      await asPerson(
        fixture,
        "GET",
        "/v1/storage/files/" + written.id + "/versions",
      ),
      200,
    ) as { items: Json[] };
    assertEquals(versions.items[0].makerKind, "agent");
    assertEquals(versions.items[0].makerPrincipalId, fixture.principalId);
    assertEquals(versions.items[0].sessionId, row.agent_session_id);
    // #448 S8a: the version itself recorded, at the write, the run, step,
    // attempt and session that made it and the person the run acts for.
    const origin = (await fixture.pgDatabase.query<{
      run_id: string;
      run_step_id: string;
    }>(
      "select step.run_id, job.run_step_id from bakery.job_attempts attempt" +
        " join bakery.jobs job on job.organization_id = attempt.organization_id" +
        " and job.id = attempt.job_id" +
        " join bakery.run_steps step on step.organization_id = job.organization_id" +
        " and step.id = job.run_step_id" +
        " where attempt.organization_id = $1 and attempt.id = $2",
      [fixture.organizationId, agent.attemptId],
    )).rows[0];
    const stored = (await fixture.pgDatabase.query<{
      run_id: string | null;
      run_step_id: string | null;
      attempt_id: string | null;
      agent_session_id: string | null;
      acting_for_principal_id: string | null;
    }>(
      "select run_id, run_step_id, attempt_id, agent_session_id," +
        " acting_for_principal_id from bakery.storage_file_versions" +
        " where organization_id = $1 and id = $2",
      [fixture.organizationId, written.currentVersionId],
    )).rows[0];
    assertEquals(stored, {
      run_id: origin.run_id,
      run_step_id: origin.run_step_id,
      attempt_id: agent.attemptId,
      agent_session_id: row.agent_session_id,
      acting_for_principal_id: fixture.principalId,
    });
    const made = versions.items[0];
    assertEquals(made.attemptId, agent.attemptId);
    assertEquals(made.runId, origin.run_id);
    assertEquals(made.stepId, origin.run_step_id);
    assertEquals(made.actingForPrincipalId, fixture.principalId);
    // A later session on the same step (a retry, a continuation) does not
    // become the maker of the version the earlier one wrote.
    await fixture.pgDatabase.query(
      "insert into bakery.agent_sessions (organization_id, run_step_id," +
        " conversation_id, agent_version_id, harness, status, created_at)" +
        " select organization_id, run_step_id, conversation_id," +
        " agent_version_id, harness, 'active', now() + interval '1 hour'" +
        " from bakery.agent_sessions where organization_id = $1 and id = $2",
      [fixture.organizationId, row.agent_session_id],
    );
    const again = await json(
      await asPerson(
        fixture,
        "GET",
        "/v1/storage/files/" + written.id + "/versions",
      ),
      200,
    ) as { items: Json[] };
    assertEquals(again.items[0].sessionId, row.agent_session_id);
    assertEquals(again.items[0].attemptId, agent.attemptId);
    // The search hit names the same maker.
    const hits = await json(
      await asPerson(fixture, "GET", "/v1/files/search?query=a.md"),
      200,
    ) as { items: Json[] };
    const hit = hits.items.find((item) => item.entryId === written.id);
    assert(hit, "the agent's file is a search hit");
    assertEquals(hit.producerKind, "agent");
    assertEquals(hit.producerSessionId, row.agent_session_id);
    assertEquals(hit.producerAttemptId, agent.attemptId);
    assertEquals(hit.producerRunId, origin.run_id);
    assertEquals(hit.producerStepId, origin.run_step_id);
    assertEquals(hit.producerActingForId, fixture.principalId);
    // A person's own version records no provenance at all.
    const own = await json(
      await asPerson(fixture, "GET", "/v1/files/search?query=b.md"),
      200,
    ) as { items: Json[] };
    const ownHit = own.items.find((item) =>
      (item.path as string).endsWith("/agent-448-write-set/b.md")
    );
    assert(ownHit, "the person's file is a search hit");
    assertEquals(ownHit.producerKind, "person");
    assertEquals(ownHit.producerAttemptId, null);
    assertEquals(ownHit.producerSessionId, null);
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

Deno.test("an agent at its step's file limit is refused the next write; a person is not (O49)", () =>
  withWorkerFixture(async (fixture) => {
    const current = await json(
      await asPerson(fixture, "GET", "/v1/storage/settings"),
      200,
    );
    assertEquals(current.stepWriteFiles, 2000);
    assertEquals(current.stepWriteBytes, 2 * 1024 ** 3);
    const {
      organizationUsedBytes: _used,
      organizationQuotaState: _state,
      customized: _customized,
      version: _version,
      ...limits
    } = current;
    const saved = await json(
      await asPerson(fixture, "PUT", "/v1/storage/settings", {
        ...limits,
        stepWriteFiles: 2,
      }),
      200,
    );
    assertEquals(saved.stepWriteFiles, 2);
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-limits",
      }),
      201,
    );
    const agent = await agentSession(
      fixture,
      "agent-448-limits",
      async (job) => {
        await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    const first = await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-limits/1.md"),
      ),
    );
    await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-limits/2.md"),
      ),
    );
    // A new version of a file the step already wrote is not a new file.
    await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-limits/1.md", "agent bytes, again"),
        first.version as number,
      ),
    );
    const refused = await agent.call(
      "storageFiles.put",
      file("/shared/agent-448-limits/3.md"),
    );
    assertEquals(await refusal(refused), {
      status: 409,
      code: "STEP_WRITE_LIMIT_EXCEEDED",
      reason: "files",
    });
    const kept = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.storage_entries" +
        " where organization_id = $1 and parent_id = $2",
      [fixture.organizationId, folder.id],
    );
    assertEquals(kept.rows[0].n, "2");
    // A person's writes are never limited by a step's limit.
    await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        file("/shared/agent-448-limits/3.md", "person bytes"),
      ),
      200,
    );
  }));

/**
 * Pins a compiled plan document into the seeded run's snapshot, so the claim
 * reads the claimed step's files section from it. The seeded step's key is
 * `worker`; `files` is that step's section (undefined: the defaults).
 *
 * A run whose snapshot carries `runtime` is a plan run, and claim admission
 * reads a plan step's work from the dispatch the engine recorded on its row
 * (actionAndInputFromSnapshot -> planDispatchFromRow), not from the flat
 * spec. The seeded row has no dispatch, so without one the job is skipped as
 * workflow_plan_dispatch_invalid and the claim answers 204. The dispatch
 * recorded here is the seeded job's action and attempts, the step's own input
 * (the job's input minus the repositoryProfile admission adds), and no
 * declared requirements (the action's registered capabilities apply), which
 * is what the engine would have admitted it with.
 */
async function pinPlanStep(
  fixture: Fixture,
  job: Awaited<ReturnType<typeof seedEligibleJob>>,
  files: Json | undefined,
): Promise<void> {
  const compiled = await compileWorkflowDocument({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "agent-448-step-files",
    description: "One step whose files section the claim mints from.",
    inputs: {},
    steps: [{
      id: "worker",
      uses: "workflow.noop",
      ...(files === undefined ? {} : { files }),
    }],
  }, { catalog: defaultWorkflowCompilerCatalog() });
  assert(compiled.ok, JSON.stringify(compiled));
  const updated = await fixture.pgDatabase.query(
    "update bakery.workflow_runs set snapshot = snapshot || jsonb_build_object('runtime', $3::jsonb)" +
      " where organization_id = $1 and id = $2",
    [
      fixture.organizationId,
      job.runId,
      JSON.stringify({ pin: {}, document: compiled.document }),
    ],
  );
  assertEquals(updated.rowCount, 1);
  const dispatched = await fixture.pgDatabase.query(
    "update bakery.run_steps as step set dispatch = jsonb_build_object(" +
      "'action', job.action, 'input', step.input," +
      " 'requires', '[]'::jsonb," +
      " 'retry', jsonb_build_object('maxAttempts', job.max_attempts))" +
      " from bakery.jobs as job" +
      " where job.organization_id = step.organization_id" +
      " and job.run_step_id = step.id" +
      " and job.organization_id = $1 and job.id = $2",
    [fixture.organizationId, job.jobId],
  );
  assertEquals(dispatched.rowCount, 1);
}

/** The live scopes minted for an attempt's session credential. */
async function mintedScopes(
  fixture: Fixture,
  attemptId: string,
): Promise<string[]> {
  const stored = await fixture.pgDatabase.query<{ scopes: string[] }>(
    "select scopes from bakery.session_operation_credentials" +
      " where organization_id = $1 and attempt_id = $2" +
      " and revoked_at is null",
    [fixture.organizationId, attemptId],
  );
  assertEquals(stored.rows.length, 1);
  return stored.rows[0]!.scopes;
}

Deno.test("an inputs-only step gets no file scope from a live write grant; a default step keeps files.write", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-inputs-only",
      }),
      201,
    );
    const isFileScope = (scope: string) =>
      scope === "files.read" || scope === "files.write" ||
      scope.startsWith("files.read:") || scope.startsWith("files.write:");
    // Each session's workflow holds a live person write grant on the folder
    // before the claim, so the grant would mint files.write if it were kept.
    const narrow = await agentSession(
      fixture,
      "agent-448-inputs-only",
      async (job) => {
        await pinPlanStep(fixture, job, {
          read: ["inputs"],
          write: ["outputs"],
        });
        await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    assertEquals(
      await withPgTransaction(
        fixture.pgDatabase,
        (tx) =>
          stepFilesForAttempt(tx, fixture.organizationId, narrow.attemptId),
      ),
      { read: ["inputs"], write: ["outputs"] },
    );
    const narrowScopes = await mintedScopes(fixture, narrow.attemptId);
    assertEquals(
      narrowScopes.filter(isFileScope),
      [],
      JSON.stringify(narrowScopes),
    );

    const wide = await agentSession(
      fixture,
      "agent-448-default-section",
      async (job) => {
        await pinPlanStep(fixture, job, undefined);
        await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    assertEquals(
      await withPgTransaction(
        fixture.pgDatabase,
        (tx) => stepFilesForAttempt(tx, fixture.organizationId, wide.attemptId),
      ),
      DEFAULT_STEP_FILES,
    );
    const wideScopes = await mintedScopes(fixture, wide.attemptId);
    assert(wideScopes.includes("files.write"), JSON.stringify(wideScopes));
  }));
