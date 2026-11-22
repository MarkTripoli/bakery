import { assert, assertEquals } from "@std/assert";
import { call, withPluginFixture } from "../helpers/plugin-pages-fixture.ts";
import {
  grantsOf,
  installFirst,
  manifestOf,
  moveInstall,
  patchInstall,
  pinnedVersion,
  publishVersion,
  putState,
  snapshotOf,
  stateRows,
  writeState,
} from "../helpers/plugin-upgrade-fixture.ts";

/**
 * Staged plugin upgrades with compatible state rollback (#34, B14.03).
 *
 * Every case drives the real routes against the real tables and then reads the
 * tables: a refused move that still changed a grant, a version or a state row
 * is the failure that matters, and a status code cannot see it.
 */

const WIDER = ["state.read", "state.write", "jobs.schedule"];

Deno.test("AC2: a version that asks for more is not activated until the caller approves exactly that", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );

    // No approval: the install is answered, still on its version and with the
    // authority it had; the refusal names what was asked for.
    const refused = await moveInstall(fixture, first.installId, {
      versionId: wider.versionId,
    });
    assertEquals(refused.pluginVersionId, first.versionId);
    assertEquals(
      refused.lastUpdateFailure.reason,
      "plugin_capabilities_not_approved",
    );
    assertEquals(refused.lastUpdateFailure.addedCapabilities, [
      "jobs.schedule",
    ]);
    assertEquals(
      await pinnedVersion(fixture, first.installId),
      first.versionId,
    );
    assertEquals(await grantsOf(fixture, first.installId), [
      "state.read",
      "state.write",
    ]);
    assertEquals(await snapshotOf(fixture, first.installId), null);

    // An approval of something else, or of more, is an approval of a different
    // upgrade.
    for (
      const approveCapabilities of [["tools.invoke"], [
        "jobs.schedule",
        "tools.invoke",
      ]]
    ) {
      const mismatch = await moveInstall(fixture, first.installId, {
        versionId: wider.versionId,
        approveCapabilities,
      });
      assertEquals(mismatch.pluginVersionId, first.versionId);
      assertEquals(
        mismatch.lastUpdateFailure.reason,
        "plugin_capability_approval_mismatch",
      );
      assertEquals(await grantsOf(fixture, first.installId), [
        "state.read",
        "state.write",
      ]);
    }

    // Exactly the added capability: activated, and the grants are the new
    // version's manifest, no more.
    const done = await moveInstall(fixture, first.installId, {
      versionId: wider.versionId,
      approveCapabilities: ["jobs.schedule"],
    });
    assertEquals(done.pluginVersionId, wider.versionId);
    assertEquals(done.lastUpdateFailure ?? null, null);
    assertEquals(await grantsOf(fixture, first.installId), [...WIDER].sort());
  }));

Deno.test("AC2: narrowing needs no approval, and a rollback takes the added authority back", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    await moveInstall(fixture, first.installId, {
      versionId: wider.versionId,
      approveCapabilities: ["jobs.schedule"],
    });
    assert(
      (await grantsOf(fixture, first.installId)).includes("jobs.schedule"),
    );

    // Back to the narrower version: no approval is asked for, and the
    // capability the wider one held is gone, not inherited.
    const back = await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
    });
    assertEquals(back.pluginVersionId, first.versionId);
    assertEquals(await grantsOf(fixture, first.installId), [
      "state.read",
      "state.write",
    ]);
  }));

Deno.test("an approval or a restore without another version is an error, and an unknown capability is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    for (
      const body of [
        { approveCapabilities: ["jobs.schedule"] },
        { restoreState: true },
        { versionId: first.versionId, restoreState: true },
      ]
    ) {
      const response = await patchInstall(fixture, first.installId, body);
      assertEquals(response.status, 422, JSON.stringify(body));
      await response.body?.cancel();
    }
    // None of them changed anything.
    assertEquals(
      await pinnedVersion(fixture, first.installId),
      first.versionId,
    );
    assertEquals(await snapshotOf(fixture, first.installId), null);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    const unknown = await patchInstall(fixture, first.installId, {
      versionId: wider.versionId,
      approveCapabilities: ["root.shell"],
    });
    // Refused by the contract before the handler runs: it is not a capability.
    assertEquals(unknown.status, 400, await unknown.clone().text());
    assertEquals(
      await pinnedVersion(fixture, first.installId),
      first.versionId,
    );
  }));

Deno.test("AC1: a version that reads the saved state activates and leaves every row as it was", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const before = await stateRows(fixture, first.installId);

    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2, stateCompatibleFrom: 1 }),
      first.packageId,
    );
    const moved = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    assertEquals(moved.pluginVersionId, second.versionId);
    assertEquals(moved.stateSchemaVersion, 2);
    // Not transformed, not renumbered: the new version reads what was saved.
    assertEquals(await stateRows(fixture, first.installId), before);

    // The copy was taken as the install left the first version.
    const snapshot = await snapshotOf(fixture, first.installId);
    assertEquals(snapshot?.fromVersionId, first.versionId);
    assertEquals(snapshot?.fromStateSchemaVersion, 1);
    assertEquals(snapshot?.rowCount, 1);
    assertEquals(snapshot?.rows.map((row) => row.key), ["theme"]);
  }));

Deno.test("AC1: a version that cannot read the saved state is not activated, and the install and its state are untouched", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const rowsBefore = await stateRows(fixture, first.installId);
    // Schema 2 and no promise to read schema 1: it reads only what it wrote.
    const strict = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2 }),
      first.packageId,
    );
    const refused = await moveInstall(fixture, first.installId, {
      versionId: strict.versionId,
    });
    assertEquals(refused.pluginVersionId, first.versionId);
    assertEquals(refused.stateSchemaVersion, 1);
    assertEquals(refused.lastUpdateFailure.reason, "plugin_state_incompatible");
    // The refusal says no restore was asked for, and the install says up front
    // that this version cannot read what it holds, with no copy to go back to.
    assertEquals(refused.lastUpdateFailure.restoreState, false);
    assertEquals(refused.cannotReadVersionIds, [strict.versionId]);
    assertEquals(refused.stateCopy, null);
    assertEquals(
      await pinnedVersion(fixture, first.installId),
      first.versionId,
    );
    assertEquals(await stateRows(fixture, first.installId), rowsBefore);
    assertEquals(await snapshotOf(fixture, first.installId), null);
  }));

Deno.test("AC2: a rollback past state the old version cannot read is blocked, and a restore of the snapshot is the only way back", () =>
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

    // The new version writes at its own schema: a changed value and a new key.
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark", density: "compact" },
      schemaVersion: 2,
      expectedCasVersion: 1,
    });
    await writeState(fixture, first.installId, {
      key: "layout",
      value: { columns: 3 },
      schemaVersion: 2,
      expectedCasVersion: 0,
    });
    const rowsOnSecond = await stateRows(fixture, first.installId);

    // Rolling the code back without the state would hand schema-2 rows to a
    // version that only knows schema 1.
    const blocked = await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
    });
    assertEquals(blocked.pluginVersionId, second.versionId);
    assertEquals(blocked.lastUpdateFailure.reason, "plugin_state_incompatible");
    assertEquals(blocked.lastUpdateFailure.restoreState, false);
    // The install says what it can offer: the first version cannot read today's
    // data, and the copy it keeps is that version's, taken when the install left
    // it, with the one item it held then.
    assertEquals(blocked.cannotReadVersionIds, [first.versionId]);
    assertEquals(blocked.stateCopy.versionId, first.versionId);
    assertEquals(blocked.stateCopy.itemCount, 1);
    assert(!Number.isNaN(Date.parse(blocked.stateCopy.takenAt)));
    assertEquals(typeof blocked.stateCopy.versionName, "string");
    assertEquals(await stateRows(fixture, first.installId), rowsOnSecond);

    // A restore brings back the state the first version left, and discards what
    // the second one saved.
    const restored = await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
      restoreState: true,
    });
    assertEquals(restored.pluginVersionId, first.versionId);
    assertEquals(restored.stateSchemaVersion, 1);
    assertEquals(restored.lastUpdateFailure ?? null, null);
    const after = await stateRows(fixture, first.installId);
    assertEquals(after.map((row) => [row.key, row.schema_version, row.value]), [
      ["theme", 1, { theme: "dark" }],
    ]);

    // A writer that read the state before the restore cannot write against it:
    // the restored row's CAS number is above any the install had issued, so a
    // number a reader held (1 when the key was first written, 2 after the second
    // version changed it) never matches the restored row.
    const topBefore = Math.max(...rowsOnSecond.map((row) => row.cas_version));
    assert(after[0].cas_version > topBefore);
    for (const held of [1, 2]) {
      const stale = await putState(fixture, first.installId, {
        key: "theme",
        value: { theme: "light" },
        schemaVersion: 1,
        expectedCasVersion: held,
      });
      assertEquals(stale.status, 409, `a writer holding ${held}`);
      await stale.body?.cancel();
    }

    // The snapshot is now what the second version left, so rolling forward is a
    // restore too.
    const snapshot = await snapshotOf(fixture, first.installId);
    assertEquals(snapshot?.fromVersionId, second.versionId);
    assertEquals(snapshot?.rows.map((row) => row.key), ["layout", "theme"]);
    const forward = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
      restoreState: true,
    });
    assertEquals(forward.pluginVersionId, second.versionId);
    assertEquals(
      (await stateRows(fixture, first.installId)).map((row) => row.key),
      ["layout", "theme"],
    );
  }));

Deno.test("a rollback with state the old version can read needs no restore", () =>
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
    // Nothing was written at schema 2, so every row is still one the first
    // version wrote.
    const back = await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
    });
    assertEquals(back.pluginVersionId, first.versionId);
    assertEquals(back.lastUpdateFailure ?? null, null);
    assertEquals((await stateRows(fixture, first.installId)).length, 1);
  }));

Deno.test("a restore is only for the version the snapshot was taken from", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2, stateCompatibleFrom: 1 }),
      first.packageId,
    );
    const third = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2, stateCompatibleFrom: 1 }),
      first.packageId,
    );

    // No snapshot yet: there is nothing to restore.
    const none = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
      restoreState: true,
    });
    assertEquals(none.pluginVersionId, first.versionId);
    assertEquals(
      none.lastUpdateFailure.reason,
      "plugin_state_snapshot_not_for_version",
    );
    assertEquals(none.lastUpdateFailure.restoreState, true);
    assertEquals(none.stateCopy, null);

    await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    // The snapshot is of the first version; the third is another version.
    const other = await moveInstall(fixture, first.installId, {
      versionId: third.versionId,
      restoreState: true,
    });
    assertEquals(other.pluginVersionId, second.versionId);
    assertEquals(
      other.lastUpdateFailure.reason,
      "plugin_state_snapshot_not_for_version",
    );
    assertEquals(
      (await snapshotOf(fixture, first.installId))?.fromVersionId,
      first.versionId,
    );
  }));

Deno.test("AC3: a state write racing a move lands whole, and the snapshot holds exactly what was there when the install left", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 1 }),
      first.packageId,
    );
    const [written, moved] = await Promise.all([
      putState(fixture, first.installId, {
        key: "theme",
        value: { theme: "dark" },
        schemaVersion: 1,
        expectedCasVersion: 0,
      }),
      patchInstall(fixture, first.installId, { versionId: second.versionId }),
    ]);
    assertEquals(written.status, 200, await written.clone().text());
    assertEquals(moved.status, 200, await moved.clone().text());
    assertEquals((await moved.json()).pluginVersionId, second.versionId);

    // The write is in the live state exactly once, whichever order they ran.
    const live = await stateRows(fixture, first.installId);
    assertEquals(live.length, 1);
    assertEquals(live[0].cas_version, 1);
    // The snapshot is internally consistent: its header counts the rows it holds,
    // so a write could not slip between the two.
    const snapshot = await snapshotOf(fixture, first.installId);
    assert(snapshot !== null);
    assertEquals(snapshot.rows.length, snapshot.rowCount);
  }));

Deno.test("an uninstall keeps the install, its state and its snapshot, and removes the authority", () =>
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
    const gone = await moveInstall(fixture, first.installId, {
      status: "uninstalled",
    });
    assertEquals(gone.status, "uninstalled");
    assertEquals(gone.pluginVersionId, second.versionId);
    assertEquals(await grantsOf(fixture, first.installId), []);
    // The tombstone: the row, what it pinned, its data and the way back.
    assertEquals((await stateRows(fixture, first.installId)).length, 1);
    assertEquals(
      (await snapshotOf(fixture, first.installId))?.fromVersionId,
      first.versionId,
    );

    // It cannot be moved or restored: it is finished.
    for (
      const body of [
        { versionId: first.versionId, restoreState: true },
        { versionId: first.versionId },
      ]
    ) {
      const refused = await patchInstall(fixture, first.installId, body);
      assertEquals(refused.status, 409, await refused.clone().text());
    }
    const read = await call(fixture, `/v1/plugin-installs/${first.installId}`, {
      method: "GET",
    });
    assertEquals((await read.json()).status, "uninstalled");
  }));

Deno.test("a list says, for each install on the page, its own copy and its own unreadable versions", () =>
  withPluginFixture(async (fixture, store) => {
    const moved = await installFirst(fixture, store);
    await writeState(fixture, moved.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 2, stateCompatibleFrom: 1 }),
      moved.packageId,
    );
    await moveInstall(fixture, moved.installId, {
      versionId: second.versionId,
    });
    await writeState(fixture, moved.installId, {
      key: "layout",
      value: { columns: 3 },
      schemaVersion: 2,
      expectedCasVersion: 0,
    });
    // Another package's install on the same page, never moved and holding nothing.
    const other = await installFirst(
      fixture,
      store,
      manifestOf({ name: "other-plugin" }),
      "personal",
    );

    const response = await call(fixture, "/v1/plugin-installs", {
      method: "GET",
    });
    assertEquals(response.status, 200, await response.clone().text());
    const items: {
      id: string;
      stateCopy: { versionId: string } | null;
      cannotReadVersionIds: string[];
    }[] = (await response.json()).items;
    const byId = new Map(items.map((item) => [item.id, item]));
    assertEquals(
      byId.get(moved.installId)?.stateCopy?.versionId,
      moved.versionId,
    );
    assertEquals(byId.get(moved.installId)?.cannotReadVersionIds, [
      moved.versionId,
    ]);
    assertEquals(byId.get(other.installId)?.stateCopy, null);
    assertEquals(byId.get(other.installId)?.cannotReadVersionIds, []);
  }));

Deno.test("a key a restore deleted and the plugin wrote again cannot take a number a stale writer holds", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 1 }),
      first.packageId,
    );
    // The first version leaves no state, so its snapshot has no "theme".
    await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    for (let held = 0; held < 7; held += 1) {
      await writeState(fixture, first.installId, {
        key: "theme",
        value: { theme: `v${held}` },
        schemaVersion: 1,
        expectedCasVersion: held,
      });
    }
    const before = await stateRows(fixture, first.installId);
    assertEquals(before.map((row) => row.cas_version), [7]);

    // The restore deletes the key; the plugin writes it again from absent and
    // keeps writing with whatever numbers it is given.
    const restored = await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
      restoreState: true,
    });
    assertEquals(restored.pluginVersionId, first.versionId);
    assertEquals(await stateRows(fixture, first.installId), []);
    let held = 0;
    for (let write = 0; write < 7; write += 1) {
      await writeState(fixture, first.installId, {
        key: "theme",
        value: { theme: `again${write}` },
        schemaVersion: 1,
        expectedCasVersion: held,
      });
      held = (await stateRows(fixture, first.installId))[0].cas_version;
      assert(held > 7, `write ${write} reissued ${held}`);
    }

    // A writer that read the key at 7 before the restore must not succeed.
    const stale = await putState(fixture, first.installId, {
      key: "theme",
      value: { theme: "stale" },
      schemaVersion: 1,
      expectedCasVersion: 7,
    });
    assertEquals(stale.status, 409);
    await stale.body?.cancel();
  }));

Deno.test("a restore after a restore that emptied the state issues numbers above every one issued before", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const second = await publishVersion(
      fixture,
      store,
      manifestOf({ stateSchemaVersion: 1 }),
      first.packageId,
    );
    await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
    });
    for (let held = 0; held < 3; held += 1) {
      await writeState(fixture, first.installId, {
        key: "theme",
        value: { theme: `v${held}` },
        schemaVersion: 1,
        expectedCasVersion: held,
      });
    }
    const issuedBefore = (await stateRows(fixture, first.installId))[0]
      .cas_version;

    // Restoring the first version's empty snapshot leaves no rows to count.
    await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
      restoreState: true,
    });
    assertEquals(await stateRows(fixture, first.installId), []);

    // Restoring the second version's snapshot brings "theme" back above 3.
    const forward = await moveInstall(fixture, first.installId, {
      versionId: second.versionId,
      restoreState: true,
    });
    assertEquals(forward.pluginVersionId, second.versionId);
    const after = await stateRows(fixture, first.installId);
    assertEquals(after.map((row) => row.key), ["theme"]);
    assert(
      after[0].cas_version > issuedBefore,
      `restored at ${after[0].cas_version}`,
    );
    for (let held = 1; held <= issuedBefore; held += 1) {
      const stale = await putState(fixture, first.installId, {
        key: "theme",
        value: { theme: "stale" },
        schemaVersion: 1,
        expectedCasVersion: held,
      });
      assertEquals(stale.status, 409, `a writer holding ${held}`);
      await stale.body?.cancel();
    }
  }));
