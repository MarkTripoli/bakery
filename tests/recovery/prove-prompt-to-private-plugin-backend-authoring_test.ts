import { assert, assertEquals } from "@std/assert";
import {
  authored,
  BROKEN_MIGRATE_JOB,
  count,
  COUNTER_V2_MANIFEST,
  counterPackage,
  CRASHING_JOB,
  localDenoRuntime,
  previewRunner,
  scriptedGenerator,
  startRun,
  stateOf,
  withAuthoringFixture,
} from "../helpers/plugin-authoring-fixture.ts";
import type { Fixture } from "../helpers/plugin-pages-fixture.ts";

/**
 * Recovery for authoring (#45, B14.04, AC3).
 *
 * A revision whose preview or state migration fails after the install moved is
 * rolled back: the install is on its prior version with its prior state, row
 * for row, and the run keeps evidence of the rollback. A run that crashes part
 * way leaves nothing published.
 */

async function installRow(fixture: Fixture, installId: string) {
  const result = await fixture.pgDatabase.query(
    `select plugin_version_id, status, state_schema_version, last_update_failure
       from bakery.plugin_installs where organization_id = $1 and id = $2`,
    [fixture.organizationId, installId],
  );
  return result.rows[0];
}

async function grants(fixture: Fixture, installId: string) {
  const result = await fixture.pgDatabase.query<{ capability: string }>(
    `select capability from bakery.plugin_install_grants
      where organization_id = $1 and plugin_install_id = $2
      order by capability`,
    [fixture.organizationId, installId],
  );
  return result.rows.map((row) => row.capability);
}

for (
  const [name, revision, stage] of [
    [
      "a version that fails its preview after the move",
      counterPackage({ "job.ts": CRASHING_JOB }),
      "preview",
    ],
    [
      "a state migration that fails after writing",
      counterPackage({
        "manifest.json": COUNTER_V2_MANIFEST,
        "job.ts": BROKEN_MIGRATE_JOB,
      }),
      "migrate",
    ],
  ] as const
) {
  Deno.test(`AC3: ${name} is rolled back to the prior version and state`, () => {
    const generator = scriptedGenerator([counterPackage(), revision]);
    const preview = previewRunner(localDenoRuntime());
    return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
      const first = await authored(fixture);
      assertEquals(first.status, "succeeded");
      const installId = first.pluginInstallId;
      const stateBefore = await stateOf(fixture, installId);
      const installBefore = await installRow(fixture, installId);
      const grantsBefore = await grants(fixture, installId);
      const versions = await count(fixture, "plugin_versions");

      const revised = await authored(fixture, { installId, maxAttempts: 1 });
      assertEquals(revised.status, "blocked", JSON.stringify(revised));
      assertEquals(revised.pluginVersionId, null);
      assert(
        revised.attempts[0].diagnostics.some((d: { code: string }) =>
          d.code === "PREVIEW_FAILED"
        ),
      );
      // The install, its grants and its state are what they were, byte for
      // byte, cas versions included.
      assertEquals(await installRow(fixture, installId), installBefore);
      assertEquals(await grants(fixture, installId), grantsBefore);
      assertEquals(await stateOf(fixture, installId), stateBefore);
      assertEquals(await count(fixture, "plugin_versions"), versions);

      // Evidence of the rollback, with the state on each side of it.
      assertEquals(revised.events.length, 1);
      const event = revised.events[0];
      assertEquals(event.kind, "rolled_back");
      assertEquals(event.detail.stage, stage);
      assertEquals(event.detail.installId, installId);
      assertEquals(event.detail.toVersionId, first.pluginVersionId);
      assertEquals(event.detail.restoredVersionId, first.pluginVersionId);
      assertEquals(
        event.detail.stateDigestRestored,
        event.detail.stateDigestBefore,
      );
      assertEquals(
        event.detail.stateDigestAfterRollback,
        event.detail.stateDigestBefore,
      );
    });
  });
}

Deno.test("a run that crashes part way leaves nothing published, and works once it can", () => {
  const generator = scriptedGenerator([counterPackage()]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const before = {
      runs: await count(fixture, "plugin_authoring_runs"),
      packages: await count(fixture, "plugin_packages"),
      versions: await count(fixture, "plugin_versions"),
      installs: await count(fixture, "plugin_installs"),
    };
    await fixture.pgDatabase.query(
      "revoke insert on bakery.plugin_authoring_attempts from bakery_app",
    );
    try {
      const failed = await startRun(fixture, {});
      assert(
        failed.status >= 500,
        `expected a server error, got ${failed.status}`,
      );
      await failed.body?.cancel();
      assertEquals({
        runs: await count(fixture, "plugin_authoring_runs"),
        packages: await count(fixture, "plugin_packages"),
        versions: await count(fixture, "plugin_versions"),
        installs: await count(fixture, "plugin_installs"),
      }, before);
    } finally {
      await fixture.pgDatabase.query(
        "grant insert on bakery.plugin_authoring_attempts to bakery_app",
      );
    }
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded");
    assertEquals(await count(fixture, "plugin_versions"), before.versions + 1);
  });
});
