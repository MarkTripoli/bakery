import { assert, assertEquals } from "@std/assert";
import { processAutomationRoute } from "../../apps/server/src/modules/workflows/automations/event-intake.ts";
import { secondOrganization } from "../helpers/github-app-registration.ts";
import {
  firingRows,
  seedAutomation,
} from "../helpers/github-intake/automation-routes.ts";
import {
  enabledReceiver,
  issuesPayload,
  receipt,
  routeRows,
  withFixture,
} from "../helpers/github-intake/receipts-shared.ts";
import { seedTaskAndRepository } from "../helpers/github-intake/seed.ts";

// #36 slice 4d, tenant isolation. The receipt names no organization: the
// installation and repository ids only locate rows Bakery already holds, so an
// automation of another organization can neither earn a route from this
// delivery nor be made to fire by it, even when everything it can name is the
// same.

const issues = {
  type: "event",
  provider: "github",
  kind: "issues",
  action: "opened",
  filter: {},
};

Deno.test("another organization's automation, bound to the same repository id and listening for the same event, earns no route and never fires", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    const mine = await seedAutomation(f, task, { trigger: issues });

    // A second organization with its own repository that spells the same
    // GitHub repository id, and an automation bound to it that hears every
    // issue event.
    const foreignOrganizationId = await secondOrganization(f);
    const foreignApplicationId = crypto.randomUUID();
    const foreignRepositoryId = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Foreign application')`,
      [
        foreignApplicationId,
        foreignOrganizationId,
        `foreign-${foreignApplicationId}`,
      ],
    );
    await f.pgDatabase.query(
      `insert into bakery.repositories (id, organization_id, application_id,
         integration_connection_id, provider_repo_id, owner, name, default_branch)
       values ($1, $2, $3, $4, $5, 'acme', 'web', 'main')`,
      [
        foreignRepositoryId,
        foreignOrganizationId,
        foreignApplicationId,
        crypto.randomUUID(),
        r.resource.external_id,
      ],
    );
    const foreign = await seedAutomation(f, {
      organizationId: foreignOrganizationId,
      applicationId: foreignApplicationId,
      repositoryId: foreignRepositoryId,
    }, { trigger: issues });

    const sent = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 9),
    });
    assertEquals(sent.status, "accepted");
    const routes = await routeRows(f, sent.eventId);
    // Every route is the receiving organization's own.
    assertEquals(
      routes.every((route) => route.organization_id === task.organizationId),
      true,
    );
    const automationRoute = routes.find((route) =>
      route.purpose === "automation"
    );
    assert(automationRoute !== undefined);

    const outcome = await processAutomationRoute(
      f.runtimePgDatabase!,
      automationRoute.id,
    );
    assert(outcome.kind === "settled");
    assertEquals(
      outcome.firings.map((firing) => firing.automationId),
      [mine.definitionId],
    );
    assertEquals((await firingRows(f, foreignOrganizationId)).length, 0);
    assertEquals((await firingRows(f, task.organizationId)).length, 1);
    assert(foreign.definitionId !== mine.definitionId);
  }));

Deno.test("a route another organization holds for the same event names no firing of ours", () =>
  withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const task = await seedTaskAndRepository(f, r.resource);
    await seedAutomation(f, task, { trigger: issues });
    const sent = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 4),
    });
    const route = (await routeRows(f, sent.eventId)).find((row) =>
      row.purpose === "automation"
    )!;
    // The consumer takes the organization from the route row, so a route read
    // under a different id (not found) or a malformed one changes nothing.
    for (const id of [crypto.randomUUID(), "not-a-uuid", `${route.id}'; --`]) {
      assertEquals(await processAutomationRoute(f.runtimePgDatabase!, id), {
        kind: "skipped",
        reason: "not_found",
      });
    }
    assertEquals((await firingRows(f, task.organizationId)).length, 0);
    assertEquals(
      (await routeRows(f, sent.eventId)).find((row) => row.id === route.id)!
        .status,
      "pending",
    );
  }));
