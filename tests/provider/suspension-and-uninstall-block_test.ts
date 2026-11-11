import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createGitHubAppJwt,
  GitHubReadFailure,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import {
  installationTransition,
  type ObservedInstallation,
} from "../../apps/server/src/modules/integrations/reconcile.ts";
import {
  connectionFanOut,
  InstallationStatus,
} from "../../apps/server/src/modules/integrations/installation-fan-out.ts";
import {
  createFakeGitHubApp,
  fakeAppKey,
  fakeRepositories,
} from "../helpers/fake-github-app.ts";

const signal = () => new AbortController().signal;

function installation() {
  const github = createFakeGitHubApp();
  const { app } = github.issueCode({ pem: fakeAppKey.pem });
  const installed = github.addInstallation(app, {
    repositories: fakeRepositories(2, ["admin"]),
  });
  return { github, app, installed };
}

Deno.test("readInstallationState reads active, suspended and deleted installations with App authority", async () => {
  const { github, app, installed } = installation();
  const read = async () =>
    await github.client.readInstallationState({
      jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
      installationId: installed.id,
    }, signal());
  const active = await read();
  assert(active.kind === "present");
  assertEquals(active.installation.id, installed.id);
  assertEquals(active.installation.appId, app.id);
  assertEquals(active.installation.suspended, false);
  github.setInstallationState(installed.id, "suspended");
  const suspended = await read();
  assert(suspended.kind === "present");
  assertEquals(suspended.installation.suspended, true);
  github.setInstallationState(installed.id, "deleted");
  assertEquals(await read(), { kind: "absent" });
  assertEquals(github.installationReads().length, 3);
});

Deno.test("readInstallationState treats a provider failure or a rejected JWT as unavailable, never as deleted", async () => {
  const { github, app, installed } = installation();
  github.failures.installationReads.add(installed.id);
  const failed = await assertRejects(async () =>
    await github.client.readInstallationState({
      jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
      installationId: installed.id,
    }, signal())
  );
  assert(failed instanceof StandardError);
  assertEquals(failed.code, "DEPENDENCY_UNAVAILABLE");
  github.failures.installationReads.clear();
  const rejected = await assertRejects(() =>
    github.client.readInstallationState({
      jwt: "not-a-jwt",
      installationId: installed.id,
    }, signal())
  );
  assert(rejected instanceof StandardError);
  assertEquals(rejected.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("the installation state machine moves only along GitHub's observation and keeps revoked terminal", () => {
  const observed: ObservedInstallation[] = ["active", "suspended", "deleted"];
  const table = Object.fromEntries(
    Object.values(InstallationStatus).map((status) => [
      status,
      observed.map((seen) => installationTransition(status, seen)),
    ]),
  );
  assertEquals(table, {
    pending: ["enabled", "suspended", "revoked"],
    enabled: [null, "suspended", "revoked"],
    suspended: ["enabled", null, "revoked"],
    revoked: [null, null, null],
  });
});

Deno.test("fan-out changes a connection's status only on revoke and never re-enables a disabled one", () => {
  for (const status of ["pending", "enabled", "disabled"]) {
    const connection = { status, health: "healthy" };
    assertEquals(connectionFanOut(connection, "suspended"), {
      status,
      health: "degraded",
      problem: "installation_suspended",
    });
    assertEquals(connectionFanOut(connection, "enabled"), {
      status,
      health: "unknown",
      problem: null,
    });
    assertEquals(connectionFanOut(connection, "revoked"), {
      status: "revoked",
      health: "unknown",
      problem: "installation_revoked",
    });
  }
});

Deno.test("mintDiscoveryToken asks for an unnarrowed metadata-read token and revokeInstallationToken revokes it", async () => {
  const { github, app, installed } = installation();
  const minted = await github.client.mintDiscoveryToken({
    jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
    installationId: installed.id,
  }, signal());
  assert(minted.kind === "minted");
  assertEquals(github.tokenRequests, [{
    installationId: installed.id,
    repositoryIds: [],
    permissions: { metadata: "read" },
  }]);
  const page = await github.client.listInstallationRepositories(
    minted.token,
    1,
    signal(),
  );
  assertEquals(
    page.repositoryIds,
    installed.repositories.map((repository) => repository.id),
    "every covered repository",
  );
  await github.client.revokeInstallationToken(minted.token);
  assertEquals(github.revokedTokens, [minted.token]);
  // Revoking again never throws.
  await github.client.revokeInstallationToken(minted.token);
});

Deno.test("mintDiscoveryToken is refused for a suspended or deleted installation", async () => {
  const { github, app, installed } = installation();
  const jwt = await createGitHubAppJwt(app.id, fakeAppKey.pem);
  github.setInstallationState(installed.id, "suspended");
  assertEquals(
    await github.client.mintDiscoveryToken({
      jwt,
      installationId: installed.id,
    }, signal()),
    { kind: "refused" },
  );
  github.setInstallationState(installed.id, "deleted");
  assertEquals(
    await github.client.mintDiscoveryToken({
      jwt,
      installationId: installed.id,
    }, signal()),
    { kind: "refused" },
  );
});

Deno.test("a repository listing rate limited midway fails that page, never answers it empty", async () => {
  const { github, app, installed } = installation();
  github.repositoryListing.pageSize = 1;
  github.failures.listingFailsAt.set(installed.id, { page: 2, status: 429 });
  const minted = await github.client.mintDiscoveryToken({
    jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
    installationId: installed.id,
  }, signal());
  assert(minted.kind === "minted");
  const first = await github.client.listInstallationRepositories(
    minted.token,
    1,
    signal(),
  );
  assertEquals(first.hasNext, true);
  // A 429 is a classified rate limit (#487), never an empty page.
  const failed = await assertRejects(
    () => github.client.listInstallationRepositories(minted.token, 2, signal()),
    GitHubReadFailure,
  );
  assertEquals(failed.kind, "rate_limited");
});
