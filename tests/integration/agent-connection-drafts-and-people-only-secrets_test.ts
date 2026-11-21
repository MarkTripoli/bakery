/**
 * #448 S9b and S9c: an agent prepares a connection and a person completes it,
 * and secrets and consent stay with a signed-in person (chapter 25, O51).
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

/** The named reason of a refusal, from the problem body. */
async function reason(response: Response): Promise<string | undefined> {
  const body = JSON.parse(await response.text()) as {
    issues?: { code?: string }[];
  };
  return body.issues?.[0]?.code;
}

Deno.test("an agent drafts a personal connection with no secret, a person completes it, and nothing else is allowed", () =>
  withWorkerFixture(async (fixture) => {
    const agent = await agentSession(
      fixture,
      "agent-448-s9b",
      async (job) => {
        await json(
          await asPerson(fixture, "POST", "/v1/agent-power-grants", {
            power: "draft_connection",
            workflowId: job.workflowId,
          }),
          201,
        );
      },
    );
    const server = await json(
      await asPerson(fixture, "POST", "/v1/mcp-servers", {
        slug: "s-" + crypto.randomUUID().slice(0, 8),
        name: "Docs",
        transport: "streamable_http",
        endpointTemplate: "https://mcp.example.com/mcp",
        configSchema: { type: "object" },
        requiredCapabilities: [],
        sourceRevision: "v1",
      }),
      201,
    );
    await json(
      await asPerson(
        fixture,
        "PATCH",
        "/v1/mcp-servers/" + server.id,
        { enabled: true },
        1,
      ),
      200,
    );
    const draftInput = {
      serverId: server.id,
      label: "Docs for the agent",
      config: {},
      enabledCapabilities: [],
      scope: "personal",
    };

    // The draft: personal, off, no credential.
    const drafted = await sessionResult(
      await agent.call("mcpConnections.create", draftInput),
    );
    assertEquals(drafted.status, "disabled");
    assertEquals(drafted.ownerPrincipalId, fixture.principalId);
    assertEquals(drafted.secretId, null);
    const stored = (await fixture.pgDatabase.query<
      { secret_id: string | null; status: string; owner_principal_id: string }
    >(
      "select secret_id, status, owner_principal_id from bakery.mcp_connections where id = $1",
      [drafted.id],
    )).rows[0]!;
    assertEquals(stored.secret_id, null);
    assertEquals(stored.status, "disabled");
    assertEquals(stored.owner_principal_id, fixture.principalId);

    // What an agent may not do, each with its own named reason.
    const withSecret = await agent.call("mcpConnections.create", {
      ...draftInput,
      secret: "sk-never-in-context",
    });
    assertEquals(withSecret.status, 422);
    assertEquals(
      await reason(withSecret),
      "agent_connection_secret_stays_with_people",
    );
    const organizationWide = await agent.call("mcpConnections.create", {
      ...draftInput,
      scope: "organization",
    });
    assertEquals(organizationWide.status, 422);
    assertEquals(
      await reason(organizationWide),
      "agent_connection_draft_is_personal",
    );
    const enable = await agent.call(
      "mcpConnections.update",
      { id: drafted.id, status: "enabled" },
      Number(drafted.version),
    );
    assertEquals(enable.status, 422);
    assertEquals(
      await reason(enable),
      "agent_connection_enable_stays_with_people",
    );
    const rows = await fixture.pgDatabase.query<{ n: number }>(
      "select count(*)::int as n from bakery.mcp_connections where organization_id = $1",
      [fixture.organizationId],
    );
    assertEquals(rows.rows[0]!.n, 1, "the refused drafts wrote nothing");

    // The agent may rename its own draft, but it cannot revoke it.
    const renamed = await sessionResult(
      await agent.call(
        "mcpConnections.update",
        { id: drafted.id, label: "Renamed draft" },
        Number(drafted.version),
      ),
    );
    assertEquals(renamed.label, "Renamed draft");
    const revoke = await agent.call(
      "mcpConnections.update",
      { id: drafted.id, status: "revoked" },
      Number(renamed.version),
    );
    assertEquals(revoke.status, 422);
    assertEquals(await reason(revoke), "agent_connection_edits_only_its_draft");

    // The person completes it: switching it on is theirs.
    const enabled = await json(
      await asPerson(
        fixture,
        "PATCH",
        "/v1/mcp-connections/" + drafted.id,
        { status: "enabled" },
        Number(renamed.version),
      ),
      200,
    );
    assertEquals(enabled.status, "enabled");

    // Once it is live the agent cannot change it, though its person can.
    const live = await agent.call(
      "mcpConnections.update",
      {
        id: drafted.id,
        label: "changed on a live connection",
        enabledCapabilities: [],
      },
      Number(enabled.version),
    );
    assertEquals(live.status, 422);
    assertEquals(await reason(live), "agent_connection_edits_only_its_draft");

    // Nor an organization connection, though the person is an admin and may.
    const organization = await json(
      await asPerson(fixture, "POST", "/v1/mcp-connections", {
        ...draftInput,
        label: "Organization docs",
        scope: "organization",
      }),
      201,
    );
    const shared = await agent.call(
      "mcpConnections.update",
      { id: organization.id, label: "changed by an agent" },
      Number(organization.version),
    );
    assertEquals(shared.status, 422);
    assertEquals(await reason(shared), "agent_connection_edits_only_its_draft");
    const unchanged = (await fixture.pgDatabase.query<
      { label: string; status: string }
    >(
      "select label, status from bakery.mcp_connections where id = any($1::uuid[]) order by label",
      [[drafted.id, organization.id]],
    )).rows;
    assertEquals(unchanged, [
      { label: "Organization docs", status: "enabled" },
      { label: "Renamed draft", status: "enabled" },
    ]);
  }));

Deno.test("a session without the draft power cannot create a connection, and secrets and consent are not session tools", () =>
  withWorkerFixture(async (fixture) => {
    const agent = await agentSession(fixture, "agent-448-s9c", async () => {});
    const refused = await agent.call("mcpConnections.create", {
      serverId: crypto.randomUUID(),
      label: "x",
      config: {},
      enabledCapabilities: [],
      scope: "personal",
    });
    assertEquals(refused.status, 403, await refused.clone().text());
    // The secret and consent operations are not mapped for sessions at all.
    for (
      const tool of [
        "secrets.create",
        "secrets.rotate",
        "secrets.revoke",
        "mcpUseGrants.create",
      ]
    ) {
      const response = await agent.call(tool, {});
      assert(
        [403, 404].includes(response.status),
        tool + " is not offered: " + response.status,
      );
      await response.body?.cancel();
    }
    assertEquals(
      (await fixture.pgDatabase.query<{ n: number }>(
        "select count(*)::int as n from bakery.mcp_connections where organization_id = $1",
        [fixture.organizationId],
      )).rows[0]!.n,
      0,
    );
  }));
