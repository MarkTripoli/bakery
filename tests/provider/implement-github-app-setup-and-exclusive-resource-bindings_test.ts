import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  buildGitHubAppManifest,
  createFetchGitHubAppClient,
  createGitHubAppJwt,
  GITHUB_API_VERSION,
  GITHUB_AUTHORIZE_URL,
  gitHubAppRegistrationUrl,
  gitHubAuthorizationUrl,
  gitHubOAuthCallbackUrl,
  isAllowlistedGitHubAuthorizationUrl,
  parseGitHubInstallationId,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import { pkceChallenge } from "../../apps/server/src/modules/integrations/auth-attempts.ts";
import {
  importGitHubAppPrivateKey,
  signGitHubAppJwt,
} from "../../apps/server/src/modules/integrations/github-app-key.ts";
import {
  createFakeGitHubApp,
  fakeAppKey,
  fakeRepositories,
  verifyFakeAppJwt,
} from "../helpers/fake-github-app.ts";

const signal = () => new AbortController().signal;

Deno.test("manifest conversion posts the code to the pinned GitHub endpoint without credentials", async () => {
  const github = createFakeGitHubApp();
  const { code, app } = github.issueCode();
  const converted = await github.client.convertManifest(code, signal());
  assertEquals(github.calls.length, 1);
  const [call] = github.calls;
  assertEquals(call.method, "POST");
  assertEquals(
    call.url,
    `https://api.github.com/app-manifests/${code}/conversions`,
  );
  assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
  assertEquals(GITHUB_API_VERSION, "2026-03-10");
  assertEquals(call.headers["accept"], "application/vnd.github+json");
  assertEquals(call.headers["authorization"], undefined);
  assertEquals(converted.id, app.id);
  assertEquals(converted.slug, app.slug);
  assertEquals(converted.client_id, app.clientId);
  assertEquals(converted.client_secret, app.clientSecret);
  assertEquals(converted.webhook_secret, app.webhookSecret);
  assertEquals(converted.pem, app.pem);
  assertEquals(converted.owner, {
    login: app.ownerLogin,
    id: app.ownerId,
    type: "Organization",
  });
  assertEquals(
    Object.keys(converted).includes("node_id"),
    false,
    "unknown response fields are dropped",
  );
});

Deno.test("a manifest code converts only once", async () => {
  const github = createFakeGitHubApp();
  const { code } = github.issueCode();
  await github.client.convertManifest(code, signal());
  const error = await assertRejects(
    () => github.client.convertManifest(code, signal()),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.conversionCalls().length, 2);
});

Deno.test("provider failures map to DEPENDENCY_UNAVAILABLE without echoing the body", async () => {
  const leaked = "provider-body-secret-value";
  const cases: Array<[string, () => Response]> = [
    ["404", () => Response.json({ message: leaked }, { status: 404 })],
    ["422", () => Response.json({ message: leaked }, { status: 422 })],
    ["200 instead of 201", () => Response.json({ id: 1 }, { status: 200 })],
    ["malformed JSON", () => new Response(`{${leaked}`, { status: 201 })],
    ["missing secrets", () =>
      Response.json({
        id: 1,
        slug: "x",
        name: "x",
        client_id: "x",
        html_url: "https://github.com/apps/x",
        owner: { login: "o", id: 1, type: "User" },
        permissions: {},
        events: [],
        message: leaked,
      }, { status: 201 })],
    [
      "oversized body",
      () => new Response("x".repeat(300_000), { status: 201 }),
    ],
    ["redirect", () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      })],
  ];
  for (const [label, respond] of cases) {
    const client = createFetchGitHubAppClient(() => Promise.resolve(respond()));
    const error = await assertRejects(
      () => client.convertManifest("code", signal()),
      StandardError,
      undefined,
      label,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", label);
    assert(!error.message.includes(leaked), label);
    assertEquals(error.cause, undefined, label);
  }
});

Deno.test("an aborted request never reaches GitHub's response", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createFetchGitHubAppClient((_input, init) => {
    init?.signal?.throwIfAborted();
    return Promise.resolve(Response.json({}, { status: 201 }));
  });
  const error = await assertRejects(
    () => client.convertManifest("code", controller.signal),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("unsafe codes are refused before any request so they cannot select another endpoint", async () => {
  const github = createFakeGitHubApp();
  for (
    const code of [
      "..",
      ".",
      "../../user",
      "a/b",
      "a?b",
      "a#b",
      "",
      "x".repeat(4097),
    ]
  ) {
    const error = await assertRejects(
      () => github.client.convertManifest(code, signal()),
      StandardError,
      undefined,
      code,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", code);
  }
  assertEquals(github.calls.length, 0);
});

Deno.test("the manifest derives every URL from the public base URL and turns the webhook on for the five repository events", () => {
  const manifest = buildGitHubAppManifest("https://bakery.example.test");
  assertEquals(manifest, {
    name: "Bakery",
    url: "https://bakery.example.test",
    hook_attributes: {
      url: "https://bakery.example.test/v1/webhooks/github",
      active: true,
    },
    redirect_url:
      "https://bakery.example.test/v1/integration-auth/github/manifest-callback",
    callback_urls: [
      "https://bakery.example.test/v1/integration-auth/github/callback",
    ],
    setup_url: "https://bakery.example.test/v1/integration-auth/github/setup",
    setup_on_update: true,
    public: false,
    default_permissions: {
      metadata: "read",
      issues: "write",
      contents: "write",
      pull_requests: "write",
      checks: "write",
    },
    default_events: [
      "issues",
      "pull_request",
      "check_run",
      "check_suite",
      "repository",
    ],
  });
  const custom = buildGitHubAppManifest("https://bakery.example.test", {
    name: "Acme Bakery",
    public: true,
  });
  assertEquals(custom.name, "Acme Bakery");
  assertEquals(custom.public, true);
  assertEquals("workflows" in custom.default_permissions, false);
});

Deno.test("registration URLs target the personal or organization manifest page with the state", () => {
  assertEquals(
    gitHubAppRegistrationUrl("abc_-123"),
    "https://github.com/settings/apps/new?state=abc_-123",
  );
  assertEquals(
    gitHubAppRegistrationUrl("abc", "acme-org"),
    "https://github.com/organizations/acme-org/settings/apps/new?state=abc",
  );
  for (const bad of ["../evil", "a/b", "-lead", "x".repeat(40), ""]) {
    let threw = false;
    try {
      gitHubAppRegistrationUrl("abc", bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

const authorization = {
  clientId: "Iv23liExampleClient1",
  redirectUri:
    "https://bakery.example.test/v1/integration-auth/github/callback",
  state: "A".repeat(43),
  codeChallenge: "B".repeat(43),
};

Deno.test("the authorization URL targets GitHub's authorize endpoint with exactly five parameters", () => {
  const url = gitHubAuthorizationUrl(authorization);
  const parsed = new URL(url);
  assertEquals(`${parsed.origin}${parsed.pathname}`, GITHUB_AUTHORIZE_URL);
  assertEquals(Object.fromEntries(parsed.searchParams), {
    client_id: authorization.clientId,
    redirect_uri: authorization.redirectUri,
    state: authorization.state,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256",
  });
  assert(isAllowlistedGitHubAuthorizationUrl(url, authorization));
  assertEquals(
    gitHubOAuthCallbackUrl("https://bakery.example.test"),
    authorization.redirectUri,
  );
});

Deno.test("the allowlist refuses any other host, path, client, redirect, method or parameter", () => {
  const good = new URL(gitHubAuthorizationUrl(authorization));
  const variants: ((url: URL) => void)[] = [
    (url) => url.host = "github.com.evil.test",
    (url) => url.protocol = "http:",
    (url) => url.pathname = "/login/oauth/authorize/extra",
    (url) => url.searchParams.set("client_id", "Iv23liOther"),
    (url) => url.searchParams.set("redirect_uri", "https://evil.test/cb"),
    (url) => url.searchParams.set("code_challenge_method", "plain"),
    (url) => url.searchParams.set("scope", "repo"),
    (url) => url.searchParams.append("state", "C".repeat(43)),
    (url) => url.searchParams.delete("code_challenge"),
    (url) => url.searchParams.set("state", "short"),
    (url) => url.hash = "frag",
    (url) => url.username = "user",
  ];
  for (const change of variants) {
    const url = new URL(good);
    change(url);
    assert(
      !isAllowlistedGitHubAuthorizationUrl(url.href, authorization),
      url.href,
    );
  }
  assert(!isAllowlistedGitHubAuthorizationUrl("not a url", authorization));
});

Deno.test("the PKCE challenge is the RFC 7636 S256 transform", async () => {
  // RFC 7636 Appendix B.
  assertEquals(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

/** A converted fake App plus a user grant for `installations` of it. */
async function authorizedUser(installationCount = 1) {
  const github = createFakeGitHubApp();
  const { code, app } = github.issueCode({ pem: fakeAppKey.pem });
  await github.client.convertManifest(code, signal());
  const installations = Array.from(
    { length: installationCount },
    () => github.addInstallation(app),
  );
  const verifier = "v".repeat(43);
  const redirectUri =
    "https://bakery.example.test/v1/integration-auth/github/callback";
  const authorizationUrl = gitHubAuthorizationUrl({
    clientId: app.clientId,
    redirectUri,
    state: "s".repeat(43),
    codeChallenge: await pkceChallenge(verifier),
  });
  const oauthCode = github.authorize({
    authorizationUrl,
    installationIds: installations.map((installation) => installation.id),
  });
  const exchange = {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code: oauthCode,
    codeVerifier: verifier,
    redirectUri,
  };
  github.calls.length = 0;
  return { github, app, installations, exchange };
}

Deno.test("the code exchange posts the client secret, code, PKCE verifier and fixed redirect to GitHub's token endpoint", async () => {
  const { github, app, exchange } = await authorizedUser();
  const result = await github.client.exchangeCode(exchange, signal());
  assertEquals(github.calls.length, 1);
  const [call] = github.calls;
  assertEquals(call.method, "POST");
  assertEquals(call.url, "https://github.com/login/oauth/access_token");
  assertEquals(call.headers["accept"], "application/json");
  assertEquals(call.headers["content-type"], "application/json");
  assertEquals(call.headers["x-github-api-version"], undefined);
  assertEquals(call.headers["authorization"], undefined);
  assertEquals(result, { accessToken: github.issuedTokens[0] });
  assertEquals(
    Object.keys(result),
    ["accessToken"],
    "the refresh token and every other field are dropped",
  );
  assertEquals(app.clientId, exchange.clientId);
});

Deno.test("a wrong PKCE verifier is refused and the code stays spent", async () => {
  const { github, exchange } = await authorizedUser();
  const wrong = await assertRejects(
    () =>
      github.client.exchangeCode(
        { ...exchange, codeVerifier: "w".repeat(43) },
        signal(),
      ),
    StandardError,
  );
  assertEquals(wrong.code, "DEPENDENCY_UNAVAILABLE");
  const replay = await assertRejects(
    () => github.client.exchangeCode(exchange, signal()),
    StandardError,
  );
  assertEquals(replay.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.issuedTokens, []);
});

Deno.test("a lost exchange response spends the code and surfaces no token", async () => {
  const { github, exchange } = await authorizedUser();
  github.failures.exchange = "lost";
  const lost = await assertRejects(
    () => github.client.exchangeCode(exchange, signal()),
    StandardError,
  );
  assertEquals(lost.code, "DEPENDENCY_UNAVAILABLE");
  const retry = await assertRejects(
    () => github.client.exchangeCode(exchange, signal()),
    StandardError,
  );
  assertEquals(retry.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.oauthCalls().length, 2);
});

Deno.test("the installation listing sends the user token and reports rel=next until the last page", async () => {
  const { github, installations, exchange } = await authorizedUser(5);
  github.listing.pageSize = 2;
  const { accessToken } = await github.client.exchangeCode(exchange, signal());
  github.calls.length = 0;
  const seen: number[] = [];
  let page = 1;
  while (true) {
    const result = await github.client.listUserInstallations(
      accessToken,
      page,
      signal(),
    );
    seen.push(...result.installations.map((installation) => installation.id));
    if (!result.hasNext) break;
    page += 1;
  }
  assertEquals(seen, installations.map((installation) => installation.id));
  assertEquals(
    github.calls.map((call) => call.url),
    [1, 2, 3].map((n) =>
      `https://api.github.com/user/installations?per_page=100&page=${n}`
    ),
  );
  for (const call of github.calls) {
    assertEquals(call.headers["authorization"], `Bearer ${accessToken}`);
    assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
  }
  const [first] = (await github.client.listUserInstallations(
    accessToken,
    1,
    signal(),
  )).installations;
  assertEquals(first, {
    id: installations[0].id,
    appId: installations[0].appId,
    account: installations[0].account,
    repositorySelection: "selected",
    permissions: installations[0].permissions,
    suspended: false,
  });
});

Deno.test("the listing never follows a provider-supplied next URL", async () => {
  const urls: string[] = [];
  const client = createFetchGitHubAppClient((input, init) => {
    urls.push(new Request(input, init).url);
    return Promise.resolve(
      Response.json({ total_count: 0, installations: [] }, {
        headers: { link: '<https://evil.example.test/steal>; rel="next"' },
      }),
    );
  });
  const result = await client.listUserInstallations("ghu_x", 1, signal());
  assertEquals(result.hasNext, true);
  assertEquals(urls, [
    "https://api.github.com/user/installations?per_page=100&page=1",
  ]);
  const bad = await assertRejects(
    () => client.listUserInstallations("ghu_x", 0, signal()),
    StandardError,
  );
  assertEquals(bad.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(urls.length, 1);
});

Deno.test("getInstallation sends a verifiable RS256 App JWT whose issuer is the App id", async () => {
  const { github, app, installations } = await authorizedUser();
  for (const privateKeyPem of [fakeAppKey.pem, fakeAppKey.pkcs8Pem]) {
    github.calls.length = 0;
    const installation = await github.client.getInstallation({
      appId: app.id,
      privateKeyPem,
      installationId: installations[0].id,
    }, signal());
    assertEquals(installation.id, installations[0].id);
    assertEquals(installation.appId, app.id);
    const [call] = github.calls;
    assertEquals(
      call.url,
      `https://api.github.com/app/installations/${installations[0].id}`,
    );
    const jwt = call.headers["authorization"].replace(/^Bearer /, "");
    const claims = await verifyFakeAppJwt(jwt);
    assert(claims, "signature verifies with the App public key");
    assertEquals(claims.iss, String(app.id));
    assertEquals(claims.exp - claims.iat, 600);
  }
  const now = Date.UTC(2026, 9, 26, 12);
  const claims = await verifyFakeAppJwt(
    await createGitHubAppJwt(app.id, fakeAppKey.pem, now),
  );
  assertEquals(claims, {
    iat: now / 1000 - 60,
    exp: now / 1000 + 540,
    iss: String(app.id),
  });
});

Deno.test("getInstallation refuses another App's installation, a bad key and a suspended flag is reported", async () => {
  const { github, app, installations } = await authorizedUser();
  const other = github.addInstallation({ ...app, id: app.id + 1 });
  const foreign = await assertRejects(
    () =>
      github.client.getInstallation({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: other.id,
      }, signal()),
    StandardError,
  );
  assertEquals(foreign.code, "DEPENDENCY_UNAVAILABLE");
  const calls = github.calls.length;
  const badKey = await assertRejects(
    () =>
      github.client.getInstallation({
        appId: app.id,
        privateKeyPem: app.pem.replace("RSA PRIVATE KEY", "EC PRIVATE KEY"),
        installationId: installations[0].id,
      }, signal()),
    StandardError,
  );
  assertEquals(badKey.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.calls.length, calls, "an unusable key makes no request");
  installations[0].suspendedAt = "2026-10-26T12:00:00Z";
  const suspended = await github.client.getInstallation({
    appId: app.id,
    privateKeyPem: fakeAppKey.pem,
    installationId: installations[0].id,
  }, signal());
  assertEquals(suspended.suspended, true);
});

Deno.test("unsafe codes and installation ids are refused before any request", async () => {
  const { github, exchange } = await authorizedUser();
  for (const code of ["", "../x", "a/b", "a?b", "a".repeat(513)]) {
    const error = await assertRejects(
      () => github.client.exchangeCode({ ...exchange, code }, signal()),
      StandardError,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  }
  assertEquals(github.calls.length, 0);
  for (
    const value of ["", "0", "-1", "01", "1.5", "1e3", "9".repeat(17), "x"]
  ) {
    assertEquals(parseGitHubInstallationId(value), null, value);
  }
  assertEquals(parseGitHubInstallationId("51234567"), 51_234_567);
  const error = await assertRejects(
    () =>
      github.client.getInstallation({
        appId: 1,
        privateKeyPem: fakeAppKey.pem,
        installationId: 0,
      }, signal()),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.calls.length, 0);
});

Deno.test("provider failures with a user token never echo the token or the body", async () => {
  const token = "ghu_secret_token_value";
  const client = createFetchGitHubAppClient(() =>
    Promise.resolve(
      Response.json({ message: `bad ${token}` }, { status: 401 }),
    )
  );
  const error = await assertRejects(
    () => client.listUserInstallations(token, 1, signal()),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  assert(!JSON.stringify(error).includes(token));
  assert(!String(error.message).includes(token));
  assert(!String(error.cause ?? "").includes(token));
});

Deno.test("repository listing pages every result with the user token and reports only the user's admin grant", async () => {
  const { github, app, installations, exchange } = await authorizedUser();
  const [installation] = installations;
  installation.repositories = fakeRepositories(7, [
    "admin",
    "maintain",
    "write",
    "triage",
    "read",
    null,
    "admin",
  ]);
  github.repositoryListing.pageSize = 3;
  const { accessToken } = await github.client.exchangeCode(exchange, signal());
  github.calls.length = 0;
  const seen = [];
  for (let page = 1;; page++) {
    const result = await github.client.listUserInstallationRepositories(
      accessToken,
      installation.id,
      page,
      signal(),
    );
    seen.push(...result.repositories);
    if (!result.hasNext) break;
  }
  assertEquals(
    seen,
    installation.repositories.map((repository) => ({
      id: repository.id,
      fullName: `${installation.account.login}/${repository.name}`,
      private: repository.private,
      archived: repository.archived,
      admin: repository.permissions?.admin === true,
    })),
  );
  assertEquals(
    seen.map((repository) => repository.admin),
    [true, false, false, false, false, false, true],
    "maintain, write, triage, read and a missing permissions object are not admin",
  );
  assertEquals(
    github.calls.map((call) => call.url),
    [1, 2, 3].map((n) =>
      `https://api.github.com/user/installations/${installation.id}/repositories?per_page=100&page=${n}`
    ),
  );
  for (const call of github.calls) {
    assertEquals(call.headers["authorization"], `Bearer ${accessToken}`);
    assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
  }
  // An installation the user token cannot see is refused, not listed.
  const other = github.addInstallation(app);
  const hidden = await assertRejects(
    () =>
      github.client.listUserInstallationRepositories(
        accessToken,
        other.id,
        1,
        signal(),
      ),
    StandardError,
  );
  assertEquals(hidden.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("repository listing accepts a full page of real-sized repository objects", async () => {
  const filler = "x".repeat(6_000);
  const client = createFetchGitHubAppClient(() =>
    Promise.resolve(Response.json({
      total_count: 100,
      repositories: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        full_name: `bakery-org/repo-${index}`,
        private: false,
        archived: false,
        description: filler,
        permissions: { admin: index === 0, push: true, pull: true },
      })),
    }))
  );
  const result = await client.listUserInstallationRepositories(
    "ghu_x",
    7,
    1,
    signal(),
  );
  assertEquals(result.repositories.length, 100);
  assertEquals(result.hasNext, false);
  assertEquals(
    result.repositories.filter((repository) => repository.admin).length,
    1,
  );
});

Deno.test("repository listing refuses unsafe names, bad pages and provider next URLs", async () => {
  const urls: string[] = [];
  let fullName = "bakery-org/ok.repo_1";
  const client = createFetchGitHubAppClient((input, init) => {
    urls.push(new Request(input, init).url);
    return Promise.resolve(
      Response.json({
        total_count: 1,
        repositories: [{
          id: 1,
          full_name: fullName,
          private: true,
          permissions: { admin: true },
        }],
      }, {
        headers: { link: '<https://evil.example.test/steal>; rel="next"' },
      }),
    );
  });
  const ok = await client.listUserInstallationRepositories(
    "ghu_x",
    9,
    1,
    signal(),
  );
  assertEquals(ok.hasNext, true);
  assertEquals(ok.repositories, [{
    id: 1,
    fullName: "bakery-org/ok.repo_1",
    private: true,
    archived: false,
    admin: true,
  }]);
  assertEquals(urls, [
    "https://api.github.com/user/installations/9/repositories?per_page=100&page=1",
  ]);
  for (
    const unsafe of [
      "bakery-org/..",
      "bakery-org/.",
      "bakery-org/a/b",
      "-bakery/repo",
      "bakery-org/repo?x=1",
      "evil.example.test/repo",
      "bakery-org",
    ]
  ) {
    fullName = unsafe;
    const refused = await assertRejects(
      () => client.listUserInstallationRepositories("ghu_x", 9, 1, signal()),
      StandardError,
    );
    assertEquals(refused.code, "DEPENDENCY_UNAVAILABLE", unsafe);
  }
  urls.length = 0;
  for (const [installationId, page] of [[0, 1], [9, 0], [1.5, 1]]) {
    const bad = await assertRejects(
      () =>
        client.listUserInstallationRepositories(
          "ghu_x",
          installationId,
          page,
          signal(),
        ),
      StandardError,
    );
    assertEquals(bad.code, "DEPENDENCY_UNAVAILABLE");
  }
  assertEquals(urls, [], "a bad installation id or page is never sent");
});

Deno.test("GET /app sends a bearer RS256 App JWT GitHub verifies against the App's key", async () => {
  const github = createFakeGitHubApp();
  const app = await github.createExistingApp();
  for (const pem of [app.pkcs1Pem, app.pkcs8Pem]) {
    const key = await importGitHubAppPrivateKey(pem);
    const now = new Date();
    const jwt = await signGitHubAppJwt(key, app.id, now);
    const lookup = await github.client.getApp(jwt, signal());
    assertEquals(lookup.kind, "confirmed");
    if (lookup.kind !== "confirmed") continue;
    assertEquals(lookup.app.id, app.id);
    assertEquals(lookup.app.client_id, app.clientId);
    assertEquals(lookup.app.slug, app.slug);
    assertEquals(
      Object.keys(lookup.app).includes("installations_count"),
      false,
      "unknown response fields are dropped",
    );
    const call = github.calls.at(-1)!;
    assertEquals(call.method, "GET");
    assertEquals(call.url, "https://api.github.com/app");
    assertEquals(call.headers["authorization"], `Bearer ${jwt}`);
    assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
    assertEquals(call.headers["accept"], "application/vnd.github+json");
    const { header, payload } = github.verifiedJwts.at(-1)!;
    assertEquals(header, { alg: "RS256", typ: "JWT" });
    const seconds = Math.floor(now.getTime() / 1000);
    assertEquals(payload, {
      iat: seconds - 60,
      exp: seconds + 540,
      iss: String(app.id),
    });
  }
});

Deno.test("GET /app refusals are rejected; other failures are DEPENDENCY_UNAVAILABLE without the body", async () => {
  const leaked = "provider-body-secret-value";
  const app = await createFakeGitHubApp().createExistingApp();
  const jwt = await signGitHubAppJwt(
    await importGitHubAppPrivateKey(app.pkcs1Pem),
    app.id,
  );
  for (const status of [401, 403, 404]) {
    const client = createFetchGitHubAppClient(() =>
      Promise.resolve(Response.json({ message: leaked }, { status }))
    );
    assertEquals(await client.getApp(jwt, signal()), { kind: "rejected" });
  }
  const cases: Array<[string, () => Response]> = [
    ["500", () => Response.json({ message: leaked }, { status: 500 })],
    ["429", () => Response.json({ message: leaked }, { status: 429 })],
    ["rate-limited 403", () =>
      Response.json({ message: leaked }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })],
    ["403 with retry-after", () =>
      Response.json({ message: leaked }, {
        status: 403,
        headers: { "retry-after": "60" },
      })],
    ["malformed JSON", () => new Response(`{${leaked}`, { status: 200 })],
    [
      "missing identity",
      () => Response.json({ id: 1, message: leaked }, { status: 200 }),
    ],
    ["redirect", () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      })],
  ];
  for (const [label, respond] of cases) {
    const client = createFetchGitHubAppClient(() => Promise.resolve(respond()));
    const error = await assertRejects(
      () => client.getApp(jwt, signal()),
      StandardError,
      undefined,
      label,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", label);
    assert(!error.message.includes(leaked), label);
    assertEquals(error.cause, undefined, label);
  }
});

Deno.test("a malformed private key is refused without echoing it", async () => {
  const github = createFakeGitHubApp();
  const app = await github.createExistingApp();
  const body = app.pkcs1Pem.split("\n")[1];
  for (
    const pem of [
      "",
      body,
      app.pkcs1Pem.replace("RSA PRIVATE KEY-----\n", "RSA PRIVATE KEY-----\n!"),
      app.pkcs1Pem.replace("END RSA PRIVATE KEY", "END PRIVATE KEY"),
      app.pkcs8Pem.replace(/\n[^-][^\n]*\n/, "\nAAAA\n"),
    ]
  ) {
    const error = await assertRejects(
      () => importGitHubAppPrivateKey(pem),
      StandardError,
    );
    assertEquals(error.code, "MALFORMED_REQUEST");
    assert(!JSON.stringify(error.params).includes(body));
    assert(!error.message.includes(body));
  }
  assertEquals(github.calls.length, 0);
});

Deno.test("getInstallation reports the account id a reconnect compares, stable across a same-account reinstall", async () => {
  const { github, app, installations } = await authorizedUser();
  const original = installations[0];
  const reinstalled = github.addInstallation(app, {
    account: {
      ...original.account,
      login: `${original.account.login}-renamed`,
    },
  });
  const other = github.addInstallation(app);
  const read = (installationId: number) =>
    github.client.getInstallation({
      appId: app.id,
      privateKeyPem: fakeAppKey.pem,
      installationId,
    }, signal());
  const [first, second, third] = [
    await read(original.id),
    await read(reinstalled.id),
    await read(other.id),
  ];
  // The bind keys identity on the numeric account id, never the login.
  assertEquals(first.account.id, original.account.id);
  assertEquals(second.account.id, first.account.id);
  assert(second.id !== first.id, "a reinstall is a new installation id");
  assert(second.account.login !== first.account.login);
  assert(third.account.id !== first.account.id);
});

Deno.test("isRepositoryCovered reads the installation, then asks for a metadata-only token narrowed to the one repository id", async () => {
  const { github, app, installations } = await authorizedUser();
  const [installation] = installations;
  installation.repositories = fakeRepositories(3, ["admin"]);
  const [target] = installation.repositories;
  const covered = await github.client.isRepositoryCovered({
    appId: app.id,
    privateKeyPem: fakeAppKey.pem,
    installationId: installation.id,
    repositoryId: target.id,
  }, signal());
  assertEquals(covered, true);
  assertEquals(github.calls.map((call) => [call.method, call.url]), [
    ["GET", `https://api.github.com/app/installations/${installation.id}`],
    [
      "POST",
      `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    ],
    ["DELETE", "https://api.github.com/installation/token"],
  ]);
  // The narrowed token is revoked at once, authenticated by itself.
  const [token] = github.issuedTokens.filter((value) =>
    value.startsWith("ghs_")
  );
  assertEquals(github.revokedTokens, [token]);
  assertEquals(
    github.calls[2].headers["authorization"],
    "Bearer ghs_[redacted]",
    "the fake's log never keeps the token",
  );
  for (const call of github.calls.slice(0, 2)) {
    const claims = await verifyFakeAppJwt(
      call.headers["authorization"].replace(/^Bearer /, ""),
    );
    assert(claims, "each call carries a verifiable App JWT");
    assertEquals(claims.iss, String(app.id));
    assertEquals(call.headers["x-github-api-version"], GITHUB_API_VERSION);
  }
  assertEquals(github.tokenRequests, [{
    installationId: installation.id,
    repositoryIds: [target.id],
    permissions: { metadata: "read" },
  }]);
});

Deno.test("isRepositoryCovered is false for a removed, suspended, foreign or uncovering installation", async () => {
  const { github, app, installations } = await authorizedUser();
  const [installation] = installations;
  installation.repositories = fakeRepositories(2, ["admin"]);
  const [kept, removed] = installation.repositories;
  const check = (installationId: number, repositoryId: number) =>
    github.client.isRepositoryCovered({
      appId: app.id,
      privateKeyPem: fakeAppKey.pem,
      installationId,
      repositoryId,
    }, signal());
  // The installation no longer covers the repository: GitHub refuses the
  // narrowed token with 422.
  installation.repositories = [kept];
  assertEquals(await check(installation.id, removed.id), false);
  assertEquals(await check(installation.id, kept.id), true);
  // An unknown or uninstalled installation is 404 on the read.
  github.calls.length = 0;
  assertEquals(await check(installation.id + 10_000_000, kept.id), false);
  assertEquals(github.calls.length, 1, "no token is asked for");
  // Another App's installation is not visible to this App's JWT.
  const foreign = github.addInstallation({ ...app, id: app.id + 1 }, {
    repositories: [kept],
  });
  assertEquals(await check(foreign.id, kept.id), false);
  // Suspended between the read and the token request: GitHub's 403 fails
  // closed as not covered.
  github.hooks.beforeResponse = (request) => {
    if (request.url.endsWith("/access_tokens")) {
      installation.suspendedAt = "2026-10-27T12:00:00Z";
    }
    return Promise.resolve();
  };
  assertEquals(await check(installation.id, kept.id), false);
  github.hooks.beforeResponse = null;
  installation.suspendedAt = null;
  // A suspended installation is refused before any token is asked for.
  installation.suspendedAt = "2026-10-27T12:00:00Z";
  github.calls.length = 0;
  assertEquals(await check(installation.id, kept.id), false);
  assertEquals(github.calls.length, 1, "no token is asked for");
  assertEquals(github.tokenRequests.length, 1, "one narrowed token in all");
  assertEquals(github.revokedTokens.length, 1);
});

Deno.test("isRepositoryCovered answers concurrent checks of one installation repository alike, so Bakery alone decides who selects it", async () => {
  const { github, app, installations } = await authorizedUser();
  const [installation] = installations;
  installation.repositories = fakeRepositories(1, ["admin"]);
  const [shared] = installation.repositories;
  // Two organizations' connections share the installation; GitHub has no
  // notion of either and covers the repository for both requests at once.
  const covered = await Promise.all(
    [1, 2].map(() =>
      github.client.isRepositoryCovered({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: installation.id,
        repositoryId: shared.id,
      }, signal())
    ),
  );
  assertEquals(covered, [true, true]);
  assertEquals(
    github.tokenRequests,
    [1, 2].map(() => ({
      installationId: installation.id,
      repositoryIds: [shared.id],
      permissions: { metadata: "read" },
    })),
  );
  // Each check gets, and revokes, its own narrowed token.
  const tokens = github.issuedTokens.filter((value) =>
    value.startsWith("ghs_")
  );
  assertEquals(new Set(tokens).size, 2);
  assertEquals(new Set(github.revokedTokens), new Set(tokens));
});

Deno.test("isRepositoryCovered maps provider failures to DEPENDENCY_UNAVAILABLE and refuses unsafe ids before any request", async () => {
  const { github, app, installations } = await authorizedUser();
  const [installation] = installations;
  installation.repositories = fakeRepositories(1, ["admin"]);
  const [repository] = installation.repositories;
  github.failures.tokens.add(installation.id);
  const failed = await assertRejects(
    () =>
      github.client.isRepositoryCovered({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: installation.id,
        repositoryId: repository.id,
      }, signal()),
    StandardError,
  );
  assertEquals(failed.code, "DEPENDENCY_UNAVAILABLE");
  assert(!failed.message.includes("Server Error"), "no provider body");
  // A rate-limited 403 is a failure, not "not covered".
  github.failures.tokens.delete(installation.id);
  github.failures.rateLimited.add(installation.id);
  const throttled = await assertRejects(
    () =>
      github.client.isRepositoryCovered({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: installation.id,
        repositoryId: repository.id,
      }, signal()),
    StandardError,
  );
  assertEquals(throttled.code, "DEPENDENCY_UNAVAILABLE");
  github.failures.rateLimited.delete(installation.id);
  github.calls.length = 0;
  for (
    const [installationId, repositoryId] of [
      [0, repository.id],
      [installation.id, 0],
      [installation.id, 1.5],
      [Number.MAX_SAFE_INTEGER + 2, repository.id],
    ]
  ) {
    const error = await assertRejects(
      () =>
        github.client.isRepositoryCovered({
          appId: app.id,
          privateKeyPem: fakeAppKey.pem,
          installationId,
          repositoryId,
        }, signal()),
      StandardError,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  }
  assertEquals(github.calls.length, 0);
  // A failed revocation does not change the answer: the token expires.
  const unrevoked = createFetchGitHubAppClient((input, init) =>
    new Request(input, init).method === "DELETE"
      ? Promise.resolve(Response.json({ message: "nope" }, { status: 500 }))
      : github.fetch(input, init)
  );
  github.failures.tokens.delete(installation.id);
  assertEquals(
    await unrevoked.isRepositoryCovered({
      appId: app.id,
      privateKeyPem: fakeAppKey.pem,
      installationId: installation.id,
      repositoryId: repository.id,
    }, signal()),
    true,
  );
  // A malformed token answer still has its token revoked.
  const malformed = createFetchGitHubAppClient(async (input, init) => {
    const response = await github.fetch(input, init);
    if (!new Request(input, init).url.endsWith("/access_tokens")) {
      return response;
    }
    const { token } = await response.json();
    return Response.json({ token, repositories: "not a list" }, {
      status: 201,
    });
  });
  const revokedBefore = github.revokedTokens.length;
  const broken = await assertRejects(
    () =>
      malformed.isRepositoryCovered({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: installation.id,
        repositoryId: repository.id,
      }, signal()),
    StandardError,
  );
  assertEquals(broken.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(github.revokedTokens.length, revokedBefore + 1);
  // A redirect, as GitHub answers for a moved resource, is never followed.
  const redirecting = createFetchGitHubAppClient(() =>
    Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/elsewhere" },
      }),
    )
  );
  const moved = await assertRejects(
    () =>
      redirecting.isRepositoryCovered({
        appId: app.id,
        privateKeyPem: fakeAppKey.pem,
        installationId: installation.id,
        repositoryId: repository.id,
      }, signal()),
    StandardError,
  );
  assertEquals(moved.code, "DEPENDENCY_UNAVAILABLE");
});
