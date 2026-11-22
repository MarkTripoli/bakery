import { assertEquals } from "@std/assert";
import {
  asCookie,
  type Fixture,
  inviteColleague,
  secondOrganization,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  grantsOf,
  installFirst,
  manifestOf,
  moveInstall,
  pinnedVersion,
  publishVersion,
  snapshotOf,
  stateRows,
  writeState,
} from "../helpers/plugin-upgrade-fixture.ts";

/**
 * Who may move an install, and what a move cannot do (#34, B14.03, AC2).
 *
 * A move is where an install's authority changes, so each case asserts the
 * authority afterwards, from the tables: the version it pins, the grants it
 * holds and whether a copy of its state was taken. A refusal that changed any
 * of them would be the finding; the status code alone could not show it.
 */

const WIDER = ["state.read", "state.write", "jobs.schedule"];

async function untouched(
  fixture: Fixture,
  installId: string,
  versionId: string,
) {
  assertEquals(await pinnedVersion(fixture, installId), versionId);
  assertEquals(await grantsOf(fixture, installId), [
    "state.read",
    "state.write",
  ]);
  assertEquals(await snapshotOf(fixture, installId), null);
}

Deno.test("a Developer cannot move, approve for or restore an organization install", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    const developer = asCookie(
      fixture,
      await inviteColleague(fixture, "developer"),
    );
    for (
      const body of [
        { versionId: wider.versionId },
        { versionId: wider.versionId, approveCapabilities: ["jobs.schedule"] },
        { versionId: wider.versionId, restoreState: true },
      ]
    ) {
      const refused = await developer(
        `/v1/plugin-installs/${first.installId}`,
        {
          method: "PATCH",
          body,
        },
      );
      assertEquals(refused.status, 403, JSON.stringify(body));
    }
    await untouched(fixture, first.installId, first.versionId);
  }));

Deno.test("an Admin who is not the owner cannot move or restore a personal install, and learns nothing about it", () =>
  withPluginFixture(async (fixture, store) => {
    // The owner is the fixture's admin; the colleague has Admin too.
    const first = await installFirst(fixture, store, manifestOf(), "personal");
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    const admin = asCookie(fixture, await inviteColleague(fixture, "admin"));
    for (
      const body of [
        { versionId: wider.versionId, approveCapabilities: ["jobs.schedule"] },
        { versionId: wider.versionId, restoreState: true },
      ]
    ) {
      const refused = await admin(`/v1/plugin-installs/${first.installId}`, {
        method: "PATCH",
        body,
      });
      // Not found, as for every other route to somebody else's personal install.
      assertEquals(refused.status, 404, JSON.stringify(body));
    }
    await untouched(fixture, first.installId, first.versionId);
  }));

Deno.test("another organization cannot move an install it does not own", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    const other = await secondOrganization(fixture);
    // The admin is a member of the second organization, so only the tenant
    // predicate keeps the install out of reach.
    const refused = await fetchAs(
      fixture,
      other.organizationId,
      first.installId,
      {
        versionId: wider.versionId,
        approveCapabilities: ["jobs.schedule"],
      },
    );
    assertEquals(refused.status, 404, await refused.clone().text());
    await untouched(fixture, first.installId, first.versionId);
  }));

function fetchAs(
  fixture: Fixture,
  organizationId: string,
  installId: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/plugin-installs/${installId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          Cookie: fixture.adminCookie,
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
    ),
  ));
}

Deno.test("an approved move of a disabled install gives it no authority", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store);
    await moveInstall(fixture, first.installId, { status: "disabled" });
    assertEquals(await grantsOf(fixture, first.installId), []);
    const wider = await publishVersion(
      fixture,
      store,
      manifestOf({ requestedCapabilities: WIDER }),
      first.packageId,
    );
    const moved = await moveInstall(fixture, first.installId, {
      versionId: wider.versionId,
      approveCapabilities: ["jobs.schedule"],
    });
    // The install is on the new version and still off: an approval is consent
    // to a version, not a way to turn authority on.
    assertEquals(moved.pluginVersionId, wider.versionId);
    assertEquals(moved.status, "disabled");
    assertEquals(await grantsOf(fixture, first.installId), []);
  }));

Deno.test("restoring a personal install's state keeps every row with its owner", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await installFirst(fixture, store, manifestOf(), "personal");
    await writeState(fixture, first.installId, {
      key: "theme",
      value: { theme: "dark" },
      schemaVersion: 1,
      expectedCasVersion: 0,
    });
    const owners = async () =>
      (await fixture.pgDatabase.query<{ owner_principal_id: string | null }>(
        `select owner_principal_id from bakery.plugin_state
          where organization_id = $1 and plugin_install_id = $2`,
        [fixture.organizationId, first.installId],
      )).rows.map((row) => row.owner_principal_id);
    const before = await owners();
    assertEquals(before.length, 1);
    assertEquals(before[0] !== null, true);

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
      key: "extra",
      value: { n: 1 },
      schemaVersion: 2,
      expectedCasVersion: 0,
    });
    await moveInstall(fixture, first.installId, {
      versionId: first.versionId,
      restoreState: true,
    });
    // The snapshot and the restore carry the owner: the row is still private to
    // the member it was written for, and is not shared by the move.
    assertEquals(await owners(), before);
    assertEquals((await stateRows(fixture, first.installId)).length, 1);
    const snapshot = await fixture.pgDatabase.query<
      { owner_principal_id: string | null }
    >(
      `select s.owner_principal_id
         from bakery.plugin_install_snapshot_state s
         join bakery.plugin_install_snapshots h
           on h.organization_id = s.organization_id
          and h.id = s.plugin_install_snapshot_id
        where h.organization_id = $1 and h.plugin_install_id = $2`,
      [fixture.organizationId, first.installId],
    );
    assertEquals(
      snapshot.rows.every((row) => row.owner_principal_id !== null),
      true,
    );
  }));
