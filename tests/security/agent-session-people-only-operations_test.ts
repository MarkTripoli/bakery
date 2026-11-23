/**
 * #448 [AUTH] slice S9c, O51: secrets, consent and grants, and the
 * destructive storage operations stay with people. A real agent session (a
 * worker claim, the session credential it minted, /session-call) asks for
 * each of them and is refused by name: the tool is not offered to a session,
 * and the call answers the typed problem the session routes map that to.
 * Nothing the call asked for is written. The same session credential sent straight
 * to the people's HTTP route as a bearer is not a credential there at all.
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

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

/** The people-only operations an agent asks for, with arguments a person's call would carry. */
function peopleOnly(
  ids: Readonly<{
    workflowId: string;
    folderId: string;
    entryId: string;
    principalId: string;
  }>,
): ReadonlyArray<readonly [string, Json]> {
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const someId = crypto.randomUUID();
  return [
    // Secrets: never read, set, rotated or revoked by an agent.
    ["secrets.list", {}],
    ["secrets.get", { id: someId }],
    ["secrets.create", {
      name: "AGENT_448",
      value: "nope",
      scope: "organization",
    }],
    ["secrets.rotate", { id: someId, value: "nope" }],
    ["secrets.updatePolicy", { id: someId }],
    ["secrets.revoke", { id: someId }],
    // Consent and grants: delegating is a person's act.
    ["integrationGrants.create", { id: someId, principalId: ids.principalId }],
    ["permissionGrants.create", { principalId: ids.principalId }],
    ["agentPowerGrants.create", {
      workflowId: ids.workflowId,
      power: "decide",
    }],
    [
      "definitionPublishGrants.create",
      { workflowId: ids.workflowId },
    ],
    ["mcpUseGrants.create", { id: someId, principalId: ids.principalId }],
    [
      "agentFileGrants.create",
      {
        workflowId: ids.workflowId,
        folderId: ids.folderId,
        access: "write",
        expiresAt: later,
      },
    ],
    ["agentFileGrants.revoke", { id: someId }],
    // Restore from /trash and the Admin purge: destroying stays with people.
    ["storageEntries.restore", { id: ids.entryId }],
    ["storageEntries.purge", { id: ids.entryId }],
  ];
}

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

async function count(fixture: Fixture, table: string): Promise<number> {
  const found = await fixture.pgDatabase.query<{ n: string }>(
    "select count(*)::text as n from bakery." + table +
      " where organization_id = $1",
    [fixture.organizationId],
  );
  return Number(found.rows[0]?.n ?? "0");
}

Deno.test("an agent session asking for secrets, consent, grants, restore or purge is refused by name", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/people-only-448",
      }),
      201,
    );
    const file = await json(
      await asPerson(fixture, "PUT", "/v1/storage/files", {
        path: "/shared/people-only-448/trashed.md",
        mediaType: "text/plain",
        content: btoa("a person's file"),
      }),
      200,
    );
    const trashed = await asPerson(
      fixture,
      "DELETE",
      "/v1/storage/entries/" + file.id,
      undefined,
      file.version as number,
    );
    assert(trashed.status < 300, await trashed.text());

    const worker = await registeredWorker(fixture, {
      name: "agent-448-people-only",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as
      & Awaited<ReturnType<typeof claimAssignment>>
      & { sessionCredential?: string };
    const token = assignment.sessionCredential;
    assert(token, "the claim mints a session credential");

    const tables = [
      "secrets",
      "agent_file_grants",
      "agent_power_grants",
      "definition_publish_grants",
    ];
    const before = await Promise.all(tables.map((t) => count(fixture, t)));

    const cases = peopleOnly({
      workflowId: job.workflowId,
      folderId: folder.id as string,
      entryId: file.id as string,
      principalId: fixture.principalId,
    });
    for (const [tool, args] of cases) {
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool, arguments: args },
        { headers: { "x-session-credential": token } },
      );
      const text = await response.text();
      // Registered but never offered to a session: the gateway's
      // SESSION_TOOL_PEOPLE_ONLY, which the session routes answer as a typed
      // 403 naming why, never a 500 and never the operation's own answer.
      assertEquals(response.status, 403, tool + ": " + text);
      const problem = JSON.parse(text) as Json;
      assertEquals(problem.code, "AUTH_FORBIDDEN", tool);
      assertEquals(problem.reason, "session_operation_people_only", tool);
    }
    // A name no operation has is still unknown: 404, not the named refusal.
    const unknown = await workerRequest(
      fixture,
      worker.credential,
      "/v1/session/call",
      { tool: "secrets.exfiltrate", arguments: {} },
      { headers: { "x-session-credential": token } },
    );
    const unknownText = await unknown.text();
    assertEquals(unknown.status, 404, unknownText);
    assertEquals(
      (JSON.parse(unknownText) as Json).code,
      "RESOURCE_NOT_FOUND",
    );

    // Nothing any call asked for was written, and the file is still trashed.
    assertEquals(
      await Promise.all(tables.map((t) => count(fixture, t))),
      before,
    );
    const entry = await fixture.pgDatabase.query<
      { trashed: boolean; purged: boolean }
    >(
      "select trashed_at is not null as trashed, purged_at is not null as purged" +
        " from bakery.storage_entries where organization_id = $1 and id = $2",
      [fixture.organizationId, file.id],
    );
    assertEquals(entry.rows[0], { trashed: true, purged: false });

    // The same credential is no bearer on the people's routes.
    for (
      const [method, path] of [
        ["GET", "/v1/secrets"],
        ["POST", "/v1/storage/agent-file-grants"],
        ["POST", "/v1/storage/entries/" + file.id + "/restore"],
      ] as const
    ) {
      const response = await fixture.app.fetch(
        new Request(fixture.config.publicBaseUrl + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            "Bakery-Organization-Id": fixture.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      const text = await response.text();
      assert(
        response.status === 401 || response.status === 403,
        method + " " + path + ": " + response.status + " " + text,
      );
    }
  }));
