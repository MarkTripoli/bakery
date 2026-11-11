import { assertEquals } from "@std/assert";
import {
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  patchResource,
  postCheck,
  postDiscovery,
} from "../helpers/github-app-registration.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";
import { staleDiscoveries } from "../../apps/server/src/modules/integrations/discoveries.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    f.github.hooks.beforeResponse = null;
    await f.finish();
  }
}

async function installation(f: GitHubAppFixture, connectionId: string) {
  return (await f.pgDatabase.query<
    { id: string; status: string; version: number }
  >(
    `select installation.id, installation.status, installation.version
       from bakery.integration_installations as installation
       join bakery.integration_connections as connection
         on connection.installation_id = installation.id
      where connection.id = $1`,
    [connectionId],
  )).rows[0];
}

const INSTALLATION_READ =
  /^https:\/\/api\.github\.com\/app\/installations\/[0-9]+$/;

Deno.test("concurrent reconciles of one suspension transition the installation once and fan out once", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const before = await installation(f, connectionId);
    const connectionVersion = (await f.pgDatabase.query<{ version: number }>(
      "select version from bakery.integration_connections where id = $1",
      [connectionId],
    )).rows[0].version;
    f.github.setInstallationState(fake.id, "suspended");
    // Both reconciles read the same row version and GitHub state before
    // either writes.
    let arrived = 0;
    let release = () => {};
    const together = new Promise<void>((resolve) => release = resolve);
    f.github.hooks.beforeResponse = async (request) => {
      if (request.method !== "GET" || !INSTALLATION_READ.test(request.url)) {
        return;
      }
      arrived += 1;
      if (arrived === 2) release();
      await together;
    };
    const outcomes = await Promise.all([
      f.reconcile(before.id),
      f.reconcile(before.id),
    ]);
    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    assertEquals(kinds, ["superseded", "transitioned"]);
    const after = await installation(f, connectionId);
    assertEquals(after.status, "suspended");
    assertEquals(after.version, before.version + 1, "one compare-and-swap won");
    const connection = (await f.pgDatabase.query<{ version: number }>(
      "select version from bakery.integration_connections where id = $1",
      [connectionId],
    )).rows[0];
    assertEquals(connection.version, connectionVersion + 1);
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationInstallations.reconcile'
            and resource_id = $1`,
        [connectionId],
      ),
      1,
    );
  });
});

Deno.test("a token GitHub mints while a suspension commits is never cached or used", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const row = await installation(f, connectionId);
    // The suspension lands while the check's token request is in flight:
    // GitHub minted before it suspended the installation.
    let reconciled = false;
    f.github.hooks.beforeResponse = async (request) => {
      if (reconciled || !request.url.endsWith("/access_tokens")) return;
      reconciled = true;
      f.github.setInstallationState(fake.id, "suspended");
      await f.reconcile(row.id);
      f.github.setInstallationState(fake.id, "active");
    };
    const raced = await postCheck(f, connectionId);
    const body = await raced.json();
    assertEquals(raced.status, 409, JSON.stringify(body));
    assertEquals(body.reason, "connection_changed");
    assertEquals(f.github.tokenRequests.length, 1);
    assertEquals(f.github.tokenListings().length, 0, "the token was not used");
    f.github.hooks.beforeResponse = null;

    // While the row says suspended nothing mints; after the unsuspend the
    // next check mints afresh: the raced token was never cached.
    const suspended = await postCheck(f, connectionId);
    assertEquals(suspended.status, 409);
    await suspended.body?.cancel();
    assertEquals((await f.reconcile(row.id)).kind, "transitioned");
    const fresh = await postCheck(f, connectionId);
    assertEquals(fresh.status, 200, await fresh.clone().text());
    await fresh.body?.cancel();
    assertEquals(f.github.tokenRequests.length, 2, "minted again");
  });
});

Deno.test("a stale unsuspend observation never overwrites a newer revoke", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const row = await installation(f, connectionId);
    f.github.setInstallationState(fake.id, "suspended");
    await f.reconcile(row.id);
    f.github.setInstallationState(fake.id, "active");
    // The older reconcile reads the suspended row, then GitHub says active;
    // before it writes, a newer reconcile observes the deletion and commits.
    let held = true;
    f.github.hooks.beforeResponse = async (request) => {
      if (!held || !INSTALLATION_READ.test(request.url)) return;
      held = false;
      f.github.setInstallationState(fake.id, "deleted");
      const newer = await f.reconcile(row.id);
      assertEquals(newer.kind, "transitioned");
      // The held read answers what GitHub said before the deletion.
      f.github.setInstallationState(fake.id, "active");
    };
    const older = await f.reconcile(row.id);
    assertEquals(older.kind, "superseded");
    const after = await installation(f, connectionId);
    assertEquals(after.status, "revoked");
    const connection = (await f.pgDatabase.query<{ status: string }>(
      "select status from bakery.integration_connections where id = $1",
      [connectionId],
    )).rows[0];
    assertEquals(connection.status, "revoked");
  });
});

async function queued(f: GitHubAppFixture, connectionId: string) {
  const response = await postDiscovery(f, connectionId);
  const body = await response.json();
  assertEquals(response.status, 202, JSON.stringify(body));
  return body.discoveryId as string;
}

async function availability(f: GitHubAppFixture, connectionId: string) {
  return (await f.pgDatabase.query<
    { external_id: string; available: boolean; version: number }
  >(
    `select external_id, available, version from bakery.integration_resources
      where connection_id = $1 order by external_id`,
    [connectionId],
  )).rows;
}

Deno.test("a partial scan that fails midway leaves the inventory untouched", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f, {
      repositories: fakeRepositories(4, ["admin"]),
    });
    const before = await availability(f, connectionId);
    f.github.repositoryListing.pageSize = 2;
    f.github.failures.listingFailsAt.set(fake.id, { page: 2, status: 502 });
    // A repository vanished, and page two fails: nothing marked unavailable.
    fake.repositories.splice(0, 1);
    const result = await f.discover(await queued(f, connectionId));
    assertEquals(result.kind === "finished" && result.status, "partial");
    assertEquals(await availability(f, connectionId), before);
  });
});

Deno.test("an edit committed during a scan keeps the scan from writing availability", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake, resources } =
      await enabledConnection(f, {
        repositories: fakeRepositories(3, ["admin"]),
      });
    fake.repositories.pop();
    const discoveryId = await queued(f, connectionId);
    let edited = false;
    f.github.hooks.beforeResponse = async (request) => {
      if (edited || !request.url.includes("/installation/repositories?")) {
        return;
      }
      edited = true;
      // An Admin selects a second repository while GitHub lists.
      const response = await patchResource(f, connectionId, resources[1].id, {
        selected: true,
      });
      assertEquals(response.status, 200, await response.text());
    };
    const result = await f.discover(discoveryId);
    assertEquals(result, {
      kind: "finished",
      status: "partial",
      outcome: "connection_changed",
      unavailable: 0,
      restored: 0,
    });
    // Only the Admin's edit moved a row: availability is as before the scan.
    assertEquals(
      (await availability(f, connectionId)).map((row) => row.available),
      [true, true, true],
    );
  });
});

Deno.test("a discovery left running by a crash is sent again and resumed", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f, {
      repositories: fakeRepositories(2, ["admin"]),
    });
    const discoveryId = await queued(f, connectionId);
    // SYNTHETIC: the run claimed the row and died before finishing.
    await f.pgDatabase.query(
      `update bakery.integration_discoveries
          set status = 'running', started_at = now() - interval '1 hour',
              updated_at = now() - interval '1 hour',
              not_before = now() - interval '1 hour'
        where id = $1`,
      [discoveryId],
    );
    const stale = await staleDiscoveries(f.runtimePgDatabase!, 1000);
    assertEquals(stale.some((row) => row.id === discoveryId), true);
    // Touched: not sent again until it is stale once more.
    const again = await staleDiscoveries(f.runtimePgDatabase!, 1000);
    assertEquals(again.some((row) => row.id === discoveryId), false);
    fake.repositories.pop();
    const result = await f.discover(discoveryId);
    assertEquals(result.kind === "finished" && result.status, "completed");
    // A replayed event after completion does nothing.
    assertEquals(await f.discover(discoveryId), { kind: "skipped" });
  });
});

Deno.test("a failed scan token request finishes the discovery instead of leaving it running", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f);
    const before = await availability(f, connectionId);
    const discoveryId = await queued(f, connectionId);
    f.github.failures.tokens.add(fake.id);
    const result = await f.discover(discoveryId);
    assertEquals(result, {
      kind: "finished",
      status: "partial",
      outcome: "dependency_unavailable",
      unavailable: 0,
      restored: 0,
    });
    const status = (await f.pgDatabase.query<{ status: string }>(
      "select status from bakery.integration_discoveries where id = $1",
      [discoveryId],
    )).rows[0].status;
    assertEquals(status, "partial");
    assertEquals(await availability(f, connectionId), before);
  });
});

Deno.test("an edit another server process commits during a scan keeps the scan from writing availability", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation: fake } = await enabledConnection(f, {
      repositories: fakeRepositories(3, ["admin"]),
    });
    fake.repositories.pop();
    const discoveryId = await queued(f, connectionId);
    let edited = false;
    f.github.hooks.beforeResponse = async (request) => {
      if (edited || !request.url.includes("/installation/repositories?")) {
        return;
      }
      edited = true;
      // SYNTHETIC: another process's committed edit; this process's broker
      // generation does not move.
      await f.pgDatabase.query(
        `update bakery.integration_connections
            set version = version + 1 where id = $1`,
        [connectionId],
      );
    };
    const result = await f.discover(discoveryId);
    assertEquals(
      result.kind === "finished" && result.outcome,
      "connection_changed",
    );
    assertEquals(
      (await availability(f, connectionId)).map((row) => row.available),
      [true, true, true],
    );
  });
});
