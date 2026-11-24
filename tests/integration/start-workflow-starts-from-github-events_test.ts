import { assert, assertEquals } from "@std/assert";
import {
  AutomationRouteCode,
  processAutomationRoute,
} from "../../apps/server/src/modules/workflows/automations/event-intake.ts";
import {
  checkRunPayload,
  enabledReceiver,
  pullRequestPayload,
  receipt,
  routeRows,
  SHA_A,
  withFixture,
} from "../helpers/github-intake/receipts-shared.ts";
import { seedTaskAndRepository } from "../helpers/github-intake/seed.ts";

// #406 slice 3. A verified GitHub delivery that a live workflow start listens
// for earns an automation route at receipt, in neutral terms; the consumer
// matches it against the version in use, records one firing per start under the
// route's transaction, and settles the route. A delivery nobody listens for
// earns nothing, and a version that is not in use listens for nothing.

type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];

/** A workflow whose published version carries one pull request start. */
async function seedWorkflow(
  f: Fixture,
  organizationId: string,
  start: Record<string, unknown>,
) {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
     values ($1, $2, $3, 'Start target', true, 1)`,
    [workflowId, organizationId, `start-target-${workflowId}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
       source_yaml, normalized_spec, digest, status, created_by, starts)
     values ($1, $2, $3, 1, '', '{}'::jsonb, $4, 'published', $5, $6::jsonb)`,
    [
      versionId,
      organizationId,
      workflowId,
      `digest-${versionId}`,
      f.adminId,
      JSON.stringify([start]),
    ],
  );
  const use = async () =>
    await f.pgDatabase.query(
      `update bakery.workflow_definitions
          set active_version_id = $3, active_version_set_by = $4
        where organization_id = $1 and id = $2`,
      [organizationId, workflowId, versionId, f.adminId],
    );
  return { workflowId, versionId, use };
}

const pullRequestStart = (filter: Record<string, unknown> = {}) => ({
  id: "on-update",
  on: { kind: "event", eventKind: "change_request.updated", filter },
});

Deno.test("a live workflow start earns the route, and the consumer records its firing once with the route", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const workflow = await seedWorkflow(
      f,
      task.organizationId,
      pullRequestStart({ number: 3 }),
    );

    // Published but not used: nothing listens, so the delivery earns no route.
    const unheard = await receipt(r, {
      event: "pull_request",
      payload: pullRequestPayload(r, 3, SHA_A),
    });
    assertEquals(unheard.status, "ignored");
    assertEquals((await routeRows(f, unheard.eventId)).length, 0);

    // Used: it listens, for its own kind only.
    await workflow.use();
    const other = await receipt(r, {
      event: "check_run",
      payload: checkRunPayload(r, SHA_A),
    });
    assertEquals(other.status, "ignored", "a check is not a pull request");
    const heard = await receipt(r, {
      event: "pull_request",
      payload: pullRequestPayload(r, 3, SHA_A),
    });
    assertEquals(heard.status, "accepted");
    const [route] = (await routeRows(f, heard.eventId)).filter((row) =>
      row.purpose === "automation"
    );
    assert(route !== undefined, "the delivery earned an automation route");

    const first = await processAutomationRoute(f.runtimePgDatabase!, route.id);
    assert(first.kind === "settled");
    assertEquals([first.status, first.code], [
      "completed",
      AutomationRouteCode.Fired,
    ]);
    assertEquals(first.firings, []);
    assertEquals(first.starts.length, 1);
    assertEquals(first.starts[0].workflowId, workflow.workflowId);
    assertEquals(first.starts[0].versionId, workflow.versionId);
    assertEquals(first.starts[0].startId, "on-update");

    const rows = (await f.pgDatabase.query<
      { status: string; triggerEventId: string; actorId: string }
    >(
      `select status, trigger_event_id as "triggerEventId", actor_id as "actorId"
         from bakery.workflow_start_firings where organization_id = $1`,
      [task.organizationId],
    )).rows;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].triggerEventId, heard.eventId);
    assertEquals(rows[0].actorId, f.adminId);
    // The firing's outcome is on its row, whichever it was.
    assertEquals(rows[0].status, first.starts[0].result);

    // A replay of the route changes nothing.
    assertEquals(await processAutomationRoute(f.runtimePgDatabase!, route.id), {
      kind: "skipped",
      reason: "terminal",
    });

    // A start that names another number matches nothing: the route is
    // accepted for the kind, settled with no match, and records no firing.
    const miss = await receipt(r, {
      event: "pull_request",
      payload: pullRequestPayload(r, 4, SHA_A),
    });
    const [missRoute] = (await routeRows(f, miss.eventId)).filter((row) =>
      row.purpose === "automation"
    );
    const settled = await processAutomationRoute(
      f.runtimePgDatabase!,
      missRoute.id,
    );
    assert(settled.kind === "settled");
    assertEquals(settled.code, AutomationRouteCode.NoMatch);
    assertEquals(settled.starts, []);
  }));
