import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createGitHubAppJwt,
  GITHUB_API_VERSION,
  GitHubReadFailure,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import {
  createInstallationTokenBroker,
  TOKEN_EXPIRY_MARGIN_MS,
  type TokenTarget,
} from "../../apps/server/src/modules/integrations/token-broker.ts";
import {
  encryptInstallationSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import {
  createFakeGitHubApp,
  fakeAppKey,
  fakeRepositories,
} from "../helpers/fake-github-app.ts";

const signal = () => new AbortController().signal;

/** A fake App with one installation of `count` repositories. */
function installation(count = 3) {
  const github = createFakeGitHubApp();
  const { app } = github.issueCode({ pem: fakeAppKey.pem });
  const installed = github.addInstallation(app, {
    repositories: fakeRepositories(count, ["admin"]),
  });
  return { github, app, installed };
}

const PERMISSIONS = { metadata: "read", contents: "write" } as const;

Deno.test("mintInstallationToken presents an RS256 App JWT under ten minutes and narrows the token to stable ids and permissions", async () => {
  const { github, app, installed } = installation();
  const ids = installed.repositories.slice(0, 2).map(({ id }) => id);
  const before = Date.now();
  const minted = await github.client.mintInstallationToken({
    jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
    installationId: installed.id,
    repositoryIds: ids,
    permissions: PERMISSIONS,
  }, signal());
  assert(minted.kind === "minted");
  assertEquals(minted.repositoryIds, ids);
  assertEquals(minted.permissions, PERMISSIONS);
  assert(minted.token.startsWith("ghs_"));
  assert(minted.expiresAt > before + 59 * 60_000);
  assert(minted.expiresAt <= Date.now() + 60 * 60_000);
  assertEquals(github.tokenRequests, [{
    installationId: installed.id,
    repositoryIds: ids,
    permissions: { ...PERMISSIONS },
  }]);
  // The fake verified the JWT signature as RS256 against the App key.
  const [claims] = github.tokenJwts;
  assertEquals(claims.iss, String(app.id));
  assertEquals(claims.exp - claims.iat, 600, "GitHub's ten-minute cap");
  assert(claims.exp - claims.at <= 540, "nine minutes from now at most");
  assert(claims.iat <= claims.at);
  const [call] = github.calls;
  assertEquals(call.method, "POST");
  assertEquals(
    call.url,
    `https://api.github.com/app/installations/${installed.id}/access_tokens`,
  );
  assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
  const header = JSON.parse(
    atob(call.headers["authorization"].slice(7).split(".")[0]),
  );
  assertEquals(header, { alg: "RS256", typ: "JWT" });
});

Deno.test("mintInstallationToken reads an uncovered repository, a removed or suspended installation as refused", async () => {
  const { github, app, installed } = installation();
  const jwt = await createGitHubAppJwt(app.id, fakeAppKey.pem);
  const mint = (installationId: number, repositoryIds: number[]) =>
    github.client.mintInstallationToken({
      jwt,
      installationId,
      repositoryIds,
      permissions: PERMISSIONS,
    }, signal());
  assertEquals(await mint(installed.id, [1]), { kind: "refused" });
  assertEquals(
    await mint(installed.id + 7_777, [installed.repositories[0].id]),
    { kind: "refused" },
  );
  installed.suspendedAt = "2026-10-27T00:00:00Z";
  assertEquals(
    await mint(installed.id, [installed.repositories[0].id]),
    { kind: "refused" },
  );
  assertEquals(github.issuedTokens.length, 0);
});

Deno.test("mintInstallationToken fails closed on a 5xx and a malformed answer, revoking a malformed answer's token, and reports a rate limit by kind", async () => {
  const { github, app, installed } = installation();
  const jwt = await createGitHubAppJwt(app.id, fakeAppKey.pem);
  const mint = () =>
    github.client.mintInstallationToken({
      jwt,
      installationId: installed.id,
      repositoryIds: [installed.repositories[0].id],
      permissions: PERMISSIONS,
    }, signal());
  github.failures.tokens.add(installed.id);
  const outage = await assertRejects(() => mint(), StandardError);
  assertEquals(outage.code, "DEPENDENCY_UNAVAILABLE");
  github.failures.tokens.delete(installed.id);
  // A rate limit is never an outage or a refusal: the check answers 429.
  github.failures.rateLimited.add(installed.id);
  const limited = await assertRejects(() => mint(), GitHubReadFailure);
  assertEquals(limited.kind, "rate_limited");
  github.failures.rateLimited.delete(installed.id);
  github.failures.malformedTokens.add(installed.id);
  const error = await assertRejects(() => mint(), StandardError);
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.issuedTokens.length, 1);
  assertEquals(github.revokedTokens, github.issuedTokens);
  assert(!error.message.includes(github.issuedTokens[0]));
});

Deno.test("mintInstallationToken refuses an empty, oversized or invalid selection before GitHub", async () => {
  const { github, app, installed } = installation();
  const jwt = await createGitHubAppJwt(app.id, fakeAppKey.pem);
  for (
    const repositoryIds of [
      [],
      Array.from({ length: 501 }, (_, index) => index + 1),
      [0],
      [1.5],
    ]
  ) {
    const error = await assertRejects(
      () =>
        github.client.mintInstallationToken({
          jwt,
          installationId: installed.id,
          repositoryIds,
          permissions: PERMISSIONS,
        }, signal()),
      StandardError,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  }
  assertEquals(github.calls.length, 0);
});

Deno.test("listInstallationRepositories pages the token's repositories and keeps only their ids", async () => {
  const { github, app, installed } = installation(5);
  github.repositoryListing.pageSize = 2;
  const ids = installed.repositories.slice(0, 3).map(({ id }) => id);
  const minted = await github.client.mintInstallationToken({
    jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
    installationId: installed.id,
    repositoryIds: ids,
    permissions: PERMISSIONS,
  }, signal());
  assert(minted.kind === "minted");
  const first = await github.client.listInstallationRepositories(
    minted.token,
    1,
    signal(),
  );
  assertEquals(first, { repositoryIds: ids.slice(0, 2), hasNext: true });
  const second = await github.client.listInstallationRepositories(
    minted.token,
    2,
    signal(),
  );
  assertEquals(second, { repositoryIds: ids.slice(2), hasNext: false });
  const [listing] = github.tokenListings();
  assertEquals(listing.method, "GET");
  assertEquals(
    listing.url,
    "https://api.github.com/installation/repositories?per_page=100&page=1",
  );
  assertEquals(listing.headers["authorization"], "Bearer ghs_[redacted]");
  github.failures.malformedListing.add(installed.id);
  const malformed = await assertRejects(
    () => github.client.listInstallationRepositories(minted.token, 1, signal()),
    StandardError,
  );
  assertEquals(malformed.code, "DEPENDENCY_UNAVAILABLE");
  // GitHub answering 401 for a token it does not know rejects the token.
  const unknown = await assertRejects(
    () =>
      github.client.listInstallationRepositories("ghs_unknown", 1, signal()),
    GitHubReadFailure,
  );
  assertEquals(unknown.kind, "rejected");
});

/** A broker over the fake, with the App key sealed as installation ciphertext. */
async function brokerFixture(options: { now?: () => number } = {}) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-broker-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file, keyId: "broker-test-key-v1" };
  const key = await loadSecretKey(secretsKey);
  const secretId = crypto.randomUUID();
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision: 1, keyId: secretsKey.keyId },
    fakeAppKey.pem,
  );
  const fixture = installation();
  const broker = createInstallationTokenBroker({
    github: fixture.github.client,
    secretsKey,
    now: options.now,
  });
  const connectionId = crypto.randomUUID();
  const target = (overrides: Partial<TokenTarget> = {}): TokenTarget => ({
    connectionId,
    generation: broker.generation(connectionId),
    status: "enabled",
    installationStatus: "enabled",
    appId: fixture.app.id,
    privateKey: {
      secretId,
      revision: 1,
      keyId: secretsKey.keyId,
      ciphertext: cipher.ciphertext,
      nonce: cipher.nonce,
    },
    installationId: fixture.installed.id,
    repositoryIds: [fixture.installed.repositories[0].id],
    permissions: { ...PERMISSIONS },
    ...overrides,
  });
  return {
    ...fixture,
    broker,
    connectionId,
    target,
    [Symbol.asyncDispose]: () => Deno.remove(directory, { recursive: true }),
  };
}

Deno.test("the broker decrypts the sealed key per mint and reuses a token until five minutes before GitHub expires it", async () => {
  const start = Date.now();
  let clock = start;
  await using f = await brokerFixture({ now: () => clock });
  const first = await f.broker.token(f.target(), signal());
  assert(first.kind === "minted");
  const again = await f.broker.token(f.target(), signal());
  assertEquals(again, first, "reused from memory");
  // Order of ids and permissions does not change the key.
  const ids = f.installed.repositories.slice(0, 2).map(({ id }) => id);
  await f.broker.token(f.target({ repositoryIds: ids }), signal());
  const reordered = await f.broker.token(
    f.target({
      repositoryIds: [...ids].reverse(),
      permissions: { contents: "write", metadata: "read" },
    }),
    signal(),
  );
  assert(reordered.kind === "minted");
  assertEquals(f.github.tokenRequests.length, 2);
  // Permissions are part of the key.
  await f.broker.token(
    f.target({ permissions: { metadata: "read" } }),
    signal(),
  );
  assertEquals(f.github.tokenRequests.length, 3);
  // Reuse ends five minutes before the earlier of GitHub's expiry and an
  // hour after the mint: just before that the cached token is used, from
  // then on a new one is minted.
  const reuseUntil = Math.min(first.expiresAt, start + 3_600_000) -
    TOKEN_EXPIRY_MARGIN_MS;
  assert(reuseUntil <= first.expiresAt - TOKEN_EXPIRY_MARGIN_MS);
  clock = reuseUntil - 1;
  assertEquals(await f.broker.token(f.target(), signal()), first);
  clock = reuseUntil;
  const renewed = await f.broker.token(f.target(), signal());
  assert(renewed.kind === "minted" && renewed.token !== first.token);
  assertEquals(f.github.tokenRequests.length, 4);
});

Deno.test("the broker refuses pending, disabled and revoked connections with 409 before decrypting or calling GitHub", async () => {
  await using f = await brokerFixture();
  for (const status of ["pending", "disabled", "revoked", "unknown"]) {
    const error = await assertRejects(
      () => f.broker.token(f.target({ status }), signal()),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(
      error.params?.reason,
      status === "unknown" ? "connection_unavailable" : `connection_${status}`,
    );
  }
  assertEquals(f.github.calls.length, 0);
});

Deno.test("the broker refuses while an edit runs, after one settled, and when one runs through the signing", async () => {
  await using f = await brokerFixture();
  const stale = f.target();
  await f.broker.token(f.target(), signal());
  // An edit in progress: nothing is minted or reused.
  let finish = () => {};
  const editing = f.broker.editing(
    f.connectionId,
    () => new Promise<void>((resolve) => finish = resolve),
  );
  const during = await assertRejects(
    () => f.broker.token(f.target(), signal()),
    StandardError,
  );
  assertEquals(during.params?.reason, "connection_changed");
  finish();
  await editing;
  // A target captured before the edit is refused; a fresh one mints anew.
  const after = await assertRejects(
    () => f.broker.token(stale, signal()),
    StandardError,
  );
  assertEquals(after.params?.reason, "connection_changed");
  assertEquals(f.github.tokenRequests.length, 1);
  const fresh = f.target();
  // A full edit that starts and settles while the key is being opened and
  // the JWT signed (the broker awaits the key file first) sends no request.
  const racing = f.broker.token(fresh, signal());
  await f.broker.editing(f.connectionId, () => Promise.resolve());
  const raced = await assertRejects(() => racing, StandardError);
  assertEquals(raced.params?.reason, "connection_changed");
  assertEquals(f.github.tokenRequests.length, 1, "no token request was sent");
  // A rolled-back edit settles the same way.
  await assertRejects(() =>
    f.broker.editing(f.connectionId, () => Promise.reject(new Error("x")))
  );
  const settled = await f.broker.token(f.target(), signal());
  assert(settled.kind === "minted");
  assertEquals(f.github.tokenRequests.length, 2);
});

Deno.test("a mint in flight across an edit serves only its caller and is never reused", async () => {
  await using f = await brokerFixture();
  f.github.hooks.beforeResponse = async (request) => {
    if (!request.url.endsWith("/access_tokens")) return;
    f.github.hooks.beforeResponse = null;
    await f.broker.editing(f.connectionId, () => Promise.resolve());
  };
  const inFlight = await f.broker.token(f.target(), signal());
  assert(inFlight.kind === "minted");
  const next = await f.broker.token(f.target(), signal());
  assert(next.kind === "minted" && next.token !== inFlight.token);
  assertEquals(f.github.tokenRequests.length, 2);
});

Deno.test("the broker passes GitHub's refusal through and caches nothing for it", async () => {
  await using f = await brokerFixture();
  const refused = await f.broker.token(
    f.target({ repositoryIds: [1] }),
    signal(),
  );
  assertEquals(refused, { kind: "refused" });
  assertEquals(
    await f.broker.token(f.target({ repositoryIds: [1] }), signal()),
    { kind: "refused" },
  );
  assertEquals(
    f.github.calls.filter((call) => call.url.endsWith("/access_tokens"))
      .length,
    2,
  );
});

Deno.test("serialize runs one installation's work in order and others alongside", async () => {
  await using f = await brokerFixture();
  const order: string[] = [];
  let releaseFirst = () => {};
  const first = f.broker.serialize(1, async () => {
    order.push("a:start");
    await new Promise<void>((resolve) => releaseFirst = resolve);
    order.push("a:end");
    throw new Error("a failed");
  });
  const second = f.broker.serialize(1, () => {
    order.push("b");
    return Promise.resolve("b");
  });
  const other = await f.broker.serialize(2, () => {
    order.push("c");
    return Promise.resolve("c");
  });
  assertEquals(other, "c");
  assertEquals(order, ["a:start", "c"]);
  releaseFirst();
  await assertRejects(() => first, Error, "a failed");
  assertEquals(await second, "b", "a failure does not break the queue");
  assertEquals(order, ["a:start", "c", "a:end", "b"]);
});

Deno.test("beginEdit opens one edit window that closes once, and isCurrent follows it", async () => {
  await using f = await brokerFixture();
  const before = f.broker.generation(f.connectionId);
  assert(f.broker.isCurrent(f.connectionId, before));
  const end = f.broker.beginEdit(f.connectionId);
  assert(
    !f.broker.isCurrent(f.connectionId, f.broker.generation(f.connectionId)),
  );
  end();
  end();
  const after = f.broker.generation(f.connectionId);
  assertEquals(after, before + 2, "one bump on open, one on close");
  assert(f.broker.isCurrent(f.connectionId, after));
  assert(!f.broker.isCurrent(f.connectionId, before));
  assert((await f.broker.token(f.target(), signal())).kind === "minted");
});

Deno.test("reading generations of unknown connections creates no broker state", async () => {
  await using f = await brokerFixture();
  assertEquals(f.broker.size, 0);
  for (let index = 0; index < 50; index++) {
    const id = crypto.randomUUID();
    assertEquals(f.broker.generation(id), 0);
    assert(f.broker.isCurrent(id, 0));
    f.broker.forget(id, "ghs_unknown");
  }
  assertEquals(f.broker.size, 0, "unauthenticated reads never grow it");
  await f.broker.token(f.target(), signal());
  assertEquals(f.broker.size, 1);
});

Deno.test("a forgotten token is minted afresh on the next request", async () => {
  await using f = await brokerFixture();
  const first = await f.broker.token(f.target(), signal());
  assert(first.kind === "minted");
  f.broker.forget(f.connectionId, "ghs_other");
  assertEquals(await f.broker.token(f.target(), signal()), first);
  f.broker.forget(f.connectionId, first.token);
  const next = await f.broker.token(f.target(), signal());
  assert(next.kind === "minted" && next.token !== first.token);
  assertEquals(f.github.tokenRequests.length, 2);
});
