import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  call,
  type Fixture,
  type Json,
  seed,
} from "../helpers/account-settings.ts";
import {
  authRequest,
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  enrollTotp,
  get,
  openAuthFixture,
  signSessionCookie,
  userIdFor,
} from "../helpers/auth.ts";
import {
  authorize,
  authorizeUrl,
  callTool,
  connectClient,
  consentQuery,
  exchangeCode,
  mcpRequest,
  type McpResult,
  OAUTH_ISSUER,
  pkcePair,
  registerTestClient,
  submitConsent,
  TEST_REDIRECT_URI,
} from "../helpers/oauth-mcp.ts";

type Claims = Record<string, unknown>;

function decodeClaims(token: string): Claims {
  return JSON.parse(
    atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
  );
}

/** Signs `claims` with the provider's own live key, so only the claim under test can fail. */
async function signClaims(fixture: Fixture, claims: Claims): Promise<string> {
  const signed = await fixture.auth.api.signJWT({
    body: { payload: claims },
  }) as { token: string };
  return signed.token;
}

async function cleanup(
  fixture: Fixture,
  emails: readonly string[],
  clientIds: readonly string[],
) {
  await fixture.pgDatabase.query(
    `delete from bakery.oauth_grant_revocations
      where user_id in (select id from public."user" where email = any($1::text[]))`,
    [emails],
  );
  await fixture.pgDatabase.query(
    `delete from bakery.oauth_grant_activity
      where user_id in (select id from public."user" where email = any($1::text[]))`,
    [emails],
  );
  await fixture.pgDatabase.query(
    `delete from public.verification
      where position('"type":"authorization_code"' in value) > 0
        and position('"client_id":"' in value) > 0
        and exists (
          select 1 from unnest($1::text[]) as client_id
          where position('"client_id":' || to_json(client_id)::text in value) > 0
        )`,
    [clientIds],
  );
  await cleanupAuthFixture(fixture.pgDatabase, emails);
  await fixture.pgDatabase.query(
    'delete from public."oauthClient" where "clientId" = any($1::text[])',
    [clientIds],
  );
}

async function expectRejected(
  fixture: Fixture,
  token: string,
  expected: { status: number; error: string },
) {
  const response = await callTool(fixture, token, "whoami");
  assertEquals(response.status, expected.status, await response.clone().text());
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert(challenge.startsWith("Bearer "), challenge);
  assert(
    challenge.includes(
      `resource_metadata="${authTestOrigin}/.well-known/oauth-protected-resource/mcp"`,
    ),
  );
  assert(challenge.includes(`error="${expected.error}"`), challenge);
  const body = await response.json() as Json;
  assertEquals(body.result, undefined, "no tool result before dispatch");
}

Deno.test("tokens with a wrong audience, issuer, expiry, client, subject or signature are refused before dispatch", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    assertEquals(
      (await callTool(fixture, accessToken, "whoami")).status,
      200,
    );
    const valid = decodeClaims(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const invalid = { status: 401, error: "invalid_token" };
    const withClaims = (change: Claims, drop: string[] = []) => {
      const claims: Claims = { ...valid, ...change };
      for (const name of drop) delete claims[name];
      return signClaims(fixture, claims);
    };

    // The same claims re-signed prove the fixture is sound before each negative.
    assertEquals(
      (await callTool(fixture, await withClaims({}), "whoami")).status,
      200,
    );
    for (
      const [label, token] of [
        [
          "wrong audience",
          await withClaims({ aud: `${authTestOrigin}/other` }),
        ],
        [
          "wrong issuer",
          await withClaims({ iss: "https://evil.example/api/auth" }),
        ],
        ["expired", await withClaims({ iat: now - 7200, exp: now - 3600 })],
        ["missing azp", await withClaims({}, ["azp"])],
        ["blank azp", await withClaims({ azp: "" })],
        ["missing organization", await withClaims({}, ["organization_id"])],
        [
          "non-uuid organization",
          await withClaims({ organization_id: "acme" }),
        ],
        ["non-uuid subject", await withClaims({ sub: "someone" })],
        [
          "sender-constrained",
          await withClaims({ cnf: { jkt: "thumbprint" } }),
        ],
        ["other client", await withClaims({ azp: "other-client" })],
        [
          "other organization",
          await withClaims({
            organization_id: crypto.randomUUID(),
          }),
        ],
      ] as const
    ) {
      const response = await callTool(fixture, token, "whoami");
      assertEquals(response.status, invalid.status, label);
      assert(
        (response.headers.get("www-authenticate") ?? "").includes(
          `error="${invalid.error}"`,
        ),
        label,
      );
      assertEquals((await response.json() as Json).result, undefined, label);
    }

    const [header, payload, signature] = accessToken.split(".");
    const flipped = signature.slice(0, -2) +
      (signature.endsWith("AA") ? "BB" : "AA");
    await expectRejected(fixture, `${header}.${payload}.${flipped}`, invalid);
    const unsigned = `${
      btoa(JSON.stringify({ alg: "none", typ: "at+jwt" })).replace(/=+$/, "")
    }.${payload}.`;
    await expectRejected(fixture, unsigned, invalid);
    await expectRejected(fixture, "not-a-jwt", invalid);
    // Header-only rewrite keeps the payload and signature but changes what is signed.
    const tamperedPayload = btoa(
      JSON.stringify({ ...valid, scope: "bakery:read bakery:operate extra" }),
    ).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    await expectRejected(
      fixture,
      `${header}.${tamperedPayload}.${signature}`,
      invalid,
    );
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("insufficient scope is a 403 challenge, never a tool result", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const valid = decodeClaims(accessToken);
    for (const scope of ["", "openid"]) {
      const token = await signClaims(fixture, { ...valid, scope });
      const response = await callTool(fixture, token, "whoami");
      assertEquals(response.status, 403, `scope "${scope}"`);
      const challenge = response.headers.get("www-authenticate") ?? "";
      assert(challenge.includes('error="insufficient_scope"'), challenge);
      assert(challenge.includes('scope="bakery:read"'), challenge);
      assertEquals((await response.json() as Json).result, undefined);
    }
    // A broader bundle covers the read tool.
    const broader = await signClaims(fixture, {
      ...valid,
      scope: "bakery:operate",
    });
    assertEquals((await callTool(fixture, broader, "whoami")).status, 200);
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("MCP reflects live viewer reads and guest non-enumerating denial", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const setRole = async (role: "viewer" | "guest") => {
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships as membership
            set role = $1
           from bakery.principals as principal
           join public."user" as provider_user
             on provider_user.id = principal.provider_user_id
          where membership.principal_id = principal.id
            and membership.organization_id = $2
            and provider_user.email = $3`,
        [role, seeded.organizationId, seeded.adminEmail],
      );
    };

    await setRole("viewer");
    const viewerResponse = await callTool(
      fixture,
      accessToken,
      "organization_get",
    );
    assertEquals(viewerResponse.status, 200);
    const viewer = await viewerResponse.json() as McpResult;
    assertEquals(viewer.result?.isError, undefined);
    assert(
      viewer.result?.content?.some(({ text }) =>
        text.includes(seeded.organizationId)
      ),
    );

    await setRole("guest");
    const guestResponse = await callTool(
      fixture,
      accessToken,
      "organization_get",
    );
    assertEquals(guestResponse.status, 200);
    const guest = await guestResponse.json() as McpResult;
    assertEquals(guest.result?.isError, true);
    assertEquals(guest.result?.content?.[0]?.text, "RESOURCE_NOT_FOUND");
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a browser session never authenticates the MCP endpoint and only bearer tokens do", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });

    const cookieOnly = await fixture.app.fetch(
      mcpRequest("tools/list", {}, { headers: { cookie: seeded.adminCookie } }),
    );
    assertEquals(cookieOnly.status, 401);
    assert(
      (cookieOnly.headers.get("www-authenticate") ?? "").includes(
        "resource_metadata=",
      ),
    );
    const cookieAndBadToken = await fixture.app.fetch(
      mcpRequest("tools/list", {}, {
        token: "garbage",
        headers: { cookie: seeded.adminCookie },
      }),
    );
    assertEquals(cookieAndBadToken.status, 401);

    for (const scheme of ["Basic", "DPoP", "bearer-ish", "Token"]) {
      const response = await fixture.app.fetch(
        mcpRequest("tools/list", {}, { token: accessToken, scheme }),
      );
      assertNotEquals(response.status, 200, scheme);
      assertEquals(response.status, 401, scheme);
    }
    // A token in the query string is not a credential.
    const query = await fixture.app.fetch(
      new Request(`${authTestOrigin}/mcp?access_token=${accessToken}`, {
        method: "POST",
        headers: mcpRequest("tools/list").headers,
        body: await mcpRequest("tools/list").text(),
      }),
    );
    assertEquals(query.status, 401);

    // Only POST is served; the others never reach the guard or the SDK.
    for (const verb of ["GET", "DELETE", "PUT", "PATCH"]) {
      const response = await fixture.app.fetch(
        mcpRequest("tools/list", {}, { token: accessToken, verb }),
      );
      assertEquals(response.status, 405, verb);
      assertEquals(response.headers.get("allow"), "POST");
    }
    // An Origin outside the trusted set fails even with a valid token; a
    // native client sends none and a trusted one passes.
    const foreign = await fixture.app.fetch(
      mcpRequest("tools/list", {}, {
        token: accessToken,
        headers: { origin: "https://evil.example" },
      }),
    );
    assertEquals(foreign.status, 403);
    const trusted = await fixture.app.fetch(
      mcpRequest("tools/list", {}, {
        token: accessToken,
        headers: { origin: authTestOrigin },
      }),
    );
    assertEquals(trusted.status, 200);
    // The tool-name header must match the body, or scope checks could be steered.
    const mismatch = await fixture.app.fetch(
      mcpRequest("tools/call", { name: "whoami", arguments: {} }, {
        token: accessToken,
        headers: { "mcp-name": "organization_get" },
      }),
    );
    assertEquals(mismatch.status, 400);
    const oversized = await fixture.app.fetch(
      mcpRequest("tools/call", {}, {
        token: accessToken,
        body: JSON.stringify({ pad: "x".repeat(70_000) }),
      }),
    );
    assertEquals(oversized.status, 413);
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("authorization needs PKCE S256, an exact redirect URI and the MCP resource", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { verifier, challenge } = await pkcePair();

    const noPkce = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge: null,
    });
    assertEquals(
      new URL(noPkce.headers.get("location")!, authTestOrigin)
        .searchParams.get("code"),
      null,
    );
    assert(
      !(noPkce.headers.get("location") ?? "").includes("/oauth/consent"),
      "consent is not offered without a challenge",
    );

    const plain = await fixture.app.fetch(
      new Request(
        authorizeUrl({ clientId, challenge }).replace(
          "code_challenge_method=S256",
          "code_challenge_method=plain",
        ),
        { headers: { cookie: seeded.adminCookie } },
      ),
    );
    assert(!(plain.headers.get("location") ?? "").includes("/oauth/consent"));

    const foreignRedirect = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
      redirectUri: "https://evil.example/callback",
    });
    assert(
      !(foreignRedirect.headers.get("location") ?? "").startsWith(
        "https://evil.example",
      ),
      "never redirects to an unregistered URI",
    );
    assert(foreignRedirect.status >= 300);

    const otherResource = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
      resource: "https://other.example/mcp",
    });
    assert(
      !(otherResource.headers.get("location") ?? "").includes("/oauth/consent"),
    );

    const unknownScope = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
      scope: "bakery:read bakery:admin",
    });
    assert(
      !(unknownScope.headers.get("location") ?? "").includes("/oauth/consent"),
    );

    // The code only redeems with the right verifier and the registered redirect.
    const authorized = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
    });
    // A consent POST from a foreign origin is refused (cross-site request).
    const forged = await fixture.app.fetch(
      new Request(`${authTestOrigin}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          cookie: seeded.adminCookie,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: await consentQuery(authorized),
        }),
      }),
    );
    assertEquals(forged.status, 403);
    await forged.body?.cancel();
    const consent = await submitConsent(fixture, {
      cookie: seeded.adminCookie,
      oauthQuery: await consentQuery(authorized),
    });
    const location = ((await consent.json()) as { url: string }).url;
    const code = new URL(location).searchParams.get("code")!;
    const wrongVerifier = await exchangeCode(fixture, {
      clientId,
      code,
      verifier: "x".repeat(60),
    });
    assert(
      wrongVerifier.status === 400 || wrongVerifier.status === 401,
      `wrong verifier answered ${wrongVerifier.status}`,
    );
    assertEquals(
      "access_token" in (await wrongVerifier.json() as Json),
      false,
    );
    const wrongRedirect = await exchangeCode(fixture, {
      clientId,
      code,
      verifier,
      redirectUri: "http://127.0.0.1:43111/other",
    });
    assert(wrongRedirect.status >= 400);
    // A failed attempt may burn the code; either way the right one can no
    // longer be replayed after a success.
    const redeemed = await exchangeCode(fixture, { clientId, code, verifier });
    if (redeemed.status === 200) {
      const replay = await exchangeCode(fixture, { clientId, code, verifier });
      assert(replay.status >= 400, "a code redeems once");
    }
    // The issuer is advertised on every authorization response.
    assertEquals(new URL(location).searchParams.get("iss"), OAUTH_ISSUER);
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a pending-factor session reaches neither consent nor token issuance", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const password = `Settings-${
      seeded.adminEmail.split("settings-admin-")[1].split("@")[0]
    }`;
    await enrollTotp(fixture, seeded.adminCookie, password);

    // A session minted by a non-password sign-in carries no factor proof.
    const userId = await userIdFor(fixture.pgDatabase, seeded.adminEmail);
    const token = `pending-${crypto.randomUUID()}`;
    await fixture.pgDatabase.query(
      `insert into public.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       values (gen_random_uuid(), now() + interval '1 day', $1, now(), now(), $2)`,
      [token, userId],
    );
    const pendingCookie = await signSessionCookie(token, authTestSecret);

    const { challenge } = await pkcePair();
    const authorized = await authorize(fixture, {
      clientId,
      cookie: pendingCookie,
      challenge,
    });
    assertEquals(authorized.status, 403, await authorized.clone().text());
    assertEquals(
      ((await authorized.json()) as Json).code,
      "TWO_FACTOR_REQUIRED",
    );

    const consent = await submitConsent(fixture, {
      cookie: pendingCookie,
      oauthQuery: `client_id=${clientId}&scope=bakery%3Aread`,
    });
    assertEquals(consent.status, 403);
    assertEquals(((await consent.json()) as Json).code, "TWO_FACTOR_REQUIRED");

    const selection = await fixture.app.fetch(authRequest(
      "/api/auth/bakery/oauth/select-organization",
      { organizationId: seeded.organizationId },
      { cookie: pendingCookie },
    ));
    assertEquals(selection.status, 403);

    const consents = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from public."oauthConsent" where "userId" = $1`,
      [userId],
    );
    assertEquals(consents.rows[0].count, "0");
    const codes = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from public.verification
        where position('"type":"authorization_code"' in value) > 0
          and position($1 in value) > 0`,
      [`"userId":${JSON.stringify(userId)}`],
    );
    assertEquals(codes.rows[0].count, "0");
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("the session-to-JWT exchange is closed and no JWT header leaks from get-session", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  try {
    for (const path of ["/api/auth/token", "/api/auth/token/"]) {
      const response = await fixture.app.fetch(get(path, seeded.adminCookie));
      assertEquals(response.status, 404, path);
      assertEquals(
        (await response.json() as Json).token,
        undefined,
        path,
      );
    }
    const session = await fixture.app.fetch(
      get("/api/auth/get-session", seeded.adminCookie),
    );
    assertEquals(session.status, 200);
    assertEquals(session.headers.get("set-auth-jwt"), null);
    // The signing keys stay public but only the public half.
    const jwks = await fixture.app.fetch(get("/api/auth/jwks"));
    assertEquals(jwks.status, 200);
    const keys = (await jwks.json() as { keys: Json[] }).keys;
    assert(keys.length > 0);
    for (const key of keys) assertEquals(key.d, undefined);
  } finally {
    await cleanup(fixture, seeded.emails, []);
    await fixture.close();
  }
});

Deno.test("signed-in people cannot create, change or delete OAuth clients or resources", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture, { name: "Pinned name" });
    clientIds.push(clientId);
    const counts = async () => {
      const result = await fixture.pgDatabase.query<
        { clients: string; resources: string; links: string }
      >(
        `select (select count(*) from public."oauthClient")::text as clients,
                (select count(*) from public."oauthResource")::text as resources,
                (select count(*) from public."oauthClientResource")::text as links`,
      );
      return result.rows[0];
    };
    const before = await counts();
    const client = {
      client_name: "Evil",
      redirect_uris: ["https://evil.example/cb"],
      token_endpoint_auth_method: "none",
    };
    const attempts: [string, string, Json][] = [
      ["POST", "/api/auth/oauth2/create-client", client],
      ["POST", "/api/auth/admin/oauth2/create-client", client],
      ["POST", "/api/auth/oauth2/register", client],
      ["POST", "/api/auth/oauth2/update-client", {
        client_id: clientId,
        update: { redirect_uris: ["https://evil.example/cb"] },
      }],
      ["POST", "/api/auth/admin/oauth2/update-client", {
        client_id: clientId,
        update: { redirect_uris: ["https://evil.example/cb"] },
      }],
      ["POST", "/api/auth/oauth2/delete-client", { client_id: clientId }],
      ["POST", "/api/auth/oauth2/client/rotate-secret", {
        client_id: clientId,
      }],
      ["POST", "/api/auth/admin/oauth2/resources", {
        identifier: "https://evil.example/mcp",
        name: "Evil",
      }],
    ];
    for (const person of [seeded.adminCookie, seeded.developerCookie]) {
      for (const [method, path, body] of attempts) {
        const response = await call(fixture, method, path, person, { body });
        assert(
          response.status >= 400,
          `${path} answered ${response.status} for a signed-in person`,
        );
        await response.body?.cancel();
      }
    }
    // Not even without a session.
    for (const [method, path, body] of attempts) {
      const response = await fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            origin: authTestOrigin,
          },
          body: JSON.stringify(body),
        }),
      );
      assert(response.status >= 400, `${path} without a session`);
      await response.body?.cancel();
    }
    assertEquals(await counts(), before);
    const stored = await fixture.pgDatabase.query<
      { name: string; redirectUris: string[] }
    >(
      `select name, "redirectUris" as "redirectUris" from public."oauthClient" where "clientId" = $1`,
      [clientId],
    );
    assertEquals(stored.rows[0].name, "Pinned name");
    assertEquals(stored.rows[0].redirectUris, [TEST_REDIRECT_URI]);
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("provider consent mutation is closed, so a delete attempt cannot revive an old token after re-consent", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const first = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const consent = await fixture.pgDatabase.query<{ id: string }>(
      `select id from public."oauthConsent" where "clientId" = $1`,
      [clientId],
    );
    const id = consent.rows[0].id;
    for (const cookie of [seeded.adminCookie, seeded.developerCookie]) {
      for (
        const [path, body] of [
          ["/api/auth/oauth2/delete-consent", { id }],
          ["/api/auth/oauth2/update-consent", {
            id,
            update: { scopes: ["bakery:operate"] },
          }],
        ] as const
      ) {
        const response = await call(fixture, "POST", path, cookie, { body });
        assertEquals(response.status, 404, path);
        await response.body?.cancel();
      }
    }
    // Nothing changed: the consent, its scopes and the token are intact.
    const after = await fixture.pgDatabase.query<{ scopes: string[] }>(
      `select scopes from public."oauthConsent" where id = $1`,
      [id],
    );
    assertEquals(after.rows[0].scopes, ["bakery:read", "bakery:operate"]);
    assertEquals(
      (await callTool(fixture, first.accessToken, "whoami")).status,
      200,
    );

    // Re-consent after the refused attempts: the grant is replaced in place,
    // and the only revoke path is Bakery's, which writes the epoch.
    const [grant] = (await (await call(
      fixture,
      "GET",
      "/v1/me/connected-clients",
      seeded.adminCookie,
    )).json() as { items: Json[] }).items;
    const revoked = await call(
      fixture,
      "DELETE",
      `/v1/me/connected-clients/${grant.id}`,
      seeded.adminCookie,
    );
    assertEquals(revoked.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    assertEquals(
      (await callTool(fixture, first.accessToken, "whoami")).status,
      401,
    );
    assertEquals(
      (await callTool(fixture, second.accessToken, "whoami")).status,
      200,
    );
  } finally {
    await cleanup(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});
