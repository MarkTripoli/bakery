import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { AuthoringBoundary } from "../../apps/server/src/modules/workflows/plugin-authoring/runner.ts";
import {
  age,
  authored,
  BROKEN_MIGRATE_JOB,
  count,
  COUNTER_V2_MANIFEST,
  counterPackage,
  CRASHING_JOB,
  latestRunId,
  localDenoRuntime,
  previewRunner,
  readRun,
  scriptedGenerator,
  startRun,
  stateOf,
  withAuthoringFixture,
} from "../helpers/plugin-authoring-fixture.ts";
import type { Fixture } from "../helpers/plugin-pages-fixture.ts";

/**
 * Recovery for authoring (#45, B14.04, AC3).
 *
 * The run's writes are short transactions and its preview runs after the
 * publish commits, so a failed preview is compensated: a revised install goes
 * back to its prior version with its prior state, and a new install is
 * uninstalled with its package withdrawn. A request that dies at any boundary
 * leaves a run that is settled truthfully the next time it is read, and never
 * an install on an unpreviewed version without an event saying so.
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

/** What the state says, without the counters a restore deliberately advances. */
function content(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    owner: row.owner_principal_id,
    namespace: row.namespace,
    key: row.key,
    schemaVersion: row.schema_version,
    value: row.value,
  }));
}

function assertRestored(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
) {
  assertEquals(content(after), content(before));
  // Byte-identical in content, not in counters, on purpose: a restore moves
  // every cas version forward (#34's stale-writer guard), so a writer that read
  // the state before the failed revision cannot write over the restored rows.
  // Putting the old counters back would reopen that hole.
  for (const [i, row] of after.entries()) {
    assert(Number(row.cas_version) > Number(before[i].cas_version));
  }
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
  Deno.test(`AC3: ${name} is rolled back to the prior version and state content, with CAS counters advanced`, () => {
    const generator = scriptedGenerator([counterPackage(), revision]);
    const preview = previewRunner(localDenoRuntime());
    return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
      const first = await authored(fixture);
      assertEquals(first.status, "succeeded");
      const installId = first.pluginInstallId;
      const stateBefore = await stateOf(fixture, installId);
      const installBefore = await installRow(fixture, installId);
      const grantsBefore = await grants(fixture, installId);

      const revised = await authored(fixture, { installId, maxAttempts: 1 });
      assertEquals(revised.status, "blocked", JSON.stringify(revised));
      assertEquals(revised.pluginVersionId, null);
      assertEquals(revised.attempts[0].outcome, "failed");
      assert(
        revised.attempts[0].diagnostics.some((d: { code: string }) =>
          d.code === "PREVIEW_FAILED"
        ),
      );
      assertEquals(await installRow(fixture, installId), installBefore);
      assertEquals(await grants(fixture, installId), grantsBefore);
      assertRestored(stateBefore, await stateOf(fixture, installId));

      assertEquals(
        revised.events.map((e: { kind: string }) => e.kind),
        ["published", "rolled_back"],
      );
      const event = revised.events[1];
      assertEquals(event.detail.stage, stage);
      assertEquals(event.detail.installId, installId);
      assertEquals(event.detail.toVersionId, first.pluginVersionId);
      assertEquals(event.detail.restoredVersionId, first.pluginVersionId);
      assertEquals(
        event.detail.stateDigestRestored,
        event.detail.stateDigestBefore,
      );
    });
  });
}

Deno.test("a new install whose preview fails is uninstalled and its package withdrawn", () => {
  const generator = scriptedGenerator([
    counterPackage({ "job.ts": CRASHING_JOB }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture, { maxAttempts: 1 });
    assertEquals(run.status, "blocked");
    assertEquals(
      run.events.map((e: { kind: string }) => e.kind),
      ["published", "compensated"],
    );
    const { installId, packageId } = run.events[1].detail;
    assertEquals((await installRow(fixture, installId)).status, "uninstalled");
    assertEquals(await grants(fixture, installId), []);
    const listing = await fixture.pgDatabase.query<{ listing_status: string }>(
      `select listing_status from bakery.plugin_packages
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, packageId],
    );
    assertEquals(listing.rows[0].listing_status, "withdrawn");
  });
});

/** A fault that fires once, at one boundary, like a crash at that point. */
function crashOnce() {
  let at: AuthoringBoundary | null = null;
  return {
    arm: (boundary: AuthoringBoundary) => at = boundary,
    boundary: (name: AuthoringBoundary) => {
      if (name !== at) return;
      at = null;
      throw new Error(`simulated crash at ${name}`);
    },
  };
}

for (const boundary of ["run_created", "attempt_recorded"] as const) {
  Deno.test(`a crash at ${boundary} leaves nothing published and settles as interrupted`, () => {
    const crash = crashOnce();
    const generator = scriptedGenerator([counterPackage()]);
    const preview = previewRunner(localDenoRuntime());
    return withAuthoringFixture(
      { generator, preview, boundary: crash.boundary },
      async ({ fixture }) => {
        const versions = await count(fixture, "plugin_versions");
        const installs = await count(fixture, "plugin_installs");
        crash.arm(boundary);
        const failed = await startRun(fixture, {});
        assert(failed.status >= 500, String(failed.status));
        await failed.body?.cancel();
        const runId = await latestRunId(fixture);
        // Fresh: still running, and reading it does not settle it early.
        assertEquals((await readRun(fixture, runId)).status, "running");
        await age(fixture, runId);
        const settled = await readRun(fixture, runId);
        assertEquals(settled.status, "interrupted");
        assertEquals(settled.failure.reason, "run_interrupted");
        assertEquals(settled.events.at(-1).kind, "interrupted");
        assertEquals(settled.events.at(-1).detail.action, "none");
        assertEquals(await count(fixture, "plugin_versions"), versions);
        assertEquals(await count(fixture, "plugin_installs"), installs);
      },
    );
  });
}

Deno.test("a crash after publish, before preview, of a new install is explained and undone", () => {
  const crash = crashOnce();
  const generator = scriptedGenerator([counterPackage()]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture(
    { generator, preview, boundary: crash.boundary },
    async ({ fixture }) => {
      crash.arm("published");
      const failed = await startRun(fixture, {});
      assert(failed.status >= 500);
      await failed.body?.cancel();
      const runId = await latestRunId(fixture);
      // The install points at an unpreviewed version, and an event says so.
      const midway = await readRun(fixture, runId);
      assertEquals(midway.status, "running");
      assertEquals(midway.events.map((e: { kind: string }) => e.kind), [
        "published",
      ]);
      const { installId, versionId } = midway.events[0].detail;
      assertEquals(midway.events[0].detail.previewed, false);
      assertEquals(
        (await installRow(fixture, installId)).plugin_version_id,
        versionId,
      );
      assertEquals(preview.results, []);

      await age(fixture, runId);
      const settled = await readRun(fixture, runId);
      assertEquals(settled.status, "interrupted");
      assertEquals(settled.events.at(-1).kind, "interrupted");
      assertEquals(settled.events.at(-1).detail.action, "uninstalled");
      assertEquals(
        (await installRow(fixture, installId)).status,
        "uninstalled",
      );
      assertEquals(await grants(fixture, installId), []);
      // Settling is done once.
      assertEquals((await readRun(fixture, runId)).events.length, 2);
    },
  );
});

Deno.test("a crash after a revision's move, before preview, is rolled back when read", () => {
  const crash = crashOnce();
  const generator = scriptedGenerator([
    counterPackage(),
    counterPackage({ "job.ts": CRASHING_JOB }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture(
    { generator, preview, boundary: crash.boundary },
    async ({ fixture }) => {
      const first = await authored(fixture);
      const installId = first.pluginInstallId;
      const stateBefore = await stateOf(fixture, installId);
      const installBefore = await installRow(fixture, installId);
      crash.arm("published");
      const failed = await startRun(fixture, { installId });
      assert(failed.status >= 500);
      await failed.body?.cancel();
      const runId = await latestRunId(fixture);
      assertNotEquals(
        (await installRow(fixture, installId)).plugin_version_id,
        first.pluginVersionId,
      );
      await age(fixture, runId);
      const settled = await readRun(fixture, runId);
      assertEquals(settled.status, "interrupted");
      const event = settled.events.at(-1);
      assertEquals(event.kind, "interrupted");
      assertEquals(event.detail.action, "rolled_back");
      assertEquals(
        event.detail.stateDigestRestored,
        event.detail.stateDigestBefore,
      );
      assertEquals(await installRow(fixture, installId), installBefore);
      assertRestored(stateBefore, await stateOf(fixture, installId));
    },
  );
});

Deno.test("a write that fails mid-run leaves nothing published and settles as interrupted", () => {
  const generator = scriptedGenerator([counterPackage()]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const before = {
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
        packages: await count(fixture, "plugin_packages"),
        versions: await count(fixture, "plugin_versions"),
        installs: await count(fixture, "plugin_installs"),
      }, before);
    } finally {
      await fixture.pgDatabase.query(
        "grant insert on bakery.plugin_authoring_attempts to bakery_app",
      );
    }
    const runId = await latestRunId(fixture);
    await age(fixture, runId);
    assertEquals((await readRun(fixture, runId)).status, "interrupted");
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded");
    assertEquals(await count(fixture, "plugin_versions"), before.versions + 1);
  });
});
