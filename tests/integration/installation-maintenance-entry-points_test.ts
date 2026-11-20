import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { importArtifactVersion } from "../../apps/server/src/modules/knowledge/import.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { completeStoragePurgeRequests } from "../../apps/server/src/modules/knowledge/storage-record-purge.ts";
import { processRoute } from "../../apps/server/src/modules/integrations/intake-workflow.ts";
import { processAutomationRoute } from "../../apps/server/src/modules/workflows/automations/event-intake.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { runStoragePurgesTask } from "../../apps/server/src/platform/storage-purges-task.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import {
  authRequest,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import {
  firingRows,
  seedAutomation,
} from "../helpers/github-intake/automation-routes.ts";
import {
  enabledReceiver,
  issuesPayload,
  receipt,
  routeRows,
  withFixture as withGitHubFixture,
} from "../helpers/github-intake/receipts-shared.ts";
import { seedTaskAndRepository } from "../helpers/github-intake/seed.ts";
import {
  assertQuiesced,
  clearInstallationMaintenance,
  holdInstallation,
  letGoInstallation,
} from "../helpers/installation-maintenance.ts";

/**
 * #64 slice B, the other entry points of the maintenance switch: webhook
 * intake, imports and collection. Imports and collection answer
 * INSTALLATION_QUIESCED while the installation is held and commit nothing; the
 * same call succeeds once the hold ends, so the refusal was the switch and not
 * something else. A webhook delivery is accepted and stored instead, and its
 * routes wait.
 */

// (b) webhook intake is the one entry point that does NOT refuse: GitHub does
// not redeliver a delivery that got a 503, so a refused one would be lost.
Deno.test("while the installation is held a GitHub delivery is accepted and stored, both route consumers leave its routes untouched, and both take them after the hold", () =>
  withGitHubFixture(async (f) => {
    try {
      const receiver = await enabledReceiver(f);
      const task = await seedTaskAndRepository(f, receiver.resource);
      await seedAutomation(f, task, {
        trigger: {
          type: "event",
          provider: "github",
          kind: "issues",
          action: "opened",
          filter: {},
        },
      });
      const dependencies = {
        database: f.runtimePgDatabase!,
        github: f.github.client,
        secretsKey: f.secretsKey,
        broker: f.broker,
      };
      const signal = new AbortController().signal;
      const held: string[] = [];

      for (const state of ["draining", "quiesced"] as const) {
        await holdInstallation(f.pgDatabase, { state });
        // Accepted and stored: not a 503, and nothing about it is lost.
        const stored = await receipt(receiver, {
          event: "issues",
          payload: issuesPayload(receiver, 10 + held.length, "opened"),
        });
        assertEquals(stored.status, "accepted", state);
        const routes = await routeRows(f, stored.eventId);
        const automation = routes.find((r) => r.purpose === "automation")!;
        const ticket = routes.find((r) => r.purpose !== "automation")!;
        assert(automation !== undefined && ticket !== undefined, state);
        for (const route of routes) {
          assertEquals([route.status, route.attempts], ["pending", 0], state);
        }

        // Both consumers skip while held: not claimed, no attempt counted,
        // nothing settled and no firing started.
        const before = await routeRows(f, stored.eventId);
        assertEquals(
          await processAutomationRoute(f.runtimePgDatabase!, automation.id),
          { kind: "skipped", reason: "quiesced" },
          state,
        );
        assertEquals(
          await processRoute(dependencies, ticket.id, signal),
          { kind: "skipped", reason: "quiesced" },
          state,
        );
        assertEquals(await routeRows(f, stored.eventId), before, state);
        assertEquals((await firingRows(f, task.organizationId)).length, 0);
        held.push(stored.eventId);
        await letGoInstallation(f.pgDatabase);
      }

      // The hold is over: each consumer now claims its route, which is what
      // the recovery sweep's resend makes happen.
      const [eventId] = held;
      const routes = await routeRows(f, eventId);
      const automation = routes.find((r) => r.purpose === "automation")!;
      const ticket = routes.find((r) => r.purpose !== "automation")!;
      const fired = await processAutomationRoute(
        f.runtimePgDatabase!,
        automation.id,
      );
      assertEquals(fired.kind, "settled");
      assertEquals(
        (await firingRows(f, task.organizationId)).length,
        1,
        "the stored delivery started its firing after the hold",
      );
      try {
        await processRoute(dependencies, ticket.id, signal);
      } catch {
        // Reading GitHub is not what this proves; being claimed is.
      }
      const after = (await routeRows(f, eventId)).find((r) =>
        r.id === ticket.id
      )!;
      assert(
        after.attempts >= 1,
        "the ticket consumer claimed it after the hold",
      );
    } finally {
      await clearInstallationMaintenance(f.pgDatabase);
    }
  }));

// (b) entry point: imports.
Deno.test("while the installation is held a skill import answers 503 INSTALLATION_QUIESCED with Retry-After and starts nothing", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `maintenance-import-${suffix}@example.test`;
  const password = `Maintenance-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Maintenance Admin", password });
    const scope = await fixture.pgDatabase.query<{ organizationId: string }>(
      `select organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join public."user" as provider_user
           on provider_user.id = (
             select provider_user_id from bakery.principals
              where id = membership.principal_id
           )
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0]?.organizationId;
    if (!organizationId) throw new Error("TEST_ORGANIZATION_MISSING");
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const request = (path: string, body: unknown, key: string) =>
      fixture.app.fetch(authRequest(path, body, {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": key,
        },
      }));
    const source = await request("/v1/skill-sources", {
      sourceType: "git",
      url: "https://github.com/example/skills.git",
      name: "Maintenance skills",
      license: "MIT",
    }, `source-${suffix}`);
    assertEquals(source.status, 201, await source.clone().text());
    const { id: sourceId } = await source.json() as { id: string };
    const importInput = { sourceId, revision: "v1.2.3", path: "skills/demo" };
    const admit = () =>
      request(
        "/v1/skill-imports",
        importInput,
        `import-${crypto.randomUUID()}`,
      );
    const counts = async () =>
      (await fixture.pgDatabase.query<Record<string, string>>(
        `select
           (select count(*)::text from bakery.workflow_runs) as runs,
           (select count(*)::text from bakery.skill_imports) as imports,
           (select count(*)::text from bakery.domain_events) as events,
           (select count(*)::text from bakery.outbox) as outbox`,
      )).rows[0];

    await holdInstallation(fixture.pgDatabase, { state: "quiesced" });
    const before = await counts();
    await assertQuiesced(await admit());
    assertEquals(await counts(), before);

    await letGoInstallation(fixture.pgDatabase);
    const started = await admit();
    assertEquals(started.status, 201, await started.clone().text());
    const run = await started.json() as { kind: string; status: string };
    assertEquals(run.kind, "skill_import");
    assertEquals(run.status, "queued");
    assertEquals((await counts()).runs, String(Number(before.runs) + 1));
  } finally {
    await clearInstallationMaintenance(fixture.pgDatabase);
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
  }
});

Deno.test("while the installation is held an artifact version import is refused before it reads or writes anything", async () => {
  const fixture = await openAuthFixture();
  try {
    // The import's own preconditions (an artifact, a repository, a verified
    // blob) need a whole repository world, so this proves the guard at the
    // seam instead: with nothing valid to import, a held installation still
    // answers INSTALLATION_QUIESCED first, and an idle one answers the
    // ordinary validation error, so the refusal is the switch and not the input.
    const attempt = () =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          importArtifactVersion(
            transaction,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
          ),
      );
    const versions = async () =>
      (await fixture.pgDatabase.query<{ n: string }>(
        "select count(*)::text as n from bakery.artifact_versions",
      )).rows[0].n;
    const before = await versions();

    await holdInstallation(fixture.pgDatabase, { state: "draining" });
    const held = await assertRejects(attempt, StandardError);
    assertEquals(held.code, "INSTALLATION_QUIESCED");
    assertEquals(held.params?.retryAfterSeconds !== undefined, true);
    assertEquals(await versions(), before);

    await letGoInstallation(fixture.pgDatabase);
    const idle = await assertRejects(attempt);
    assert(
      !(idle instanceof StandardError && idle.code === "INSTALLATION_QUIESCED"),
      "an idle installation answered the quiesced code",
    );
    assertEquals(await versions(), before);
  } finally {
    await clearInstallationMaintenance(fixture.pgDatabase);
  }
});

// (b) entry point: collection.
Deno.test("while the installation is held nothing is collected, and the scheduled purge skips quietly", async () => {
  const fixture = await retentionFixture();
  try {
    await holdInstallation(fixture.pgDatabase, { state: "quiesced" });

    // Collecting an expired version: refused with the retryable code, bytes intact.
    const collecting = await assertRejects(
      () => collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      StandardError,
    );
    assertEquals(collecting.code, "INSTALLATION_QUIESCED");
    assertEquals(typeof collecting.params?.retryAfterSeconds, "number");
    await assertRetained(fixture);

    // The purge batch refuses the same way and processes no request...
    const purging = await assertRejects(
      () => completeStoragePurgeRequests(fixture.pgDatabase),
      StandardError,
    );
    assertEquals(purging.code, "INSTALLATION_QUIESCED");
    // ...but the scheduled task around it skips the round without failing, so
    // the ten-minute timer raises no alarm during a backup.
    assertEquals(
      await runStoragePurgesTask(Deno.env.get("DATABASE_URL")!),
      { completed: 0, versionsPurged: 0 },
    );
    await assertRetained(fixture);

    // The hold ends and the same version is collected.
    await letGoInstallation(fixture.pgDatabase);
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
  } finally {
    await clearInstallationMaintenance(fixture.pgDatabase);
    await fixture.closeRetention();
  }
});
