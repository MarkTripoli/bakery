import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  connectionVersion,
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  patchConnection,
  patchResource,
  pendingConnection,
  postCheck,
  readConnection,
  secondOrganization,
} from "../helpers/github-app-registration.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

type ConnectionState = {
  status: string;
  health: string;
  version: number;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastProblemCode: string | null;
};

async function connectionState(
  f: GitHubAppFixture,
  connectionId: string,
): Promise<ConnectionState> {
  return (await f.pgDatabase.query<ConnectionState>(
    `select status, health, version, last_checked_at as "lastCheckedAt",
       last_success_at as "lastSuccessAt",
       last_problem_code as "lastProblemCode"
       from bakery.integration_connections where id = $1`,
    [connectionId],
  )).rows[0];
}

async function ok(response: Response) {
  const body = await response.text();
  assertEquals(response.status, 200, body);
  return contractSchemas.ConnectionCheck.parse(JSON.parse(body));
}

async function problem(response: Response, status: number, code: string) {
  const body = await response.text();
  assertEquals(response.status, status, body);
  const parsed = JSON.parse(body);
  assertEquals(parsed.code, code, body);
  return parsed as { code: string; reason?: string };
}

/** Domain events of one type for one connection. */
function healthEvents(f: GitHubAppFixture, connectionId: string) {
  return count(
    f,
    `select count(*) from bakery.domain_events
      where organization_id = $1 and event_type = 'integration.health_changed'
        and aggregate_id = $2`,
    [f.organizationId, connectionId],
  );
}

Deno.test("an Admin's check mints a token narrowed to the selected repositories and granted permissions and returns a ConnectionCheck", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, selected } = await enabledConnection(
      f,
      { repositories: fakeRepositories(4, ["admin"]), selected: 2 },
    );
    const before = await connectionState(f, connectionId);
    assertEquals(before.health, "unknown");
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, true);
    assertEquals(check.fault, null);
    assertEquals(check.capabilities, [
      "contents:write",
      "issues:write",
      "metadata:read",
    ]);
    assert(Math.abs(Date.parse(check.checkedAt) - Date.now()) < 60_000);
    // Exactly one token, narrowed to the two selected stable ids and the
    // connection's granted permissions; never the unselected repositories.
    assertEquals(f.github.tokenRequests, [{
      installationId: installation.id,
      repositoryIds: selected.map((row) => Number(row.external_id)).sort((
        a,
        b,
      ) => a - b),
      permissions: installation.permissions,
    }]);
    // The probe is read-only: one token request, then GETs.
    assertEquals(
      f.github.calls.map((call) => call.method),
      ["POST", "GET"],
    );
    assertEquals(f.github.tokenListings().length, 1);
    const after = await connectionState(f, connectionId);
    assertEquals(after.status, "enabled", "the lifecycle status is unchanged");
    assertEquals(after.health, "healthy");
    assertEquals(after.version, before.version + 1, "health moved");
    assertEquals(after.lastProblemCode, null);
    assert(after.lastCheckedAt !== null && after.lastSuccessAt !== null);
    assertEquals(await healthEvents(f, connectionId), 1);
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationConnections.check'
            and resource_id = $1 and organization_id = $2`,
        [connectionId, f.organizationId],
      ),
      1,
    );
    const read = await (await readConnection(f, connectionId)).json();
    assertEquals(read.status, "enabled");
    assertEquals(read.version, after.version);
  });
});

Deno.test("a second check reuses the cached token and moves neither version nor event while health holds", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const first = await connectionState(f, connectionId);
    const second = await ok(await postCheck(f, connectionId));
    assertEquals(second.healthy, true);
    assertEquals(f.github.tokenRequests.length, 1, "one mint, reused");
    assertEquals(f.github.tokenListings().length, 2, "each check probes");
    const after = await connectionState(f, connectionId);
    assertEquals(after.version, first.version);
    assertEquals(after.health, "healthy");
    assert(after.lastCheckedAt! >= first.lastCheckedAt!);
    assertEquals(await healthEvents(f, connectionId), 1);
  });
});

Deno.test("a replayed Idempotency-Key returns the stored check without a GitHub call", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const key = crypto.randomUUID();
    const first = await ok(await postCheck(f, connectionId, { key }));
    const calls = f.github.calls.length;
    const replay = await ok(await postCheck(f, connectionId, { key }));
    assertEquals(replay, first);
    assertEquals(f.github.calls.length, calls);
    await problem(
      await postCheck(f, connectionId, { key: null }),
      428,
      "PRECONDITION_REQUIRED",
    );
    assertEquals(f.github.calls.length, calls, "refused before GitHub");
  });
});

Deno.test("a repository the installation no longer covers makes the check unhealthy and the connection degraded", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, selected } = await enabledConnection(
      f,
      { repositories: fakeRepositories(3, ["admin"]), selected: 2 },
    );
    // GitHub refuses to narrow a token to a repository it no longer covers.
    installation.repositories = installation.repositories.filter((repository) =>
      repository.id !== Number(selected[0].external_id)
    );
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, false);
    assertEquals(check.fault, null, "the probe completed");
    assertEquals(check.capabilities, []);
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "enabled");
    assertEquals(state.health, "degraded");
    assertEquals(state.lastProblemCode, "token_refused");
    const read = await (await readConnection(f, connectionId)).json();
    assertEquals(read.status, "degraded", "the client folds health in");
    assertEquals(await healthEvents(f, connectionId), 1);
  });
});

Deno.test("a repository removed after the token was minted reads as missing on the next check", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation, selected } = await enabledConnection(
      f,
      { repositories: fakeRepositories(3, ["admin"]), selected: 2 },
    );
    await ok(await postCheck(f, connectionId));
    installation.repositories = installation.repositories.filter((repository) =>
      repository.id !== Number(selected[1].external_id)
    );
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, false);
    assertEquals(f.github.tokenRequests.length, 1, "the cached token probed");
    const state = await connectionState(f, connectionId);
    assertEquals(state.health, "degraded");
    assertEquals(state.lastProblemCode, "repository_missing");
  });
});

Deno.test("permissions GitHub granted below the connection's grant make the check unhealthy", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.failures.downgraded.add(installation.id);
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, false);
    assertEquals(check.capabilities, [
      "contents:read",
      "issues:read",
      "metadata:read",
    ]);
    assertEquals(
      (await connectionState(f, connectionId)).lastProblemCode,
      "permission_missing",
    );
  });
});

Deno.test("a provider outage returns a redacted fault and leaves health unchanged", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    const healthy = await connectionState(f, connectionId);
    // A fresh token is needed: a selection edit drops the cached one.
    f.github.failures.tokens.add(installation.id);
    await patchConnection(f, connectionId, { name: "Renamed" }).then((r) =>
      r.body?.cancel()
    );
    const check = await ok(await postCheck(f, connectionId));
    assertEquals(check.healthy, false);
    assertEquals(check.capabilities, []);
    assertEquals(check.fault?.code, "DEPENDENCY_UNAVAILABLE");
    const state = await connectionState(f, connectionId);
    assertEquals(state.health, "healthy", "an incomplete probe proves nothing");
    assertEquals(
      state.version,
      healthy.version + 1,
      "only the rename moved it",
    );
    assertEquals(state.lastProblemCode, "dependency_unavailable");
    assertEquals(await healthEvents(f, connectionId), 1);
    // A listing outage after a successful mint is a fault as well.
    f.github.failures.tokens.delete(installation.id);
    f.github.failures.tokenListing.add(installation.id);
    const listing = await ok(await postCheck(f, connectionId));
    assertEquals(listing.fault?.code, "DEPENDENCY_UNAVAILABLE");
  });
});

Deno.test("a pending connection refuses the check with 409 before any GitHub call", async () => {
  await withFixture(async (f) => {
    const pending = await pendingConnection(f);
    const refused = await problem(
      await postCheck(f, pending.connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(refused.reason, "connection_pending");
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("a disabled connection refuses the check with 409 before any key or GitHub call", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    await patchConnection(f, connectionId, { enabled: false }).then((r) =>
      r.body?.cancel()
    );
    const before = await connectionState(f, connectionId);
    const disabled = await problem(
      await postCheck(f, connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(disabled.reason, "connection_disabled");
    assertEquals(f.github.calls.length, 0, "no token is minted");
    assertEquals(f.github.tokenJwts.length, 0, "no App JWT is signed");
    const after = await connectionState(f, connectionId);
    assertEquals(after, before, "nothing is written");
  });
});

Deno.test("a revoked connection or an inactive installation refuses the check with 409", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    // No API revokes yet (#488); the row is set as GitHub revocation will.
    await f.pgDatabase.query(
      `update bakery.integration_connections set status = 'revoked'
        where id = $1`,
      [connectionId],
    );
    const revoked = await problem(
      await postCheck(f, connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(revoked.reason, "connection_revoked");
    await f.pgDatabase.query(
      `update bakery.integration_connections set status = 'enabled'
        where id = $1`,
      [connectionId],
    );
    await f.pgDatabase.query(
      `update bakery.integration_installations set status = 'suspended'
        where id = (select installation_id from bakery.integration_connections
          where id = $1)`,
      [connectionId],
    );
    const suspended = await problem(
      await postCheck(f, connectionId),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(suspended.reason, "installation_unavailable");
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("a disable committed while a queued check waits behind another mints nothing for it", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    // Check A holds the installation's queue inside its mint; check B reads
    // enabled, then waits behind A. The disable commits meanwhile.
    let release = () => {};
    const held = new Promise<void>((resolve) => release = resolve);
    let arrived = () => {};
    const minting = new Promise<void>((resolve) => arrived = resolve);
    f.github.hooks.beforeResponse = async (request) => {
      if (!request.url.endsWith("/access_tokens")) return;
      arrived();
      await held;
    };
    const first = postCheck(f, connectionId);
    await minting;
    const second = postCheck(f, connectionId);
    // Let B finish its first read and join the queue.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const disable = await patchConnection(f, connectionId, { enabled: false });
    assertEquals(disable.status, 200, await disable.text());
    release();
    const [a, b] = await Promise.all([first, second]);
    f.github.hooks.beforeResponse = null;
    // A minted before the disable; the edit moved the broker's generation,
    // so A stops right after the mint. B never mints.
    const bodyA = await a.text();
    assertEquals(a.status, 409, bodyA);
    assertEquals(JSON.parse(bodyA).reason, "connection_changed");
    assertEquals(f.github.tokenListings().length, 0, "A never probed");
    const bodyB = await b.text();
    assertEquals(b.status, 409, bodyB);
    assertEquals(f.github.tokenRequests.length, 1, "only A reached GitHub");
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "disabled");
    assertEquals(state.health, "unknown", "no refused result was stored");
  });
});

Deno.test("changing the selection stops reuse of the token minted for the previous selection", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources, installation } = await enabledConnection(
      f,
      { repositories: fakeRepositories(3, ["admin"]) },
    );
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 1);
    const added = await patchResource(f, connectionId, resources[1].id, {
      selected: true,
    });
    assertEquals(added.status, 200, await added.text());
    f.github.tokenRequests.length = 0;
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 1, "a fresh token");
    assertEquals(
      f.github.tokenRequests[0].repositoryIds,
      [resources[0], resources[1]].map((row) => Number(row.external_id)).sort(
        (a, b) => a - b,
      ),
    );
    // Deselecting back to the first selection mints again rather than
    // reviving the first token.
    const removed = await patchResource(f, connectionId, resources[1].id, {
      selected: false,
    });
    assertEquals(removed.status, 200, await removed.text());
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 2);
    assertEquals(f.github.tokenRequests[1], {
      installationId: installation.id,
      repositoryIds: [Number(resources[0].external_id)],
      permissions: installation.permissions,
    });
    // Disable then enable also drops the cache.
    for (const enabled of [false, true]) {
      const response = await patchConnection(f, connectionId, { enabled });
      assertEquals(response.status, 200, await response.text());
    }
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 3);
  });
});

Deno.test("a selection edit committed while GitHub mints keeps that token out of reuse", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await enabledConnection(f, {
      repositories: fakeRepositories(3, ["admin"]),
    });
    let edited: Promise<Response> | null = null;
    f.github.hooks.beforeResponse = async (request) => {
      if (!request.url.endsWith("/access_tokens") || edited !== null) return;
      edited = patchResource(f, connectionId, resources[1].id, {
        selected: true,
      });
      // The edit's version bump commits while GitHub is minting.
      await (await edited).text();
    };
    const raced = await postCheck(f, connectionId);
    f.github.hooks.beforeResponse = null;
    const body = await raced.text();
    assertEquals(raced.status, 409, body);
    assertEquals(JSON.parse(body).reason, "connection_changed");
    assertEquals(
      f.github.tokenListings().length,
      0,
      "the raced token is never used for the probe",
    );
    assertEquals((await edited!)?.status, 200);
    const mints = f.github.tokenRequests.length;
    // The selection-recheck mint and the raced mint are both spent; the next
    // check mints for the new selection.
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, mints + 1);
    assertEquals(
      f.github.tokenRequests.at(-1)!.repositoryIds,
      [resources[0], resources[1]].map((row) => Number(row.external_id)).sort(
        (a, b) => a - b,
      ),
    );
  });
});

Deno.test("a Developer cannot check, and another organization's connection is hidden", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    await problem(
      await postCheck(f, connectionId, { cookie: f.developerCookie }),
      403,
      "AUTH_FORBIDDEN",
    );
    const other = await secondOrganization(f);
    await problem(
      await postCheck(f, connectionId, { organizationId: other }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(f.github.calls.length, 0);
    assertEquals(await connectionVersion(f, connectionId) > 0, true);
  });
});

Deno.test("an unauthorized edit attempt while GitHub mints does not disturb the check", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    let refused: Response | null = null;
    f.github.hooks.beforeResponse = async (request) => {
      if (!request.url.endsWith("/access_tokens") || refused !== null) return;
      refused = await patchConnection(f, connectionId, { enabled: false }, {
        cookie: f.developerCookie,
      });
    };
    const check = await ok(await postCheck(f, connectionId));
    f.github.hooks.beforeResponse = null;
    assertEquals(refused!.status, 403, await refused!.text());
    assertEquals(check.healthy, true, "only an authorized edit invalidates");
    // And the token it minted is reused.
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 1);
  });
});

Deno.test("a token GitHub fails a probe with is not reused by the next check", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await ok(await postCheck(f, connectionId));
    assertEquals(f.github.tokenRequests.length, 1);
    // GitHub revokes the cached token: the probe's 401 drops it and the
    // same check mints its one replacement.
    f.github.revokedTokens.push(f.github.issuedTokens.at(-1)!);
    const refreshed = await ok(await postCheck(f, connectionId));
    assertEquals(refreshed.healthy, true);
    assertEquals(f.github.tokenRequests.length, 2, "one replacement");
    // A failing listing drops the token too: the check after the outage
    // mints afresh and reports the real outcome.
    f.github.failures.tokenListing.add(installation.id);
    const failed = await ok(await postCheck(f, connectionId));
    assertEquals(failed.fault?.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(f.github.tokenRequests.length, 2, "the cached token probed");
    f.github.failures.tokenListing.delete(installation.id);
    assertEquals((await ok(await postCheck(f, connectionId))).healthy, true);
    assertEquals(f.github.tokenRequests.length, 3);
  });
});
