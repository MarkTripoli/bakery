/**
 * #448 [AUTH]: an agent's file writes through the self-connection, against the
 * section 17.6 default matrix and the grant axes. Every case drives a real
 * session call (worker claim, session credential, /session-call), so the
 * refusal is the one an agent actually receives.
 *
 * - /library is not writable by a file write, even with a grant elsewhere;
 * - /users/<member> is closed, the starter's own folder included;
 * - /trash and /system are unreachable;
 * - a read grant never permits a destructive verb (mv, rm);
 * - a grant that expires or is revoked mid-step stops the very next write;
 * - an agent cannot grant itself (or anyone) a folder.
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
import { bearerCall, mintToken } from "../helpers/access-tokens.ts";

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

Deno.test("an agent writes only under a granted folder, and each closed area refuses by name", () =>
  withWorkerFixture(async (fixture) => {
    const writable = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448",
      }),
      201,
    );
    const readable = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-read",
      }),
      201,
    );
    const theirs = await json(
      await asPerson(fixture, "PUT", "/v1/storage/files", {
        path: "/shared/agent-448-read/keep.md",
        mediaType: "text/plain",
        content: btoa("a person's file"),
      }),
      200,
    );
    const agent = await agentSession(
      fixture,
      "agent-448-matrix",
      async (job) => {
        await grantFolder(
          fixture,
          job.workflowId,
          writable.id as string,
          "write",
        );
        await grantFolder(
          fixture,
          job.workflowId,
          readable.id as string,
          "read",
        );
      },
    );

    // Granted: the write lands.
    const made = await sessionResult(
      await agent.call("storageFiles.put", file("/shared/agent-448/notes.md")),
    );
    assertEquals(made.path, "/shared/agent-448/notes.md");

    // Not granted: /shared is readable to people, closed to the agent.
    assertEquals(
      await refusal(
        await agent.call("storageFiles.put", file("/shared/loose.md")),
      ),
      {
        status: 403,
        code: "AUTH_FORBIDDEN",
        reason: "agent_file_grant_missing",
      },
    );
    // /library: never by file write.
    assertEquals(
      (await refusal(
        await agent.call("storageFiles.put", file("/library/skill.md")),
      )).reason,
      "library_area",
    );
    // /users/<member>: the starter's own folder too.
    assertEquals(
      await refusal(
        await agent.call(
          "storageFiles.put",
          file("/users/" + fixture.principalId + "/uploads/mine.md"),
        ),
      ),
      {
        status: 403,
        code: "AUTH_FORBIDDEN",
        reason: "agent_file_grant_missing",
      },
    );
    // /trash and /system: unreachable.
    for (const path of ["/trash/x.md", "/system/x.md"]) {
      const refused = await refusal(
        await agent.call("storageFiles.put", file(path)),
      );
      assert(refused.status === 409 || refused.status === 403, path);
      assert(
        ["trash_area", "system_area", "agent_file_grant_missing"].includes(
          refused.reason ?? "",
        ),
        path + " " + refused.reason,
      );
    }
    // Path tricks are named refusals at the agent's door.
    for (
      const [path, reason] of [
        ["/shared/agent-448/../loose.md", "path_traversal"],
        ["/shared/agent-448/%2e%2e/loose.md", "path_encoded"],
        ["/Shared/agent-448/x.md", "path_spelling_mismatch"],
        ["/shared/agent-448/x.md/", "path_trailing_slash"],
      ]
    ) {
      assertEquals(
        (await refusal(await agent.call("storageFiles.put", file(path))))
          .reason,
        reason,
        path,
      );
    }

    // Destructive verbs under a read grant: refused, and nothing changed.
    assertEquals(
      (await refusal(
        await agent.call(
          "storageEntries.trash",
          { id: theirs.id },
          theirs.version as number,
        ),
      )).reason,
      "agent_file_grant_read_only",
    );
    assertEquals(
      (await refusal(
        await agent.call(
          "storageEntries.move",
          { id: theirs.id, destinationPath: "/shared/agent-448/keep.md" },
          theirs.version as number,
        ),
      )).reason,
      "agent_file_grant_read_only",
    );
    const still = await fixture.pgDatabase.query<{ trashed_at: Date | null }>(
      "select trashed_at from bakery.storage_entries where id = $1",
      [theirs.id],
    );
    assertEquals(still.rows[0].trashed_at, null);
  }));

Deno.test("a grant that expires or is revoked mid-step stops the very next write", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-lapse",
      }),
      201,
    );
    let grant: Json = {};
    const agent = await agentSession(
      fixture,
      "agent-448-lapse",
      async (job) => {
        grant = await grantFolder(
          fixture,
          job.workflowId,
          folder.id as string,
          "write",
        );
      },
    );
    await sessionResult(
      await agent.call(
        "storageFiles.put",
        file("/shared/agent-448-lapse/1.md"),
      ),
    );
    // Expire it between two writes of the same step: no escalation is held.
    await fixture.pgDatabase.query(
      "update bakery.agent_file_grants set expires_at = now() - interval '1 second' where id = $1",
      [grant.id],
    );
    assertEquals(
      (await refusal(
        await agent.call(
          "storageFiles.put",
          file("/shared/agent-448-lapse/2.md"),
        ),
      )).reason,
      "agent_file_grant_expired",
    );
    // Restore the expiry, then revoke through the person's route.
    await fixture.pgDatabase.query(
      "update bakery.agent_file_grants set expires_at = now() + interval '1 hour' where id = $1",
      [grant.id],
    );
    await json(
      await asPerson(
        fixture,
        "POST",
        "/v1/storage/agent-file-grants/" + grant.id + "/revoke",
        undefined,
        grant.version as number,
      ),
      200,
    );
    assertEquals(
      (await refusal(
        await agent.call(
          "storageFiles.put",
          file("/shared/agent-448-lapse/3.md"),
        ),
      )).reason,
      "agent_file_grant_revoked",
    );
    const written = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*)::text as n from bakery.storage_entries where parent_id = $1",
      [folder.id],
    );
    assertEquals(written.rows[0].n, "1");
  }));

Deno.test("an agent cannot grant itself a folder, and a grant never reaches the library, trash or another member", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-self",
      }),
      201,
    );
    const agent = await agentSession(
      fixture,
      "agent-448-self",
      () => Promise.resolve(),
    );
    // Never offered to a session: the gateway refuses it by name as a
    // person's operation.
    const self = await agent.call("agentFileGrants.create", {
      workflowId: agent.job.workflowId,
      folderId: folder.id,
      access: "write",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const selfText = await self.text();
    assertEquals(self.status, 403, selfText);
    assertEquals(
      (JSON.parse(selfText) as { reason?: string }).reason,
      "session_operation_people_only",
    );
    const rows = await fixture.pgDatabase.query(
      "select 1 from bakery.agent_file_grants where folder_id = $1",
      [folder.id],
    );
    assertEquals(rows.rows.length, 0);

    // A person cannot make a grant an agent could never use.
    const top = await fixture.pgDatabase.query<
      { id: string; system_key: string }
    >(
      "select id, system_key from bakery.storage_entries where organization_id = $1 and parent_id is null and system_key in ('library', 'trash', 'system')",
      [fixture.organizationId],
    );
    for (const row of top.rows) {
      const refused = await refusal(
        await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
          workflowId: agent.job.workflowId,
          folderId: row.id,
          access: "write",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      assertEquals(refused.code, "STORAGE_AREA_REFUSED", row.system_key);
    }
  }));

/** A bearer-token request: an Admin's access token acts as an agent. */
function asToken(
  fixture: Fixture,
  secret: string,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: number,
): Promise<Response> {
  return Promise.resolve(bearerCall(
    fixture as unknown as Parameters<typeof bearerCall>[0],
    method,
    path,
    secret,
    {
      body,
      headers: ifMatch === undefined ? {} : { "If-Match": '"' + ifMatch + '"' },
    },
  ));
}

// The storage routes take browser sessions only, so a token never reaches the
// grant handlers; the handlers' own person check is pinned in
// tests/unit/agent-file-grants-person_test.ts.
Deno.test("an Admin's access token cannot grant or revoke a folder: only a person can", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-token",
      }),
      201,
    );
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const token = await mintToken(
      fixture as unknown as Parameters<typeof mintToken>[0],
      undefined,
      ["bakery:admin"],
      "agent-448 admin token",
    );
    const request = {
      workflowId: job.workflowId,
      folderId: folder.id,
      access: "write",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    assertEquals(
      await refusal(
        await asToken(
          fixture,
          token.secret,
          "POST",
          "/v1/storage/agent-file-grants",
          request,
        ),
      ),
      { status: 401, code: "AUTH_INVALID", reason: undefined },
    );
    const none = await fixture.pgDatabase.query(
      "select 1 from bakery.agent_file_grants where folder_id = $1",
      [folder.id],
    );
    assertEquals(none.rows.length, 0);

    // The same Admin, acting as a person, grants; the token cannot revoke it.
    const grant = await json(
      await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", request),
      201,
    );
    assertEquals(
      await refusal(
        await asToken(
          fixture,
          token.secret,
          "POST",
          "/v1/storage/agent-file-grants/" + grant.id + "/revoke",
          undefined,
          grant.version as number,
        ),
      ),
      { status: 401, code: "AUTH_INVALID", reason: undefined },
    );
    const kept = await fixture.pgDatabase.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from bakery.agent_file_grants where id = $1",
      [grant.id],
    );
    assertEquals(kept.rows[0].revoked, false);
  }));
