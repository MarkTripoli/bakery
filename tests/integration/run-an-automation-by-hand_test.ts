import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { setUpAutomation } from "../helpers/automation-fixtures.ts";
import { apiCall, expectJson } from "../helpers/fixed-coding-preset.ts";
import { authTestOrigin, signSessionCookie } from "../helpers/auth.ts";

// #36 slice 4b. `automations.run`: an Admin starts the active version now, as
// that version's actor, with the stored inputs overridden key by key; the run
// is returned, or the refusal is, and nothing stays behind. An automation with
// an active run is not started again.

type Run = { id: string; status: string; workflowVersionId: string };

Deno.test("an Admin runs an automation by hand: the run is the pinned version's, the firing is its own, and the audit names the caller", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUpAutomation(fixture);
    const run = (body: unknown = {}, key = crypto.randomUUID()) =>
      apiCall(
        fixture,
        s.scope,
        "POST",
        `/v1/automations/${s.automation.id}/runs`,
        { body, idempotencyKey: key },
      );
    // No active version yet.
    const none = await run();
    assertEquals(none.status, 409);
    await none.body?.cancel();
    assertEquals((await s.counts()).runs, "0");
    // Activate it.
    await expectJson(
      await apiCall(
        fixture,
        s.scope,
        "PATCH",
        `/v1/automations/${s.automation.id}`,
        {
          body: { activeVersionId: s.version.id },
          headers: { "If-Match": '"1"' },
        },
      ),
      200,
    );

    const key = crypto.randomUUID();
    const first = await expectJson<Run>(
      await run({ inputs: { extra: "by hand" } }, key),
      201,
    );
    assertEquals(first.workflowVersionId, s.published.id);
    assertEquals(first.status, "queued");
    // A replay with the same key is the same run, not a second.
    const replay = await expectJson<Run>(
      await run({ inputs: { extra: "by hand" } }, key),
      201,
    );
    assertEquals(replay.id, first.id);
    assertEquals((await s.counts()).runs, "1");

    // The firing is its own, started, and carries the run.
    const firings = (await fixture.pgDatabase.query<
      { status: string; pending: boolean; runId: string }
    >(
      `select f.status, f.pending, f.run_id as "runId"
         from bakery.automation_firings f
         join bakery.automation_versions v
           on v.organization_id = f.organization_id
          and v.id = f.automation_version_id
        where v.automation_id = $1`,
      [s.automation.id],
    )).rows;
    assertEquals(firings, [{
      status: "started",
      pending: false,
      runId: first.id,
    }]);
    // The run's inputs are the stored ones with the request's laid over them.
    const inputs = (await fixture.pgDatabase.query<{ inputs: unknown }>(
      `select snapshot -> 'inputs' as inputs from bakery.workflow_runs where id = $1`,
      [first.id],
    )).rows[0].inputs;
    assertEquals(inputs, {
      brief: "Retry failed uploads twice.",
      extra: "by hand",
    });
    // It runs as the version's actor; the caller is in the audit record.
    const requestedBy = (await fixture.pgDatabase.query<{ id: string }>(
      `select requested_by as id from bakery.workflow_runs where id = $1`,
      [first.id],
    )).rows[0].id;
    assertEquals(requestedBy, s.scope.principalId);
    const audit = (await fixture.pgDatabase.query<
      { principal: string; outcome: string; runId: string }
    >(
      `select principal_id as principal, outcome, details ->> 'runId' as "runId"
         from bakery.audit_events
        where resource_id = $1 and operation = 'automations.run'`,
      [s.automation.id],
    )).rows;
    assertEquals(audit, [{
      principal: s.scope.principalId,
      outcome: "succeeded",
      runId: first.id,
    }]);

    // While that run is active, another is refused, whatever the inputs.
    const second = await run({});
    assertEquals(second.status, 409);
    await second.body?.cancel();
    assertEquals((await s.counts()).runs, "1");
    // Once it is over, the automation can be run again.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'completed' where id = $1`,
      [first.id],
    );
    const third = await expectJson<Run>(await run({}), 201);
    assert(third.id !== first.id);
    assertEquals((await s.counts()).runs, "2");
  }));

Deno.test("two people running at once start one run; a refusal leaves no firing, task or run; a Developer and a stranger are refused", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUpAutomation(fixture);
    await expectJson(
      await apiCall(
        fixture,
        s.scope,
        "PATCH",
        `/v1/automations/${s.automation.id}`,
        {
          body: { activeVersionId: s.version.id },
          headers: { "If-Match": '"1"' },
        },
      ),
      200,
    );
    const path = `/v1/automations/${s.automation.id}/runs`;
    const before = await s.counts();
    const both = await Promise.all([
      apiCall(fixture, s.scope, "POST", path, { body: {} }),
      apiCall(fixture, s.scope, "POST", path, { body: {} }),
    ]);
    assertEquals(both.map((r) => r.status).sort(), [201, 409]);
    for (const response of both) await response.body?.cancel();
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 1);

    // Inputs that are not an object are refused before anything is made.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'completed'
        where organization_id = $1`,
      [s.scope.organizationId],
    );
    const afterOne = await s.counts();
    const bad = await apiCall(fixture, s.scope, "POST", path, {
      body: { inputs: [1, 2] },
    });
    assert(bad.status === 422 || bad.status === 400, String(bad.status));
    await bad.body?.cancel();
    assertEquals(await s.counts(), afterOne);
    const firingCount = async () =>
      Number(
        (await fixture.pgDatabase.query<{ count: string }>(
          `select count(*)::text as count from bakery.automation_firings
          where organization_id = $1`,
          [s.scope.organizationId],
        )).rows[0].count,
      );
    const firingsBefore = await firingCount();

    // Not found, and not another organization's.
    const missing = await apiCall(
      fixture,
      s.scope,
      "POST",
      `/v1/automations/${crypto.randomUUID()}/runs`,
      { body: {} },
    );
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    // A Developer may read automations but not run one.
    const userId = crypto.randomUUID();
    const developerId = crypto.randomUUID();
    const token = `developer-${crypto.randomUUID()}`;
    await fixture.pgDatabase.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'developer', $2, true, now(), now())`,
      [userId, `developer-${userId}@example.test`],
    );
    await fixture.pgDatabase.query(
      `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, now() + interval '1 day', now(), now())`,
      [crypto.randomUUID(), token, userId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, 'developer', 'human')`,
      [developerId, userId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1)`,
      [crypto.randomUUID(), s.scope.organizationId, developerId],
    );
    try {
      const forbidden = await apiCall(fixture, s.scope, "POST", path, {
        body: {},
        cookie: await signSessionCookie(token, fixture.config.auth!.secret),
      });
      assertEquals(forbidden.status, 403);
      await forbidden.body?.cancel();
      assertEquals(await firingCount(), firingsBefore);
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.organization_memberships where principal_id = $1`,
        [developerId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.audit_events where principal_id = $1`,
        [developerId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.principals where id = $1`,
        [developerId],
      );
      await fixture.pgDatabase.query(
        `delete from public.session where "userId" = $1`,
        [userId],
      );
      await fixture.pgDatabase.query(
        `delete from public."user" where id = $1`,
        [
          userId,
        ],
      );
    }
    // Without a session.
    const anonymous = await fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: authTestOrigin,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: "{}",
      }),
    );
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
    assertEquals(await firingCount(), firingsBefore);
  }));

Deno.test("a run the workflow refuses is the caller's error and leaves nothing behind", () =>
  withWorkerFixture(async (fixture) => {
    // A budget of 0 cannot reserve for the workflow's model step.
    const s = await setUpAutomation(fixture, { budgetLimitUsd: "0" });
    await expectJson(
      await apiCall(
        fixture,
        s.scope,
        "PATCH",
        `/v1/automations/${s.automation.id}`,
        {
          body: { activeVersionId: s.version.id },
          headers: { "If-Match": '"1"' },
        },
      ),
      200,
    );
    const before = await s.counts();
    const response = await apiCall(
      fixture,
      s.scope,
      "POST",
      `/v1/automations/${s.automation.id}/runs`,
      { body: {} },
    );
    assertEquals(response.status, 409);
    await response.body?.cancel();
    assertEquals(await s.counts(), before);
    assertEquals(
      Number(
        (await fixture.pgDatabase.query<{ count: string }>(
          `select count(*)::text as count from bakery.automation_firings
          where organization_id = $1`,
          [s.scope.organizationId],
        )).rows[0].count,
      ),
      0,
    );
    // The same call can be made again once the budget is fixed: nothing is stuck.
    assertEquals((await s.counts()).runs, before.runs);
  }));
