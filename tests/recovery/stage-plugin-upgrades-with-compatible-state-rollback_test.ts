import { assert, assertEquals } from "@std/assert";
import { withPluginFixture } from "../helpers/plugin-pages-fixture.ts";
import {
  grantsOf,
  installFirst,
  manifestOf,
  moveInstall,
  patchInstall,
  pinnedVersion,
  publishVersion,
  snapshotOf,
  stateRows,
  writeState,
} from "../helpers/plugin-upgrade-fixture.ts";

/**
 * A move that fails part way leaves the install as it was (#34, B14.03, AC1).
 *
 * The copy of state, the grant replacement, the restore and the version change
 * are one transaction. These cases break one step for real, by taking the
 * application role's right to write the snapshot away, and then read the tables:
 * the previous usable version, its grants and its state must all be there, and
 * the same request must work once the step can run again.
 */

const WIDER = ["state.read", "state.write", "jobs.schedule"];

Deno.test("a move whose snapshot cannot be written changes nothing, and works once it can", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({
        requestedCapabilities: WIDER,
        stateSchemaVersion: 2,
        stateCompatibleFrom: 1,
      }),
      first.packageId,
    );
    const rowsBefore = await stateRows(fixture, first.installId);
    const grantsBefore = await grantsOf(fixture, first.installId);

    await fixture.pgDatabase.query(
      "revoke insert on bakery.plugin_install_snapshots from bakery_app",
    );
    try {
      const failed = await patchInstall(fixture, first.installId, {
        versionId: second.versionId,
        approveCapabilities: ["jobs.schedule"],
      });
      // The failed step is a server error, not a quiet success, and not a 200
      // that records a version nobody is running.
      assert(
        failed.status >= 500,
        `expected a server error, got ${failed.status}`,
      );
      await failed.body?.cancel();

      assertEquals(
        await pinnedVersion(fixture, first.installId),
        first.versionId,
      );
      assertEquals(await grantsOf(fixture, first.installId), grantsBefore);
      assertEquals(await stateRows(fixture, first.installId), rowsBefore);
      assertEquals(await snapshotOf(fixture, first.installId), null);
      const read = await (await fetchInstall(fixture, first.installId)).json();
      assertEquals(read.pluginVersionId, first.versionId);
      assertEquals(read.stateSchemaVersion, 1);
      assertEquals(read.status, "enabled");
    } finally {
      await fixture.pgDatabase.query(
        "grant insert on bakery.plugin_install_snapshots to bakery_app",
      );
    }

    // The same request, once the step can run, moves the install whole.
    const moved = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
      approveCapabilities: ["jobs.schedule"],
    });
    assertEquals(moved.pluginVersionId, second.versionId);
    assertEquals(await grantsOf(fixture, first.installId), [...WIDER].sort());
    assertEquals(
      (await snapshotOf(fixture, first.installId))?.fromVersionId,
      first.versionId,
    );
  }));

Deno.test("a restore that cannot finish leaves the state and the version it had", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2, stateCompatibleFrom: 1 }),
      first.packageId,
    );
    await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    await writeState(fixture, first.installId, {
      key: "layout",
      value: { columns: 3 },
      schemaVersion: 2,
      expectedCasVersion: 0,
    });
    const rowsBefore = await stateRows(fixture, first.installId);
    const snapshotBefore = await snapshotOf(fixture, first.installId);

    // The restore deletes the live rows and writes the snapshot's back; without
    // the right to delete, it fails after the move has begun.
    await fixture.pgDatabase.query(
      "revoke delete on bakery.plugin_state from bakery_app",
    );
    try {
      const failed = await patchInstall(fixture, first.installId, {
        versionId: first.versionId,
        restoreState: true,
      });
      assert(
        failed.status >= 500,
        `expected a server error, got ${failed.status}`,
      );
      await failed.body?.cancel();
      assertEquals(
        await pinnedVersion(fixture, first.installId),
        second.versionId,
      );
      assertEquals(await stateRows(fixture, first.installId), rowsBefore);
      assertEquals(await snapshotOf(fixture, first.installId), snapshotBefore);
    } finally {
      await fixture.pgDatabase.query(
        "grant delete on bakery.plugin_state to bakery_app",
      );
    }
  }));

function fetchInstall(
  fixture: Parameters<Parameters<typeof withPluginFixture>[0]>[0],
  installId: string,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/plugin-installs/${installId}`,
      {
        headers: {
          Origin: fixture.config.publicBaseUrl,
          Cookie: fixture.adminCookie,
          "Bakery-Organization-Id": fixture.organizationId,
        },
      },
    ),
  ));
}
