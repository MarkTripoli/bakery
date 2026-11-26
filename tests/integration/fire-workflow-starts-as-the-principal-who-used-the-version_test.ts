import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  fireLiveStart,
  fireStartsFor,
  START_FIRINGS_PER_HOUR,
} from "../../apps/server/src/modules/workflows/start-firing.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  automationVersionInputs,
  setUpAutomation,
} from "../helpers/automation-fixtures.ts";
import {
  apiCall,
  expectJson,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import { fireDueScheduleStarts } from "../../apps/server/src/modules/workflows/start-clock.ts";

// #406 slice 3. A start answers an event by starting a run of the version in
// use, as the principal who used that version. That principal is not trusted
// from the day they acted: every firing re-reads their membership and
// permissions when it fires, and one who has lost access fails the firing,
// visibly, with no task or run. A firing is one per version, start and event.

const EVENT = {
  kind: "change_request.opened",
  fields: { number: 3 },
} as const;

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A published workflow version carrying one start, used by the fixture's admin. */
async function setUp(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  start: Record<string, unknown> = {},
) {
  const s = await setUpAutomation(fixture);
  const organizationId = fixture.organizationId;
  const { rows } = await fixture.pgDatabase.query<{ workflow_id: string }>(
    `select workflow_id from bakery.workflow_versions where id = $1`,
    [s.published.id],
  );
  const workflowId = rows[0].workflow_id;
  // Starts are authored on a draft; the fixture published without any, so the
  // published version is given its list as the publish path would have stored it.
  await fixture.pgDatabase.query(
    `update bakery.workflow_versions set starts = $1::jsonb
      where organization_id = $2 and id = $3`,
    [
      JSON.stringify([{
        id: "on-pr",
        budgetUsd: 5,
        // What the fixture's workflow requires of every run.
        inputs: automationVersionInputs(s.repository.repositoryId),
        on: { kind: "event", eventKind: "change_request.opened", filter: {} },
        ...start,
      }]),
      organizationId,
      s.published.id,
    ],
  );
  const definition = await expectJson<{ version: number }>(
    await apiCall(fixture, fixture, "GET", `/v1/workflows/${workflowId}`),
    200,
  );
  await expectJson(
    await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/workflows/${workflowId}/activations`,
      {
        body: { versionId: s.published.id },
        headers: { "If-Match": `"${definition.version}"` },
      },
    ),
    200,
  );
  const receive = async (): Promise<string> => {
    const id = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.inbound_events (
         id, provider, registration_id, external_delivery_id, payload_digest,
         event_kind, event_action, status, expires_at
       ) values ($1, 'provider_neutral', null, $2, 'digest', 'pull_request',
         'opened', 'accepted', now() + interval '1 day')`,
      [id, crypto.randomUUID()],
    );
    return id;
  };
  // As the consumer runs: the application role, in one transaction.
  const fire = async (inboundEventId: string) =>
    await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        fireStartsFor(
          transaction,
          { organizationId, inboundEventId },
          { id: s.repository.repositoryId },
          EVENT,
        ),
    );
  const firings = async () =>
    (await fixture.pgDatabase.query<{
      status: string;
      failureCode: string | null;
      runId: string | null;
      actorId: string | null;
      triggerEventId: string | null;
    }>(
      `select status, failure_code as "failureCode", run_id as "runId",
              actor_id as "actorId", trigger_event_id as "triggerEventId"
         from bakery.workflow_start_firings
        where organization_id = $1 order by created_at, id`,
      [organizationId],
    )).rows;
  const audits = async () =>
    (await fixture.pgDatabase.query<{ outcome: string; code: string | null }>(
      `select outcome, details ->> 'code' as code from bakery.audit_events
        where organization_id = $1 and operation = 'workflowStartFirings.start'
        order by created_at, id`,
      [organizationId],
    )).rows;
  return { ...s, workflowId, receive, fire, firings, audits };
}

/** A member of the organization with this role, who is not the fixture's admin. */
async function addMember(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  role: "admin" | "developer",
): Promise<string> {
  const principalId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, null, 'Start activator', 'service')`,
    [principalId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships
       (id, organization_id, principal_id, role, status, joined_at, created_at,
        updated_at, version)
     values ($1, $2, $3, $4, 'active', now(), now(), now(), 1)`,
    [crypto.randomUUID(), fixture.organizationId, principalId, role],
  );
  return principalId;
}

const activatedBy = (
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  s: Setup,
  principalId: string | null,
) =>
  fixture.pgDatabase.query(
    `update bakery.workflow_definitions set active_version_set_by = $3
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, s.workflowId, principalId],
  );

Deno.test("a live start runs the version in use as the principal who used it, once per event", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    // Using the version recorded who used it.
    const recorded = await fixture.pgDatabase.query<{ by: string }>(
      `select active_version_set_by as by from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, s.workflowId],
    );
    assertEquals(recorded.rows[0].by, fixture.principalId);

    const before = await s.counts();
    const eventId = await s.receive();
    const [outcome] = await s.fire(eventId);
    assertEquals(outcome.result, "started", JSON.stringify(outcome));
    assertEquals(outcome.startId, "on-pr");
    assertEquals(outcome.versionId, s.published.id);

    const [firing] = await s.firings();
    assertEquals(firing.status, "started");
    assertEquals(firing.failureCode, null);
    assertEquals(firing.actorId, fixture.principalId);
    assertEquals(firing.triggerEventId, eventId);
    const after = await s.counts();
    assertEquals(Number(after.tasks), Number(before.tasks) + 1);
    assertEquals(Number(after.runs), Number(before.runs) + 1);
    // The run is the version in use's, as the principal, on the start's budget.
    const run = (await fixture.pgDatabase.query<{
      workflowVersionId: string;
      requestedBy: string;
      budget: string;
      status: string;
    }>(
      `select workflow_version_id as "workflowVersionId",
              requested_by as "requestedBy", budget_limit_usd::text as budget,
              status
         from bakery.workflow_runs where id = $1`,
      [firing.runId],
    )).rows[0];
    assertEquals(run, {
      workflowVersionId: s.published.id,
      requestedBy: fixture.principalId,
      budget: "5.000000",
      status: "queued",
    });
    assertEquals(await s.audits(), [{ outcome: "succeeded", code: null }]);

    // The same event again, as a replayed route would: one firing, one run.
    const [again] = await s.fire(eventId);
    assertEquals(again.result, "duplicate");
    assertEquals(await s.counts(), after);
    assertEquals((await s.firings()).length, 1);

    // Another event is another firing and another run.
    const [next] = await s.fire(await s.receive());
    assertEquals(next.result, "started");
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 2);
  }));

Deno.test("a principal who has lost access when the start fires fails the firing, visibly, and runs nothing", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    const member = await addMember(fixture, "admin");
    await activatedBy(fixture, s, member);

    // While they hold access, their use of the version runs.
    const [ran] = await s.fire(await s.receive());
    assertEquals(ran.result, "started", JSON.stringify(ran));
    const baseline = await s.counts();

    const lost = async (
      label: string,
      lose: () => Promise<unknown>,
    ) => {
      await lose();
      const [outcome] = await s.fire(await s.receive());
      assertEquals(
        [outcome.result, outcome.code],
        ["failed", "actor_unavailable"],
        label,
      );
      // Nothing was run on the stale grant.
      assertEquals(await s.counts(), baseline, label);
      const last = (await s.firings()).at(-1)!;
      assertEquals(
        [last.status, last.failureCode, last.runId, last.actorId],
        ["failed", "actor_unavailable", null, member],
        label,
      );
      // Visible: an audit row and its code say who and why.
      assertEquals((await s.audits()).at(-1), {
        outcome: "failed",
        code: "actor_unavailable",
      }, label);
    };

    // Their membership ended.
    await lost("membership inactive", () =>
      fixture.pgDatabase.query(
        `update bakery.organization_memberships set status = 'inactive'
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, member],
      ));
    // Back as a member, but with a role that no longer holds task or run writes.
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'active'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, member],
    );
    const [back] = await s.fire(await s.receive());
    assertEquals(
      back.result,
      "started",
      "access restored, the start runs again",
    );
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'reads-only', 'reads-only', $3, $4)`,
      [roleId, fixture.organizationId, ["review:read"], member],
    );
    const afterBack = await s.counts();
    baselineAssign(afterBack);
    // A custom role with no base role does not resolve to an actor at all; the
    // permission half of the check is the service-account case below.
    await lost("custom role with no base role", () =>
      fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set custom_role_id = $3, role = null
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, member, roleId],
      ));

    function baselineAssign(counts: { tasks: string; runs: string }) {
      baseline.tasks = counts.tasks;
      baseline.runs = counts.runs;
    }
  }));

Deno.test("a version used before the actor was recorded fails its firing until a person uses it again", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    await activatedBy(fixture, s, null);
    const before = await s.counts();
    const [outcome] = await s.fire(await s.receive());
    assertEquals([outcome.result, outcome.code], [
      "failed",
      "actor_unavailable",
    ]);
    assertEquals(await s.counts(), before);
    const [firing] = await s.firings();
    assertEquals([firing.status, firing.actorId, firing.runId], [
      "failed",
      null,
      null,
    ]);
  }));

Deno.test("a start that refuses for a reason waiting will not change fails the firing with that code", () =>
  withWorkerFixture(async (fixture) => {
    // A start with no budget names none, and the workflow's model step needs one.
    const s = await setUp(fixture, { budgetUsd: 0 });
    const before = await s.counts();
    const [outcome] = await s.fire(await s.receive());
    assertEquals(outcome.result, "failed");
    assertEquals(outcome.code, "budget_below_reservation");
    assertEquals(await s.counts(), before);
    assertEquals(
      (await s.firings())[0].failureCode,
      "budget_below_reservation",
    );
  }));

Deno.test("the loop guard counts a workflow's firings in the hour, and skips the rest on record", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    await fixture.pgDatabase.query(
      `insert into bakery.workflow_start_firings (
         organization_id, workflow_id, workflow_version_id, start_id,
         application_id, repository_id, actor_id, status)
       select $1, $2, $3, 'earlier', $4, $5, $6, 'started'
         from generate_series(1, $7)`,
      [
        fixture.organizationId,
        s.workflowId,
        s.published.id,
        s.repository.applicationId,
        s.repository.repositoryId,
        fixture.principalId,
        START_FIRINGS_PER_HOUR,
      ],
    );
    const before = await s.counts();
    const [outcome] = await s.fire(await s.receive());
    assertEquals([outcome.result, outcome.code], [
      "skipped_rate",
      "rate_limited",
    ]);
    assertEquals(await s.counts(), before);
    const skipped = (await s.firings()).filter((firing) =>
      firing.triggerEventId !== null
    );
    assertEquals(skipped.map((row) => [row.status, row.failureCode]), [
      ["skipped", "rate_limited"],
    ]);
    assert(outcome.workflowId === s.workflowId);
  }));

Deno.test("a start fires only for the version in use at the moment it fires, and only while the workflow is enabled", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    const live = {
      workflowId: s.workflowId,
      versionId: s.published.id,
      startId: "on-pr",
    };
    const fireStale = async () =>
      await withPgTransaction(
        fixture.runtimePgDatabase,
        async (transaction) =>
          await fireLiveStart(
            transaction,
            {
              organizationId: fixture.organizationId,
              inboundEventId: await s.receive(),
            },
            { id: s.repository.repositoryId },
            live,
          ),
      );
    const before = await s.counts();
    const setDefinition = (set: string) =>
      fixture.pgDatabase.query(
        `update bakery.workflow_definitions set ${set}
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, s.workflowId],
      );
    // The version a match saw is no longer in use.
    await setDefinition("active_version_id = null");
    assertEquals((await fireStale()).result, "superseded");
    // The workflow was switched off between the match and the lock.
    await setDefinition(
      "active_version_id = '" + s.published.id + "', enabled = false",
    );
    assertEquals((await fireStale()).result, "superseded");
    // Nothing was recorded or run for either.
    assertEquals(await s.firings(), []);
    assertEquals(await s.counts(), before);
    // In use and enabled, the same live start fires.
    await setDefinition("enabled = true");
    assertEquals((await fireStale()).result, "started");
  }));

Deno.test("a service account that may activate versions but not write tasks or runs runs nothing", () =>
  withWorkerFixture(async (fixture) => {
    // The case that needs the permission check itself: this principal resolves
    // to an actor in the organization (a custom role and one grant, as a token's
    // would give) and holds workflowVersion:manage, so it can use a version, but
    // neither task:write nor run:write. Without the check it would get a task
    // and a run through a start. (Found by QA on #916.)
    const s = await setUp(fixture);
    const principalId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, null, 'Activator service', 'service')`,
      [principalId],
    );
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'activator', 'activator', $3, $4)`,
      [
        roleId,
        fixture.organizationId,
        ["workflowVersion:manage", "workflow:read", "task:read", "run:read"],
        principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships
         (id, organization_id, principal_id, role, custom_role_id, status,
          joined_at, created_at, updated_at, version)
       values ($1, $2, $3, null, $4, 'active', now(), now(), now(), 1)`,
      [crypto.randomUUID(), fixture.organizationId, principalId, roleId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.permission_grants
         (organization_id, principal_id, capability, granted_by_principal_id,
          policy_revision)
       values ($1, $2, 'activator.noop', $3, 1)`,
      [fixture.organizationId, principalId, fixture.principalId],
    );
    await activatedBy(fixture, s, principalId);
    const before = await s.counts();
    const [outcome] = await s.fire(await s.receive());
    assertEquals([outcome.result, outcome.code], [
      "failed",
      "actor_unavailable",
    ]);
    assertEquals(await s.counts(), before);
    assertEquals((await s.firings()).at(-1)?.runId, null);
  }));

Deno.test("a principal who has been disabled when the start fires fails the firing", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    const member = await addMember(fixture, "admin");
    await activatedBy(fixture, s, member);
    const [ran] = await s.fire(await s.receive());
    assertEquals(ran.result, "started", JSON.stringify(ran));
    const baseline = await s.counts();
    await fixture.pgDatabase.query(
      `update bakery.principals set disabled_at = now() where id = $1`,
      [member],
    );
    const [outcome] = await s.fire(await s.receive());
    assertEquals([outcome.result, outcome.code], [
      "failed",
      "actor_unavailable",
    ]);
    assertEquals(await s.counts(), baseline);
  }));

Deno.test("two consumers racing one event start exactly one run", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    const before = await s.counts();
    const eventId = await s.receive();
    const results = await Promise.all([s.fire(eventId), s.fire(eventId)]);
    assertEquals(results.flat().map((outcome) => outcome.result).sort(), [
      "duplicate",
      "started",
    ]);
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 1);
    assertEquals((await s.firings()).length, 1);
  }));

Deno.test("two events racing at the hourly limit start one run and skip the other on record", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture);
    await fixture.pgDatabase.query(
      `insert into bakery.workflow_start_firings (
         organization_id, workflow_id, workflow_version_id, start_id,
         application_id, repository_id, actor_id, status)
       select $1, $2, $3, 'earlier', $4, $5, $6, 'started'
         from generate_series(1, $7)`,
      [
        fixture.organizationId,
        s.workflowId,
        s.published.id,
        s.repository.applicationId,
        s.repository.repositoryId,
        fixture.principalId,
        START_FIRINGS_PER_HOUR - 1,
      ],
    );
    const before = await s.counts();
    const [a, b] = await Promise.all([
      s.fire(await s.receive()),
      s.fire(await s.receive()),
    ]);
    assertEquals([...a, ...b].map((outcome) => outcome.result).sort(), [
      "skipped_rate",
      "started",
    ]);
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 1);
  }));

Deno.test("an event start runs on the repository the event arrived on when it takes the repository from the event", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture, {
      on: {
        kind: "event",
        eventKind: "change_request.opened",
        filter: {},
        inputsFromEvent: { repositoryId: "repositoryId" },
      },
    });
    const other = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: s.agent,
    });
    const [outcome] = await withPgTransaction(
      fixture.runtimePgDatabase,
      async (transaction) =>
        await fireStartsFor(
          transaction,
          {
            organizationId: fixture.organizationId,
            inboundEventId: await s.receive(),
          },
          { id: other.repositoryId },
          EVENT,
        ),
    );
    assertEquals(outcome.result, "started", JSON.stringify(outcome));
    const run = (await fixture.pgDatabase.query<{ repositoryId: string }>(
      `select task.repository_id as "repositoryId"
         from bakery.workflow_start_firings firing
         join bakery.workflow_runs run on run.id = firing.run_id
         join bakery.tasks task on task.id = run.task_id
        where firing.organization_id = $1`,
      [fixture.organizationId],
    )).rows;
    assertEquals(run, [{ repositoryId: other.repositoryId }]);
  }));

Deno.test("a schedule start fires the version in use once per tick, however often the clock wakes", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture, {
      id: "hourly",
      on: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" },
    });
    const before = await s.counts();
    const tick = async (at: string) =>
      (await fireDueScheduleStarts({
        database: fixture.runtimePgDatabase,
        now: new Date(at),
      })).filter((outcome) => outcome.workflowId === s.workflowId)
        .map((outcome) => [outcome.startId, outcome.result, outcome.code]);

    assertEquals(await tick("2026-11-25T09:30:00Z"), []);
    assertEquals(await tick("2026-11-25T10:00:20Z"), [
      ["hourly", "started", undefined],
    ]);
    const [firing] = await s.firings();
    assertEquals(
      [firing.status, firing.triggerEventId, firing.actorId],
      ["started", null, fixture.principalId],
    );
    assertEquals(await tick("2026-11-25T10:01:00Z"), [
      ["hourly", "duplicate", undefined],
    ]);
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 1);
  }));

Deno.test("two clocks waking on one tick start exactly one run", () =>
  withWorkerFixture(async (fixture) => {
    const s = await setUp(fixture, {
      id: "hourly",
      on: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" },
    });
    const before = await s.counts();
    const now = new Date("2026-11-25T10:00:20Z");
    const results = await Promise.all([
      fireDueScheduleStarts({ database: fixture.runtimePgDatabase, now }),
      fireDueScheduleStarts({ database: fixture.runtimePgDatabase, now }),
    ]);
    assertEquals(
      results.flat().filter((outcome) => outcome.workflowId === s.workflowId)
        .map((outcome) => outcome.result).sort(),
      ["duplicate", "started"],
    );
    assertEquals(Number((await s.counts()).runs), Number(before.runs) + 1);
    assertEquals((await s.firings()).length, 1);
  }));
