import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture as withBaseFixture } from "../helpers/worker-execution/scenarios.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { adminRequest } from "../helpers/worker-execution.ts";
import {
  type AgentFixture,
  agentSession,
  grantPower,
  seedOtherRun,
} from "../helpers/agent-session.ts";

// #414 slice 4: a step's agent asks a named role or group through run requests,
// only where a person granted its workflow the ask power naming that role or
// group. The members are resolved when the request is made and frozen. Driven
// through the real app and the session gateway, on real Postgres.

/** The sign-in emails of members a test added, removed when it ends. */
const added: string[] = [];

/**
 * The worker fixture, with the members a test added removed afterwards: a
 * person left behind would make the next fixture's first-admin bootstrap
 * conflict.
 */
const withWorkerFixture = (work: (fixture: AgentFixture) => Promise<void>) =>
  withBaseFixture(async (fixture) => {
    try {
      await work(fixture);
    } finally {
      await cleanupAuthFixture(fixture.pgDatabase, added.splice(0));
    }
  });

/** An active human member of the fixture's organization with a role. */
async function addMember(
  fixture: AgentFixture,
  name: string,
  role: "admin" | "developer" | "guest",
): Promise<string> {
  const id = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into public."user"
       (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [userId, name, `${name}-${userId}@example.test`],
  );
  added.push(`${name}-${userId}@example.test`);
  await fixture.pgDatabase.query(
    `insert into bakery.principals
       (id, provider_user_id, display_name, principal_type)
     values ($1, $2, $3, 'human')`,
    [id, userId, name],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, $4, 'active', now(), now(), now(), 1)`,
    [crypto.randomUUID(), fixture.organizationId, id, role],
  );
  return id;
}

async function requestsOn(fixture: AgentFixture, runId: string) {
  return (await fixture.pgDatabase.query<{
    recipient_id: string;
    asked_by_kind: string;
    audience_role_key: string | null;
    audience_group_id: string | null;
    audience_name: string | null;
  }>(
    `select recipient_id, asked_by_kind, audience_role_key, audience_group_id,
            audience_name
       from bakery.person_requests
      where organization_id = $1 and run_id = $2
      order by recipient_id`,
    [fixture.organizationId, runId],
  )).rows;
}

async function refusedWith(response: Response, status: number, reason: string) {
  const text = await response.text();
  assertEquals(response.status, status, text);
  assert(text.includes(reason), `expected ${reason} in ${text}`);
}

const ask = (
  session: Awaited<ReturnType<typeof agentSession>>,
  args: Record<string, unknown>,
) =>
  session.call("runRequests.create", {
    id: session.own.runId,
    intent: "fyi",
    ...args,
  });

Deno.test("an agent asks the role its grant names: every member, frozen at ask time", () =>
  withWorkerFixture(async (fixture) => {
    const dana = await addMember(fixture, "Dana", "developer");
    const devon = await addMember(fixture, "Devon", "developer");
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "developer" },
    });
    assert((await session.tools()).includes("runRequests.create"));
    const response = await ask(session, {
      recipientRoleKey: "developer",
      note: "Which branch should this build?",
    });
    assert(response.ok, await response.text());
    const asked = await requestsOn(fixture, session.own.runId);
    assertEquals(
      asked.map((row) => row.recipient_id).sort(),
      [dana, devon].sort(),
    );
    for (const row of asked) {
      assertEquals(row.asked_by_kind, "agent");
      assertEquals(row.audience_role_key, "developer");
      assertEquals(row.audience_name, "Developers");
    }

    // Frozen: a developer added later is not asked, and one who left the role
    // keeps the request they were given.
    const late = await addMember(fixture, "Lee", "developer");
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'guest'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, dana],
    );
    const after = await requestsOn(fixture, session.own.runId);
    assertEquals(
      after.map((row) => row.recipient_id).sort(),
      [dana, devon].sort(),
    );
    assert(!after.some((row) => row.recipient_id === late));
  }));

Deno.test("an agent asks a group its grant names", () =>
  withWorkerFixture(async (fixture) => {
    const gus = await addMember(fixture, "Gus", "guest");
    const groupId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_groups
         (id, organization_id, name, mention_name)
       values ($1, $2, 'Release owners', 'release-owners')`,
      [groupId, fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id)
       values ($1, $2, $3)`,
      [fixture.organizationId, groupId, gus],
    );
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { groupId },
    });
    const response = await ask(session, { recipientGroupId: groupId });
    assert(response.ok, await response.text());
    const asked = await requestsOn(fixture, session.own.runId);
    assertEquals(asked.map((row) => row.recipient_id), [gus]);
    assertEquals(asked[0].audience_group_id, groupId);
    assertEquals(asked[0].audience_name, "Release owners");
  }));

Deno.test("an ask reaches at most 50 people: one more is refused and nobody is asked", () =>
  withWorkerFixture(async (fixture) => {
    const groupId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_groups
         (id, organization_id, name, mention_name)
       values ($1, $2, 'Everyone', 'everyone')`,
      [groupId, fixture.organizationId],
    );
    const members: string[] = [];
    for (let index = 0; index < 51; index++) {
      const id = await addMember(fixture, `Member${index}`, "guest");
      await fixture.pgDatabase.query(
        `insert into bakery.organization_group_members
           (organization_id, group_id, principal_id)
         values ($1, $2, $3)`,
        [fixture.organizationId, groupId, id],
      );
      members.push(id);
    }
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { groupId },
    });
    await refusedWith(
      await ask(session, { recipientGroupId: groupId }),
      409,
      "request_audience_too_large",
    );
    assertEquals(await requestsOn(fixture, session.own.runId), []);

    await fixture.pgDatabase.query(
      `delete from bakery.organization_group_members
        where organization_id = $1 and group_id = $2 and principal_id = $3`,
      [fixture.organizationId, groupId, members[50]],
    );
    const response = await ask(session, { recipientGroupId: groupId });
    assert(response.ok, await response.text());
    assertEquals((await requestsOn(fixture, session.own.runId)).length, 50);
  }));

Deno.test("without an ask grant an agent cannot ask a role, though the tool is offered", () =>
  withWorkerFixture(async (fixture) => {
    await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, { granted: null });
    assert((await session.tools()).includes("runRequests.create"));
    const response = await ask(session, { recipientRoleKey: "developer" });
    assertEquals(response.status, 403, await response.text());
    assertEquals((await requestsOn(fixture, session.own.runId)).length, 0);
  }));

Deno.test("an ask grant reaches only the role it names, and its members one by one", () =>
  withWorkerFixture(async (fixture) => {
    const dana = await addMember(fixture, "Dana", "developer");
    await addMember(fixture, "Ada", "admin");
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "developer" },
    });
    await refusedWith(
      await ask(session, { recipientRoleKey: "admin" }),
      403,
      "agent_ask_audience_not_granted",
    );
    const one = await ask(session, { recipientId: dana });
    assert(one.ok, await one.text());
    assertEquals(
      (await requestsOn(fixture, session.own.runId)).map((row) =>
        row.recipient_id
      ),
      [dana],
    );
  }));

Deno.test("an agent asks only on its own run", () =>
  withWorkerFixture(async (fixture) => {
    await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "developer" },
    });
    const other = await seedOtherRun(fixture);
    await refusedWith(
      await session.call("runRequests.create", {
        id: other.runId,
        intent: "fyi",
        recipientRoleKey: "developer",
      }),
      403,
      "agent_ask_own_run_only",
    );
    assertEquals((await requestsOn(fixture, other.runId)).length, 0);
  }));

Deno.test("an agent cannot ask the person it acts for: a role only they hold is refused", () =>
  withWorkerFixture(async (fixture) => {
    // The fixture's person is the organization's only admin, and the session
    // acts for them.
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "admin" },
    });
    await refusedWith(
      await ask(session, { recipientRoleKey: "admin" }),
      422,
      "request_self",
    );
    assertEquals((await requestsOn(fixture, session.own.runId)).length, 0);
  }));

Deno.test("an expired ask grant stops the next ask, and is never offered at claim", () =>
  withWorkerFixture(async (fixture) => {
    await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "developer" },
    });
    // Live at claim, so the tool was offered; lapsed before the call.
    await fixture.pgDatabase.query(
      `update bakery.agent_power_grants
          set expires_at = now() - interval '1 second'
        where id = $1`,
      [session.grantId],
    );
    await refusedWith(
      await ask(session, { recipientRoleKey: "developer" }),
      403,
      "agent_power_grant_expired",
    );
    assertEquals((await requestsOn(fixture, session.own.runId)).length, 0);
  }));

Deno.test("an expired grant is not offered at claim", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, {
      granted: "run_control",
      grant: { expiresAt: new Date(Date.now() - 60_000) },
    });
    assert(!(await session.tools()).includes("runs.control"));
  }));

Deno.test("an expired run_control grant stops the next control; a future expiry does not", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, {
      granted: "run_control",
      grant: { expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const target = await seedOtherRun(fixture);
    await grantPower(fixture, target.workflowId, "run_control");
    const first = await seedOtherRun(fixture);
    await grantPower(fixture, first.workflowId, "run_control");
    const allowed = await session.call("runs.control", {
      id: first.runId,
      action: "cancel",
    });
    assertEquals(allowed.status, 200, await allowed.text());
    await fixture.pgDatabase.query(
      `update bakery.agent_power_grants
          set expires_at = now() - interval '1 second'
        where id = $1`,
      [session.grantId],
    );
    await refusedWith(
      await session.call("runs.control", {
        id: target.runId,
        action: "cancel",
      }),
      403,
      "agent_power_grant_expired",
    );
    const status = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.workflow_runs where id = $1`,
      [target.runId],
    );
    assert(status.rows[0].status !== "canceled");
  }));

Deno.test("an agent's request rows have the same shape as a person's", () =>
  withWorkerFixture(async (fixture) => {
    await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, {
      granted: "ask",
      grant: { roleKey: "developer" },
    });
    const byAgent = await ask(session, { recipientRoleKey: "developer" });
    assert(byAgent.ok, await byAgent.text());
    const other = await seedOtherRun(fixture);
    const byPerson = await adminRequest(
      fixture,
      `/v1/runs/${other.runId}/requests`,
      { recipientRoleKey: "developer", intent: "fyi" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(byPerson.status, 201, await byPerson.text());

    const ledgerRow = async (runId: string) =>
      (await fixture.pgDatabase.query<Record<string, unknown>>(
        `select * from bakery.decisions_ledger
          where organization_id = $1 and run_id = $2 and kind = 'request'`,
        [fixture.organizationId, runId],
      )).rows;
    const auditRow = async (runId: string) =>
      (await fixture.pgDatabase.query<Record<string, unknown>>(
        `select * from bakery.audit_events
          where organization_id = $1 and operation = 'runRequests.create'
            and details->>'runId' = $2`,
        [fixture.organizationId, runId],
      )).rows;
    // The actor fields are the only ones allowed to differ in value; every
    // other column and detail key is populated, or null, alike.
    const actorFields = new Set([
      "actorKind",
      "onBehalfOf",
      "sessionId",
      "fromRunId",
      "agent_session_id",
    ]);
    const shape = (row: Record<string, unknown>) => {
      const detail = (row.detail ?? row.details) as Record<string, unknown>;
      return {
        columns: Object.keys(row).sort().map((key) =>
          `${key}:${actorFields.has(key) || row[key] !== null}`
        ),
        detail: Object.keys(detail).sort().map((key) =>
          `${key}:${actorFields.has(key) || detail[key] !== null}`
        ),
      };
    };
    const [agentLedger] = await ledgerRow(session.own.runId);
    const [personLedger] = await ledgerRow(other.runId);
    assertEquals(shape(agentLedger), shape(personLedger));
    const [agentAudit] = await auditRow(session.own.runId);
    const [personAudit] = await auditRow(other.runId);
    assertEquals(shape(agentAudit), shape(personAudit));
    // And the one field that says who acted does differ.
    const kind = (row: Record<string, unknown>) =>
      ((row.detail ?? row.details) as { actorKind: string }).actorKind;
    assertEquals([kind(agentLedger), kind(personLedger)], ["agent", "person"]);
    assertEquals([kind(agentAudit), kind(personAudit)], ["agent", "person"]);
    assertEquals(
      (agentAudit.details as { onBehalfOf: string }).onBehalfOf,
      fixture.principalId,
    );
  }));

Deno.test("two controls racing for a run's last transition: exactly one wins", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    // Three rounds: a last-slot race is the class that passes once by luck.
    for (let round = 0; round < 3; round++) {
      const target = await seedOtherRun(fixture);
      await grantPower(fixture, target.workflowId, "run_control");
      const [byAgent, byPerson] = await Promise.all([
        session.call("runs.control", { id: target.runId, action: "cancel" }),
        adminRequest(
          fixture,
          `/v1/runs/${target.runId}/controls`,
          { action: "cancel" },
          { idempotencyKey: crypto.randomUUID() },
        ),
      ]);
      const texts = [await byAgent.text(), await byPerson.text()];
      const won = [byAgent, byPerson].filter((response) => response.ok);
      const lost = [byAgent, byPerson].filter((response) => !response.ok);
      assertEquals([won.length, lost.length], [1, 1], texts.join("\n"));
      assertEquals(lost[0].status, 409, texts.join("\n"));
      assert(
        texts.some((text) =>
          text.includes("already-terminal") ||
          text.includes("ALREADY_TERMINAL")
        ),
        texts.join("\n"),
      );
      const events = await fixture.pgDatabase.query(
        `select 1 from bakery.domain_events
          where organization_id = $1 and aggregate_id = $2
            and event_type = 'run.control_requested'`,
        [fixture.organizationId, target.runId],
      );
      assertEquals(events.rows.length, 1);
    }
  }));

async function involve(fixture: AgentFixture, runId: string, person: string) {
  await fixture.pgDatabase.query(
    `insert into bakery.person_requests (
       organization_id, run_id, task_id, intent, recipient_id, asked_by,
       asked_by_kind, status, expires_at)
     select run.organization_id, run.id, run.task_id, 'fyi', $3, $4, 'person',
            'responded', now() + interval '7 days'
       from bakery.workflow_runs as run
      where run.organization_id = $1 and run.id = $2`,
    [fixture.organizationId, runId, person, fixture.principalId],
  );
}

async function agentAsks(fixture: AgentFixture, runId: string) {
  return (await fixture.pgDatabase.query<
    { recipient_id: string; asked_by_session_id: string | null }
  >(
    `select recipient_id, asked_by_session_id from bakery.person_requests
      where organization_id = $1 and run_id = $2 and asked_by_kind = 'agent'
      order by created_at`,
    [fixture.organizationId, runId],
  )).rows;
}

Deno.test("without a grant an agent asks a person already involved in its run, recorded as the agent's", () =>
  withWorkerFixture(async (fixture) => {
    const dana = await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, { granted: null });
    await involve(fixture, session.own.runId, dana);
    const response = await ask(session, { recipientId: dana });
    assert(response.ok, await response.text());
    const asked = await agentAsks(fixture, session.own.runId);
    assertEquals(asked.map((row) => row.recipient_id), [dana]);
    assert(asked[0]!.asked_by_session_id !== null);
  }));

Deno.test("without a grant an agent cannot bring in someone new", () =>
  withWorkerFixture(async (fixture) => {
    const ava = await addMember(fixture, "Ava", "developer");
    const session = await agentSession(fixture, { granted: null });
    await refusedWith(
      await ask(session, { recipientId: ava }),
      403,
      "agent_ask_not_involved",
    );
    assertEquals(await agentAsks(fixture, session.own.runId), []);
  }));

Deno.test("without a grant an agent cannot hand someone a power they do not already hold", () =>
  withWorkerFixture(async (fixture) => {
    const gus = await addMember(fixture, "Gus", "guest");
    const session = await agentSession(fixture, { granted: null });
    await involve(fixture, session.own.runId, gus);
    const step = await fixture.pgDatabase.query<{ step_key: string }>(
      `select step_key from bakery.run_steps
        where organization_id = $1 and run_id = $2
          and status in ('pending', 'running', 'waiting')
        order by iteration desc limit 1`,
      [fixture.organizationId, session.own.runId],
    );
    await refusedWith(
      await ask(session, {
        recipientId: gus,
        intent: "take_over",
        stepKey: step.rows[0]!.step_key,
      }),
      403,
      "agent_ask_power_not_held",
    );
    assertEquals(await agentAsks(fixture, session.own.runId), []);
  }));

Deno.test("an agent tags at most three people from one step", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: null });
    const people: string[] = [];
    for (const name of ["Ann", "Ben", "Cy", "Dee"]) {
      const id = await addMember(fixture, name, "developer");
      await involve(fixture, session.own.runId, id);
      people.push(id);
    }
    for (const person of people.slice(0, 3)) {
      const response = await ask(session, { recipientId: person });
      assert(response.ok, await response.text());
    }
    await refusedWith(
      await ask(session, { recipientId: people[3] }),
      409,
      "agent_ask_step_limit",
    );
    const again = await ask(session, { recipientId: people[0] });
    assert(again.ok, await again.text());
    assertEquals((await agentAsks(fixture, session.own.runId)).length, 3);
  }));

Deno.test("an agent tags at most ten people on one run", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: null });
    const earlier: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      earlier.push(await addMember(fixture, `Earlier${index}`, "developer"));
    }
    await fixture.pgDatabase.query(
      `insert into bakery.person_requests (
         organization_id, run_id, task_id, intent, recipient_id, asked_by,
         asked_by_kind, status, expires_at)
       select run.organization_id, run.id, run.task_id, 'fyi', person, $3,
              'agent', 'responded', now() + interval '7 days'
         from bakery.workflow_runs as run, unnest($4::uuid[]) as person
        where run.organization_id = $1 and run.id = $2`,
      [fixture.organizationId, session.own.runId, fixture.principalId, earlier],
    );
    const next = await addMember(fixture, "Next", "developer");
    await involve(fixture, session.own.runId, next);
    await refusedWith(
      await ask(session, { recipientId: next }),
      409,
      "agent_ask_run_limit",
    );
  }));

Deno.test("an agent may remind someone of a power a person already granted them", () =>
  withWorkerFixture(async (fixture) => {
    const gus = await addMember(fixture, "Gus", "guest");
    const session = await agentSession(fixture, { granted: null });
    const step = await fixture.pgDatabase.query<{ step_key: string }>(
      `select step_key from bakery.run_steps
        where organization_id = $1 and run_id = $2
          and status in ('pending', 'running', 'waiting')
        order by iteration desc limit 1`,
      [fixture.organizationId, session.own.runId],
    );
    const granted = await adminRequest(
      fixture,
      `/v1/runs/${session.own.runId}/requests`,
      {
        recipientId: gus,
        intent: "take_over",
        stepKey: step.rows[0]!.step_key,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assert(granted.ok, await granted.text());
    const response = await ask(session, {
      recipientId: gus,
      intent: "take_over",
      stepKey: step.rows[0]!.step_key,
    });
    assert(response.ok, await response.text());
  }));

Deno.test("an agent's ask waits for another ask on the same run to finish counting", () =>
  withWorkerFixture(async (fixture) => {
    const dana = await addMember(fixture, "Dana", "developer");
    const session = await agentSession(fixture, { granted: null });
    await involve(fixture, session.own.runId, dana);
    const holder = await fixture.pgDatabase.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`agent-ask:${session.own.runId}`],
      );
      let settled = false;
      const pending = ask(session, { recipientId: dana }).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertEquals(settled, false);
      await holder.query("commit");
      const response = await pending;
      assert(response.ok, await response.text());
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  }));
