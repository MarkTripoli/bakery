import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { readIssueRouteTarget } from "../../apps/server/src/modules/integrations/ticket-reads.ts";
import { processRoute } from "../../apps/server/src/modules/integrations/intake-workflow.ts";
import {
  AutomationRouteCode,
  EVENT_FIRINGS_PER_HOUR,
  processAutomationRoute,
} from "../../apps/server/src/modules/workflows/automations/event-intake.ts";
import type { GitHubAppFixture } from "../helpers/github-app-registration.ts";
import {
  addAutomationVersion,
  firingRows,
  seedAutomation,
} from "../helpers/github-intake/automation-routes.ts";
import {
  checkRunPayload,
  enabledReceiver,
  instrumentedDatabase,
  issuesPayload,
  pullRequestPayload,
  receipt,
  type Receiver,
  type RouteRow,
  routeRows,
  SHA_A,
  withFixture,
} from "../helpers/github-intake/receipts-shared.ts";
import { seedTaskAndRepository } from "../helpers/github-intake/seed.ts";

// #36 slice 4d: event triggers. A verified GitHub delivery that an enabled
// automation is bound to hear earns a route of its own at receipt; the
// automation consumer matches it exactly, admits the firing under the
// automation's lock and settles the route; nobody else touches it.

const signal = new AbortController().signal;

const issuesOpened = (filter: Record<string, unknown> = {}) => ({
  type: "event",
  provider: "github",
  kind: "issues",
  action: "opened",
  filter,
});

/** The one `automation` route a delivery created. */
async function automationRoute(
  f: GitHubAppFixture,
  eventId: string,
): Promise<RouteRow> {
  const routes = (await routeRows(f, eventId)).filter((route) =>
    route.purpose === "automation"
  );
  assertEquals(routes.length, 1, "the delivery earned one automation route");
  return routes[0];
}

async function routeState(f: GitHubAppFixture, id: string): Promise<RouteRow> {
  return (await routeRows(f)).find((route) => route.id === id)!;
}

/** Sends an `issues` delivery and returns the automation route it earned. */
async function issueRoute(
  r: Receiver,
  number: number,
  action = "opened",
): Promise<{ eventId: string; route: RouteRow }> {
  const sent = await receipt(r, {
    event: "issues",
    payload: issuesPayload(r, number, action),
  });
  assertEquals(sent.status, "accepted");
  return {
    eventId: sent.eventId,
    route: await automationRoute(r.f, sent.eventId),
  };
}

Deno.test("an event an enabled automation listens for earns its own route, and no other consumer touches it", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    await seedAutomation(f, task, { trigger: issuesOpened() });

    const { eventId, route } = await issueRoute(r, 7);
    assertEquals(
      (await routeRows(f, eventId)).map((row) => row.purpose).sort(),
      ["automation", "fact_refresh"],
    );
    assertEquals(
      [route.status, route.attempts, route.resource_id, route.organization_id],
      ["pending", 0, r.resource.id, task.organizationId],
    );

    // The integration processor skips it: not claimed, not counted, not settled.
    const outcome = await processRoute(
      {
        database: f.runtimePgDatabase!,
        github: f.github.client,
        secretsKey: f.secretsKey,
        broker: f.broker,
      },
      route.id,
      signal,
    );
    assertEquals(outcome, { kind: "skipped", reason: "foreign_purpose" });
    const untouched = await routeState(f, route.id);
    assertEquals(
      [untouched.status, untouched.attempts, untouched.version],
      ["pending", 0, route.version],
    );
    // The ticket consumer reads no issue from it.
    assertEquals(
      await withPgTransaction(
        f.runtimePgDatabase!,
        (transaction) => readIssueRouteTarget(transaction, route.id),
      ),
      null,
    );
  }));

Deno.test("the receipt gate: only an enabled automation bound to this repository and this kind earns a route", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    // Another repository of the same organization, which nothing is routed for.
    const otherRepositoryId = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.repositories (id, organization_id, application_id,
         integration_connection_id, provider_repo_id, owner, name, default_branch)
       values ($1, $2, $3, $4, 'some-other-repo', 'acme', 'other', 'main')`,
      [
        otherRepositoryId,
        task.organizationId,
        task.applicationId,
        r.connection.connectionId,
      ],
    );
    const pullRequestKind = {
      type: "event",
      provider: "github",
      kind: "pull_request",
      filter: {},
    };
    // Disabled, bound elsewhere, or a schedule: none is listening here.
    await seedAutomation(f, task, { trigger: pullRequestKind, enabled: false });
    await seedAutomation(f, task, {
      trigger: pullRequestKind,
      repositoryId: otherRepositoryId,
    });
    await seedAutomation(f, task, {
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    });
    const ignored = await receipt(r, {
      event: "pull_request",
      payload: pullRequestPayload(r, 3, SHA_A),
    });
    assertEquals(ignored.status, "ignored");
    assertEquals((await routeRows(f, ignored.eventId)).length, 0);

    // An enabled one bound here listens even though no task tracks the pull
    // request (its action is not what tracked pull requests are for).
    await seedAutomation(f, task, { trigger: pullRequestKind });
    const heard = await receipt(r, {
      event: "pull_request",
      payload: pullRequestPayload(r, 3, SHA_A),
    });
    assertEquals(heard.status, "accepted");
    assertEquals(
      (await routeRows(f, heard.eventId)).map((row) => row.purpose),
      ["automation"],
    );
    // An event of another kind earns nothing for it.
    const checkRun = await receipt(r, {
      event: "check_run",
      payload: checkRunPayload(r, SHA_A),
    });
    assertEquals(checkRun.status, "ignored");
  }));

Deno.test("the consumer admits a firing for a matching event once, in its own transaction with the route", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const automation = await seedAutomation(f, task, {
      trigger: issuesOpened({ number: 7 }),
    });
    const { eventId, route } = await issueRoute(r, 7);

    const first = await processAutomationRoute(f.runtimePgDatabase!, route.id);
    assertEquals(first, {
      kind: "settled",
      status: "completed",
      code: AutomationRouteCode.Fired,
      firings: [{
        automationId: automation.definitionId,
        versionId: automation.versionId,
        result: "admitted",
      }],
      starts: [],
    });
    const [firing] = await firingRows(f, task.organizationId);
    assertEquals(
      [
        firing.status,
        firing.pending,
        firing.skippedCount,
        firing.triggerEventId,
      ],
      ["queued", true, 0, eventId],
    );
    // The firing's instant is the receipt's.
    const receivedAt = (await f.pgDatabase.query<{ at: Date }>(
      `select received_at as at from bakery.inbound_events where id = $1`,
      [eventId],
    )).rows[0].at;
    assertEquals(
      firing.scheduledAt.getTime(),
      Math.trunc(receivedAt.getTime()),
    );
    const settled = await routeState(f, route.id);
    assertEquals(
      [settled.status, settled.outcome_code, settled.attempts],
      ["completed", "automation_fired", 1],
    );

    // A replay of the route, and a redelivery of the same delivery, change nothing.
    assertEquals(await processAutomationRoute(f.runtimePgDatabase!, route.id), {
      kind: "skipped",
      reason: "terminal",
    });
    assertEquals((await firingRows(f, task.organizationId)).length, 1);

    // The consumer does not run what is not its own.
    const [factRoute] = (await routeRows(f, eventId)).filter((row) =>
      row.purpose === "fact_refresh"
    );
    assertEquals(
      await processAutomationRoute(f.runtimePgDatabase!, factRoute.id),
      { kind: "skipped", reason: "not_automation" },
    );
    assertEquals((await routeState(f, factRoute.id)).status, "pending");
  }));

Deno.test("matching is exact: the action and every filter entry, only the active version, every automation that listens", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const wrongNumber = await seedAutomation(f, task, {
      trigger: issuesOpened({ number: 8 }),
    });
    const wrongAction = await seedAutomation(f, task, {
      trigger: { ...issuesOpened(), action: "closed" },
    });
    const anyAction = await seedAutomation(f, task, {
      trigger: {
        type: "event",
        provider: "github",
        kind: "issues",
        filter: {},
      },
    });
    const exact = await seedAutomation(f, task, {
      trigger: issuesOpened({ number: 7, repositoryId: r.repositoryId }),
    });
    // The older version of this automation matched; the active one does not.
    const replaced = await seedAutomation(f, task, { trigger: issuesOpened() });
    await addAutomationVersion(f, task, replaced.definitionId, {
      trigger: issuesOpened({ number: 99 }),
      revision: 2,
      activate: true,
    });

    const { route } = await issueRoute(r, 7);
    const outcome = await processAutomationRoute(
      f.runtimePgDatabase!,
      route.id,
    );
    assert(outcome.kind === "settled");
    assertEquals(
      outcome.firings.map((firing) => firing.automationId).sort(),
      [anyAction.definitionId, exact.definitionId].sort(),
    );
    const fired = await firingRows(f, task.organizationId);
    assertEquals(
      fired.map((row) => row.automationId).sort(),
      [anyAction.definitionId, exact.definitionId].sort(),
    );
    for (const missing of [wrongNumber, wrongAction, replaced]) {
      assert(!fired.some((row) => row.automationId === missing.definitionId));
    }

    // A `closed` event: the automation that names that action, and the one
    // that names none (it hears every action), and nobody else.
    const closed = await issueRoute(r, 7, "closed");
    const second = await processAutomationRoute(
      f.runtimePgDatabase!,
      closed.route.id,
    );
    assert(second.kind === "settled");
    assertEquals(
      second.firings.map((firing) => firing.automationId).sort(),
      [wrongAction.definitionId, anyAction.definitionId].sort(),
    );
    assertEquals(
      (await routeState(f, closed.route.id)).outcome_code,
      "automation_fired",
    );
  }));

Deno.test("a second event in the same instant is a second firing, and concurrent consumers write each once", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const automation = await seedAutomation(f, task, {
      trigger: issuesOpened(),
      overlapPolicy: "queue_one",
    });
    const routes = [
      await issueRoute(r, 1),
      await issueRoute(r, 2),
      await issueRoute(r, 3),
    ];
    // Three deliveries received in one instant.
    await f.pgDatabase.query(
      `update bakery.inbound_events set received_at = $1 where id = any($2::uuid[])`,
      ["2026-11-14T12:00:00.000Z", routes.map((entry) => entry.eventId)],
    );
    const outcomes = await Promise.all(
      routes.map((entry) =>
        processAutomationRoute(f.runtimePgDatabase!, entry.route.id)
      ),
    );
    for (const outcome of outcomes) assert(outcome.kind === "settled");
    const rows = await firingRows(f, task.organizationId);
    assertEquals(rows.length, 3);
    // One instant each, a millisecond apart, none dropped as a duplicate.
    assertEquals(
      rows.map((row) => row.scheduledAt.toISOString()),
      [
        "2026-11-14T12:00:00.000Z",
        "2026-11-14T12:00:00.001Z",
        "2026-11-14T12:00:00.002Z",
      ],
    );
    // The overlap policy applied under the automation's lock: `queue_one`
    // keeps one waiting firing and skips the rest.
    assertEquals(
      rows.map((row) => row.status).sort(),
      ["queued", "skipped", "skipped"],
    );
    assertEquals(rows.filter((row) => row.pending).length, 1);
    assertEquals(
      rows.every((row) => row.automationId === automation.definitionId),
      true,
    );
  }));

Deno.test("overlap: an event while the automation is busy is skipped under `skip`, queued once under `queue_one`", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const skipping = await seedAutomation(f, task, {
      trigger: issuesOpened(),
      overlapPolicy: "skip",
    });
    const first = await issueRoute(r, 1);
    const second = await issueRoute(r, 2);
    await f.pgDatabase.query(
      `update bakery.inbound_events set received_at = case id
         when $1::uuid then '2026-11-14T12:00:00Z'::timestamptz
         else '2026-11-14T12:05:00Z'::timestamptz end
       where id in ($1, $2)`,
      [first.eventId, second.eventId],
    );
    await processAutomationRoute(f.runtimePgDatabase!, first.route.id);
    await processAutomationRoute(f.runtimePgDatabase!, second.route.id);
    const rows = await firingRows(f, task.organizationId);
    assertEquals(
      rows.map((
        row,
      ) => [row.automationId, row.status, row.pending, row.skippedCount]),
      [
        [skipping.definitionId, "queued", true, 0],
        [skipping.definitionId, "skipped", false, 1],
      ],
    );
  }));

/** An hour's worth of event firings of one status, each on its own inbound event. */
async function seedHourOfFirings(
  f: GitHubAppFixture,
  receiver: Receiver,
  organizationId: string,
  versionId: string,
  status: "failed" | "skipped",
): Promise<void> {
  await f.pgDatabase.query(
    `with events as (
       insert into bakery.inbound_events (
         id, provider, registration_id, external_delivery_id, payload_digest,
         event_kind, status, expires_at
       )
       select gen_random_uuid(), 'github', $2, 'loop-' || $4 || '-' || n,
              'digest-' || n, 'issues', 'routed', now() + interval '1 day'
         from generate_series(1, $3::int) n
       returning id
     )
     insert into bakery.automation_firings (
       organization_id, automation_version_id, scheduled_at, trigger_event_id,
       status, pending, skipped_count
     )
     select $1, $4::uuid, now() - interval '30 minutes'
                    + (row_number() over () * interval '1 second'),
            id, $5, false, case when $5 = 'skipped' then 1 else 0 end
       from events`,
    [
      organizationId,
      receiver.registrationId,
      EVENT_FIRINGS_PER_HOUR,
      versionId,
      status,
    ],
  );
}

Deno.test("the loop guard counts the firings an automation admitted in the hour, not the ones it skipped", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const spent = await seedAutomation(f, task, {
      trigger: issuesOpened(),
      overlapPolicy: "queue_one",
    });
    const declined = await seedAutomation(f, task, {
      trigger: issuesOpened(),
      overlapPolicy: "queue_one",
    });
    // One automation has already admitted its hour's allowance (the firings
    // ended, so nothing holds it); the other skipped a whole hour's worth of
    // events and admitted none.
    await seedHourOfFirings(
      f,
      r,
      task.organizationId,
      spent.versionId,
      "failed",
    );
    await seedHourOfFirings(
      f,
      r,
      task.organizationId,
      declined.versionId,
      "skipped",
    );
    const { route } = await issueRoute(r, 5);
    const outcome = await processAutomationRoute(
      f.runtimePgDatabase!,
      route.id,
    );
    assert(outcome.kind === "settled");
    const resultOf = (automationId: string) =>
      outcome.firings.find((firing) => firing.automationId === automationId)
        ?.result;
    // The spent one records the event as skipped: nothing more is admitted.
    assertEquals(resultOf(spent.definitionId), "skipped_rate");
    // The one that only skipped is not locked out: the next event is admitted.
    assertEquals(resultOf(declined.definitionId), "admitted");
    const rows = await firingRows(f, task.organizationId);
    const latest = (versionId: string) =>
      rows.filter((row) => row.versionId === versionId).at(-1)!;
    assertEquals(
      [latest(spent.versionId).status, latest(spent.versionId).pending],
      ["skipped", false],
    );
    assertEquals(
      [latest(declined.versionId).status, latest(declined.versionId).pending],
      ["queued", true],
    );
    assertEquals(
      rows.filter((row) => row.versionId === spent.versionId).length,
      EVENT_FIRINGS_PER_HOUR + 1,
    );
  }));

Deno.test("authority is read again: a connection or repository that lost it by the time the route runs earns no firing", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    await seedAutomation(f, task, { trigger: issuesOpened() });

    const disabled = await issueRoute(r, 1);
    await f.pgDatabase.query(
      `update bakery.integration_connections set status = 'disabled' where id = $1`,
      [r.connection.connectionId],
    );
    const refused = await processAutomationRoute(
      f.runtimePgDatabase!,
      disabled.route.id,
    );
    assertEquals(refused, {
      kind: "settled",
      status: "ignored",
      code: "connection_not_enabled",
      firings: [],
      starts: [],
    });
    await f.pgDatabase.query(
      `update bakery.integration_connections set status = 'enabled' where id = $1`,
      [r.connection.connectionId],
    );

    const deselected = await issueRoute(r, 2);
    await f.pgDatabase.query(
      `update bakery.integration_resources set selected = false where id = $1`,
      [r.resource.id],
    );
    const lost = await processAutomationRoute(
      f.runtimePgDatabase!,
      deselected.route.id,
    );
    assert(lost.kind === "settled" && lost.status === "ignored");
    assertEquals(lost.code, "unselected_repository");
    assertEquals((await firingRows(f, task.organizationId)).length, 0);
  }));

Deno.test("a failure rolls the work back whole and defers the route; a later pass admits it", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    await seedAutomation(f, task, { trigger: issuesOpened() });
    const { route } = await issueRoute(r, 4);

    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    state.failing = "insert into bakery.automation_firings";
    const failed = await processAutomationRoute(database, route.id);
    assertEquals(failed, {
      kind: "settled",
      status: "deferred",
      code: AutomationRouteCode.Error,
      firings: [],
      starts: [],
    });
    assertEquals((await firingRows(f, task.organizationId)).length, 0);
    const deferred = await routeState(f, route.id);
    assertEquals([deferred.status, deferred.attempts], ["deferred", 1]);

    // Not due until its backoff has passed.
    assertEquals(await processAutomationRoute(f.runtimePgDatabase!, route.id), {
      kind: "skipped",
      reason: "not_due",
    });
    await f.pgDatabase.query(
      `update bakery.inbound_event_routes set not_before = now() - interval '1 second'
        where id = $1`,
      [route.id],
    );
    const retried = await processAutomationRoute(
      f.runtimePgDatabase!,
      route.id,
    );
    assert(retried.kind === "settled" && retried.status === "completed");
    assertEquals((await firingRows(f, task.organizationId)).length, 1);
    assertEquals((await routeState(f, route.id)).attempts, 2);
  }));
