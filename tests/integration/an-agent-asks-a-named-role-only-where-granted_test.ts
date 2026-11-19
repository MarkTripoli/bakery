import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { agentSession } from "../helpers/agent-session.ts";

// #414 slice 4: an agent step puts a free-text question to one named role, only
// where a person granted the ask power for exactly that role to its workflow.
// The question opens like any other, addressed to the role's active members, and
// is recorded as an agent's action. Driven through the real app and the session
// gateway.

type Asked = {
  id: string;
  kind: string;
  runId: string | null;
  prompt: string;
  audience: { type: string; principalIds?: string[] };
  status: string;
};

const ask = (
  session: Awaited<ReturnType<typeof agentSession>>,
  roleKey: string,
) =>
  session.call("questions.ask", {
    prompt: "Which environment should this ship to?",
    roleKey,
  });

Deno.test("an agent asks the granted role, reaching its members, labelled as an agent's action", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, {
      granted: "ask",
      roleKey: "admin",
    });
    assert((await session.tools()).includes("questions.ask"));
    const response = await ask(session, "admin");
    const text = await response.text();
    assertEquals(response.status, 200, text);
    const asked = (JSON.parse(text) as { result: Asked }).result;
    assertEquals(asked.kind, "question");
    assertEquals(asked.status, "open");
    // Raised on the agent's own run, addressed to the role's active members.
    assertEquals(asked.runId, session.own.runId);
    assertEquals(asked.audience.type, "principals");
    assert(
      asked.audience.principalIds?.includes(fixture.principalId),
      "the admin who holds the role is in the audience",
    );

    const audit = await fixture.pgDatabase.query<{
      details: { actorKind?: string; roleKey?: string; fromRunId?: string };
    }>(
      `select details from bakery.audit_events
        where organization_id = $1 and operation = 'questions.ask'
          and resource_id = $2`,
      [fixture.organizationId, asked.id],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].details.actorKind, "agent");
    assertEquals(audit.rows[0].details.roleKey, "admin");
    assertEquals(audit.rows[0].details.fromRunId, session.own.runId);
  }));

Deno.test("a grant for one role does not reach another", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, {
      granted: "ask",
      roleKey: "admin",
    });
    const response = await ask(session, "developer");
    assertEquals(response.status, 403, await response.text());
    const rows = await fixture.pgDatabase.query(
      `select 1 from bakery.questions where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(rows.rows.length, 0);
  }));

Deno.test("without a grant asking is not offered and not allowed", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: null });
    assert(!(await session.tools()).includes("questions.ask"));
    const response = await ask(session, "admin");
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("another power does not let an agent ask", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "decide" });
    assert(!(await session.tools()).includes("questions.ask"));
    const response = await ask(session, "admin");
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("a role nobody holds opens no question", () =>
  withWorkerFixture(async (fixture) => {
    // The fixture has an admin and no developer, so the grant is valid but the
    // question would reach no one.
    const session = await agentSession(fixture, {
      granted: "ask",
      roleKey: "developer",
    });
    const response = await ask(session, "developer");
    assertEquals(response.status, 422, await response.text());
    const rows = await fixture.pgDatabase.query(
      `select 1 from bakery.questions where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(rows.rows.length, 0);
  }));

Deno.test("a revoked ask grant stops the next question", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, {
      granted: "ask",
      roleKey: "admin",
    });
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [session.grantId],
    );
    const response = await ask(session, "admin");
    assertEquals(response.status, 403, await response.text());
  }));
