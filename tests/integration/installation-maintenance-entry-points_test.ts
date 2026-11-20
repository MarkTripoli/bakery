import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { importArtifactVersion } from "../../apps/server/src/modules/knowledge/import.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { completeStoragePurgeRequests } from "../../apps/server/src/modules/knowledge/storage-record-purge.ts";
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
  enabledReceiver,
  issuesPayload,
  receiptRows,
  send,
  withFixture as withGitHubFixture,
} from "../helpers/github-intake/receipts-shared.ts";
import {
  assertQuiesced,
  clearInstallationMaintenance,
  holdInstallation,
  letGoInstallation,
} from "../helpers/installation-maintenance.ts";

/**
 * #64 slice B, the other three entry points of the maintenance switch: webhook
 * intake, imports and collection. Each answers INSTALLATION_QUIESCED while the
 * installation is held and commits nothing; the same call succeeds once the
 * hold ends, so the refusal was the switch and not something else.
 */

// (b) entry point: webhook intake.
Deno.test("while the installation is held a GitHub delivery answers 503 INSTALLATION_QUIESCED with Retry-After and records nothing", () =>
  withGitHubFixture(async (f) => {
    try {
      const receiver = await enabledReceiver(f);
      const target = {
        installationId: receiver.installationId,
        repositoryId: receiver.repositoryId,
      };
      const deliveryId = crypto.randomUUID();
      const deliver = () =>
        send(receiver, {
          event: "issues",
          payload: issuesPayload(target, 1, "opened"),
          deliveryId,
        });
      const counts = async () =>
        (await f.pgDatabase.query<Record<string, string>>(
          `select
             (select count(*)::text from bakery.inbound_events) as receipts,
             (select count(*)::text from bakery.inbound_event_routes) as routes,
             (select count(*)::text from bakery.domain_events) as events,
             (select count(*)::text from bakery.outbox) as outbox,
             (select count(*)::text from bakery.audit_events) as audit`,
        )).rows[0];

      for (const state of ["draining", "quiesced"] as const) {
        await holdInstallation(f.pgDatabase, { state });
        const before = await counts();
        await assertQuiesced(await deliver());
        assertEquals(await counts(), before, state);
      }
      assertEquals((await receiptRows(f)).length, 0);

      // The hold ends: the very same delivery is a first delivery, not a repeat
      // of one the refused call half-recorded.
      await letGoInstallation(f.pgDatabase);
      const accepted = await deliver();
      assertEquals(accepted.status, 202, await accepted.clone().text());
      await accepted.body?.cancel();
      const rows = await receiptRows(f);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].external_delivery_id, deliveryId);
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
