import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createGitHubAppJwt,
  GitHubReadFailure,
  gitHubRetryAfterSeconds,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import {
  createFakeGitHubApp,
  FAKE_PROVIDER_CANARY,
  fakeAppKey,
  type FakeFailureScript,
  fakeRepositories,
} from "../helpers/fake-github-app.ts";

const signal = () => new AbortController().signal;

const PERMISSIONS = { metadata: "read", contents: "write" } as const;

/** A fake App with one installation, a client with a short deadline. */
async function minted(requestTimeoutMs = 500) {
  const github = createFakeGitHubApp({ requestTimeoutMs });
  const { app } = github.issueCode({ pem: fakeAppKey.pem });
  const installed = github.addInstallation(app, {
    repositories: fakeRepositories(2, ["admin"]),
  });
  const mint = async () =>
    await github.client.mintInstallationToken({
      jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
      installationId: installed.id,
      repositoryIds: installed.repositories.map(({ id }) => id),
      permissions: PERMISSIONS,
    }, signal());
  const token = await mint();
  assert(token.kind === "minted");
  return { github, installed, mint, token: token.token };
}

/** Everything a failure exposes to a caller that logs or serializes it. */
function surface(error: Error): string {
  return [
    error.name,
    error.message,
    error.stack ?? "",
    JSON.stringify(error),
    String(error.cause ?? ""),
  ].join("\n");
}

Deno.test("listInstallationRepositories classifies 401, 403 permission loss, 403 rate limit, 429 and a timeout as redacted GitHubReadFailures", async () => {
  const cases: [FakeFailureScript, string, number | null][] = [
    ["unauthorized", "rejected", null],
    ["forbidden", "forbidden", null],
    ["rate_limited", "rate_limited", 120],
    ["quota", "rate_limited", 30],
    ["hang", "timeout", null],
  ];
  for (const [script, kind, wait] of cases) {
    const { github, installed, token } = await minted();
    github.failures.tokenListingScripts.set(installed.id, script);
    const error = await assertRejects(
      () => github.client.listInstallationRepositories(token, 1, signal()),
      GitHubReadFailure,
    );
    assertEquals(error.kind, kind, script);
    if (wait === null) assertEquals(error.retryAfterSeconds, null, script);
    else {
      assert(
        error.retryAfterSeconds !== null &&
          error.retryAfterSeconds >= wait - 2 &&
          error.retryAfterSeconds <= wait,
        `${script}: ${error.retryAfterSeconds}`,
      );
    }
    assertEquals(error.message, "GITHUB_READ_FAILURE");
    assert(!surface(error).includes(FAKE_PROVIDER_CANARY), script);
    assert(!surface(error).includes(token), script);
  }
});

Deno.test("a revoked installation token reads as rejected, never as an outage", async () => {
  const { github, token } = await minted();
  github.revokedTokens.push(token);
  const error = await assertRejects(
    () => github.client.listInstallationRepositories(token, 1, signal()),
    GitHubReadFailure,
  );
  assertEquals(error.kind, "rejected");
});

Deno.test("mintInstallationToken reports a 429, a rate-limited 403 and a timeout by kind, and keeps a JWT refusal an outage", async () => {
  const { github, installed, mint } = await minted();
  github.failures.tokenScripts.set(installed.id, "quota");
  const quota = await assertRejects(() => mint(), GitHubReadFailure);
  assertEquals([quota.kind, quota.retryAfterSeconds], ["rate_limited", 30]);
  github.failures.tokenScripts.delete(installed.id);
  github.failures.rateLimited.add(installed.id);
  const limited = await assertRejects(() => mint(), GitHubReadFailure);
  assertEquals([limited.kind, limited.retryAfterSeconds], ["rate_limited", 60]);
  github.failures.rateLimited.delete(installed.id);
  github.failures.tokenScripts.set(installed.id, "hang");
  const hung = await assertRejects(() => mint(), GitHubReadFailure);
  assertEquals(hung.kind, "timeout");
  github.failures.tokenScripts.delete(installed.id);
  // GitHub refusing the App JWT (401) is not a rejected installation token.
  const refused = await assertRejects(
    () =>
      github.client.mintInstallationToken({
        jwt: "not-a-jwt",
        installationId: installed.id,
        repositoryIds: [installed.repositories[0].id],
        permissions: PERMISSIONS,
      }, signal()),
    StandardError,
  );
  assertEquals(refused.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("a caller that goes away is not a provider timeout", async () => {
  const { github, installed, token } = await minted(5_000);
  github.failures.tokenListingScripts.set(installed.id, "hang");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const error = await assertRejects(
    () =>
      github.client.listInstallationRepositories(token, 1, controller.signal),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("gitHubRetryAfterSeconds reads Retry-After seconds or date, then x-ratelimit-reset, bounded to 1..3600 with a one-minute default", () => {
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  const wait = (headers: Record<string, string>) =>
    gitHubRetryAfterSeconds(new Headers(headers), now);
  assertEquals(wait({ "retry-after": "45" }), 45);
  assertEquals(
    wait({ "retry-after": new Date(now + 90_000).toUTCString() }),
    90,
  );
  assertEquals(wait({ "x-ratelimit-reset": String(now / 1000 + 300) }), 300);
  // Retry-After wins over the primary reset.
  assertEquals(
    wait({ "retry-after": "5", "x-ratelimit-reset": String(now / 1000 + 300) }),
    5,
  );
  assertEquals(wait({}), 60);
  assertEquals(wait({ "retry-after": "0" }), 1);
  assertEquals(wait({ "retry-after": "999999" }), 3600);
  assertEquals(wait({ "x-ratelimit-reset": String(now / 1000 - 10) }), 1);
  assertEquals(wait({ "retry-after": "soon" }), 60);
  assertEquals(wait({ "x-ratelimit-reset": "later" }), 60);
});
