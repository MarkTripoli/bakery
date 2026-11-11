import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  auditRows,
  authGet,
  authPost,
  markDomainVerified,
  openSsoFixture,
  passwordSignIn,
  providerCount,
  registerOidc,
  registerSaml,
  reservePort,
  SECRET_MARKERS,
  sessionEmail,
  signInWithSaml,
  signInWithSso,
} from "../helpers/sso/sso-fixture.ts";
import { startOidcIssuer } from "../helpers/sso/oidc-issuer.ts";
import { startSamlIdp } from "../helpers/sso/saml-idp.ts";
import { startTxtDns } from "../helpers/dns-txt.ts";

async function withOidc(
  run: (
    context: {
      issuer: Awaited<ReturnType<typeof startOidcIssuer>>;
      f: Awaited<ReturnType<typeof openSsoFixture>>;
    },
  ) => Promise<void>,
) {
  const issuer = await startOidcIssuer(reservePort());
  const f = await openSsoFixture([issuer.issuer]);
  try {
    await run({ issuer, f });
  } finally {
    await f.pgDatabase.query(`delete from public."ssoProvider"`);
    await issuer.close();
    await f.finish();
  }
}

async function problemCode(response: Response) {
  const body = await response.clone().json().catch(() => ({})) as {
    code?: string;
  };
  return body.code;
}

Deno.test("OIDC: an admin registers a provider and a real signed ID token signs the person in", async () => {
  await withOidc(async ({ issuer, f }) => {
    const registered = await registerOidc(f, issuer);
    assertEquals(registered.status, 200, await registered.clone().text());
    const body = await registered.json() as {
      organizationId: string;
      oidcConfig: Record<string, unknown>;
    };
    assertEquals(body.organizationId, f.organizationId);
    assertFalse(
      "clientSecret" in body.oidcConfig,
      "response must not echo the secret",
    );
    const stored = await f.pgDatabase.query<{ organizationId: string }>(
      `select "organizationId" from public."ssoProvider" where "providerId" = 'oidc-acme'`,
    );
    assertEquals(stored.rows[0].organizationId, f.organizationId);

    const token = await authPost(
      f,
      "/api/auth/sso/request-domain-verification",
      { providerId: "oidc-acme" },
      f.adminCookie,
    );
    assertEquals(token.status, 201, await token.clone().text());
    const { domainVerificationToken } = await token.json() as {
      domainVerificationToken: string;
    };
    const dns = await startTxtDns();
    try {
      const verify = () =>
        authPost(
          f,
          "/api/auth/sso/verify-domain",
          { providerId: "oidc-acme" },
          f.adminCookie,
        );
      // No TXT record published yet: the real lookup finds nothing.
      assertEquals((await verify()).status, 502);
      assertEquals(await auditRows(f, "auth.sso.domain", f.organizationId), []);
      dns.publish(
        "_bakery-verify-oidc-acme.example.test",
        domainVerificationToken,
      );
      assertEquals((await verify()).status, 204);
      const verified = await auditRows(f, "auth.sso.domain", f.organizationId);
      assertEquals(verified.map((row) => row.operation), [
        "auth.sso.domain.verify",
      ]);
      assertFalse(JSON.stringify(verified).includes(domainVerificationToken));
    } finally {
      dns.close();
    }
    issuer.assert.email = f.developerEmail;
    const signedIn = await signInWithSso(f, "oidc-acme");
    assert(signedIn.cookie, await signedIn.callback.clone().text());
    assertEquals(await sessionEmail(f, signedIn.cookie), f.developerEmail);
    assert(
      issuer.tokenRequests.some((request) =>
        request.includes(btoa(`${issuer.clientId}:${issuer.clientSecret}`))
      ),
      "Bakery authenticated to the token endpoint with the stored client secret",
    );
  });
});

Deno.test("OIDC: an ID token from the wrong issuer key is not accepted", async () => {
  await withOidc(async ({ issuer, f }) => {
    assertEquals((await registerOidc(f, issuer)).status, 200);
    await markDomainVerified(f, "oidc-acme");
    // A second issuer with a different signing key answers the same JWKS URL.
    const rogue = await startOidcIssuer(reservePort());
    try {
      await f.pgDatabase.query(
        `update public."ssoProvider" set "oidcConfig" = replace("oidcConfig", $1, $2) where "providerId" = 'oidc-acme'`,
        [`${issuer.issuer}/jwks`, `${rogue.issuer}/jwks`],
      );
      issuer.assert.email = f.developerEmail;
      const result = await signInWithSso(f, "oidc-acme");
      assertEquals(result.cookie, null);
    } finally {
      await rogue.close();
    }
  });
});

Deno.test("SAML: a really signed assertion signs the person in; a different signing key is refused", async () => {
  const idp = await startSamlIdp(reservePort());
  const rogue = await startSamlIdp(reservePort());
  const f = await openSsoFixture([]);
  try {
    const registered = await registerSaml(f, idp);
    assertEquals(registered.status, 200, await registered.clone().text());
    const body = await registered.json() as { organizationId: string };
    assertEquals(body.organizationId, f.organizationId);
    await markDomainVerified(f, "saml-acme");

    // SP signing keys are credentials: never echoed and never audited.
    const withKey = await registerSaml(f, idp, {
      providerId: "saml-keyed",
      samlConfig: {
        entryPoint: idp.ssoUrl,
        cert: idp.certificatePem,
        callbackUrl: `${authTestOrigin}/`,
        audience: `${authTestOrigin}/saml-sp`,
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nSP-PRIVATE-KEY-MARKER\n-----END PRIVATE KEY-----",
        idpMetadata: { entityID: idp.entityID },
      },
    });
    assertEquals(withKey.status, 200, await withKey.clone().text());
    assertFalse((await withKey.text()).includes("SP-PRIVATE-KEY-MARKER"));
    assertFalse(
      JSON.stringify(await auditRows(f, "auth.sso", f.organizationId)).includes(
        "SP-PRIVATE-KEY-MARKER",
      ),
    );

    const ok = await signInWithSaml(f, idp, "saml-acme", f.developerEmail);
    assert(ok.cookie, await ok.acs.clone().text());
    assertEquals(await sessionEmail(f, ok.cookie), f.developerEmail);

    // Same IdP identity, assertion signed with another key: must not sign in.
    const forged = await signInWithSaml(
      f,
      { respond: (url, meta, email) => rogue.respond(url, meta, email) },
      "saml-acme",
      f.adminEmail,
    );
    assertEquals(forged.cookie, null);
  } finally {
    await f.pgDatabase.query(`delete from public."ssoProvider"`);
    await f.finish();
  }
});

Deno.test("checks run tenant lookup, then permission; bearer tokens and strangers never reach them", async () => {
  await withOidc(async ({ issuer, f }) => {
    const unknownOrg = await registerOidc(f, issuer, {
      organizationId: crypto.randomUUID(),
    });
    assertEquals(unknownOrg.status, 404);
    const developer = await registerOidc(f, issuer, {}, f.developerCookie);
    assertEquals(developer.status, 403);
    assertEquals(await problemCode(developer), "AUTH_FORBIDDEN");

    const bearer = await authPost(
      f,
      "/api/auth/sso/register",
      {
        providerId: "x",
        issuer: issuer.issuer,
        domain: "example.test",
        organizationId: f.organizationId,
      },
      f.adminCookie,
      { authorization: "Bearer not-a-session" },
    );
    assertEquals(bearer.status, 403);
    assertEquals(await problemCode(bearer), "SESSION_REQUIRED");
    const anonymous = await authPost(
      f,
      "/api/auth/sso/register",
      {
        providerId: "x",
        issuer: issuer.issuer,
        domain: "example.test",
        organizationId: f.organizationId,
      },
      "",
    );
    assertEquals(anonymous.status, 401);
    assertEquals(await providerCount(f), 0);
    assertEquals(await auditRows(f, "auth.sso", f.organizationId), []);

    const list = await authGet(f, "/api/auth/sso/providers", f.adminCookie);
    assertEquals(list.status, 404, "the unscoped provider listing is closed");
    const scoped = await authGet(
      f,
      `/api/auth/bakery-sso/providers?organizationId=${f.organizationId}`,
      f.developerCookie,
    );
    assertEquals(scoped.status, 403);
  });
});

Deno.test("enforcement: members must use SSO, break-glass admins keep password sign-in", async () => {
  await withOidc(async ({ issuer, f }) => {
    const enforce = (enforce: boolean, cookie = f.adminCookie) =>
      authPost(f, "/api/auth/bakery-sso/enforcement", {
        organizationId: f.organizationId,
        enforce,
      }, cookie);
    // No verified provider yet: enforcing would lock everyone out.
    assertEquals((await enforce(true)).status, 409);
    assertEquals((await registerOidc(f, issuer)).status, 200);
    await markDomainVerified(f, "oidc-acme");
    assertEquals((await enforce(true, f.developerCookie)).status, 403);
    assertEquals((await enforce(true)).status, 200);

    // The member is refused on password sign-in, the admin is not.
    const blocked = await passwordSignIn(f, f.developerEmail, f.password);
    assertEquals(blocked.status, 403, await blocked.clone().text());
    assertEquals(await problemCode(blocked), "SSO_REQUIRED");
    assertEquals(
      blocked.headers.getSetCookie().filter((c) =>
        c.startsWith("better-auth.session_token=") && !c.includes("Max-Age=0")
      ).length,
      0,
    );
    const breakGlass = await passwordSignIn(f, f.adminEmail, f.password);
    assertEquals(breakGlass.status, 200, await breakGlass.clone().text());

    // The same member signs in through SSO while enforcement is on.
    issuer.assert.email = f.developerEmail;
    const viaSso = await signInWithSso(f, "oidc-acme");
    assert(viaSso.cookie, await viaSso.callback.clone().text());

    const overview = async () =>
      await (await authGet(
        f,
        `/api/auth/bakery-sso/providers?organizationId=${f.organizationId}`,
        f.adminCookie,
      )).json() as {
        enforce: boolean;
        providers: {
          providerId: string;
          protocol: string;
          domainVerified: boolean;
        }[];
      };
    const current = await overview();
    assertEquals(current.enforce, true);
    assertEquals(current.providers.map((p) => p.providerId), ["oidc-acme"]);
    assertFalse(JSON.stringify(current).includes(issuer.clientSecret));

    // Switching it off lets password sign-in work again.
    assertEquals((await enforce(false)).status, 200);
    assertEquals(
      (await passwordSignIn(f, f.developerEmail, f.password)).status,
      200,
    );
    const rows = await auditRows(f, "auth.sso.enforcement", f.organizationId);
    assertEquals(rows.map((row) => row.details), [{ enforce: true }, {
      enforce: false,
    }]);
  });
});

Deno.test("audit: every SSO mutation writes exactly one row, refusals none, and no secret reaches any row", async () => {
  await withOidc(async ({ issuer, f }) => {
    // failure: invalid body writes nothing
    const bad = await registerOidc(f, issuer, { issuer: "not a url" });
    assertNotEquals(bad.status, 200);
    assertEquals(await auditRows(f, "auth.sso", f.organizationId), []);

    assertEquals((await registerOidc(f, issuer)).status, 200);
    const edited = await authPost(
      f,
      "/api/auth/sso/update-provider",
      {
        providerId: "oidc-acme",
        oidcConfig: { clientSecret: "rotated-secret-must-never-be-audited" },
      },
      f.adminCookie,
    );
    assertEquals(edited.status, 200, await edited.clone().text());
    const missing = await authPost(
      f,
      "/api/auth/sso/delete-provider",
      { providerId: "does-not-exist" },
      f.adminCookie,
    );
    assertEquals(missing.status, 404);
    assertEquals(
      (await authPost(f, "/api/auth/sso/delete-provider", {
        providerId: "oidc-acme",
      }, f.adminCookie)).status,
      200,
    );
    const rows = await auditRows(f, "auth.sso", f.organizationId);
    assertEquals(rows.map((row) => row.operation), [
      "auth.sso.provider.create",
      "auth.sso.provider.update",
      "auth.sso.provider.delete",
    ]);
    for (const row of rows) assertEquals(row.principalId, f.adminId);
    const serialized = JSON.stringify(rows);
    for (
      const marker of [
        ...SECRET_MARKERS,
        "rotated-secret-must-never-be-audited",
      ]
    ) {
      assertFalse(serialized.includes(marker), `audit leaked ${marker}`);
    }
  });
});

Deno.test("provider migration 0012 matches the plugin's own schema", async () => {
  const f = await openSsoFixture();
  try {
    const { getMigrations } = await import("better-auth/db/migration");
    const { sso } = await import("@better-auth/sso");
    const { compileMigrations } = await getMigrations({
      database: f.pgDatabase,
      baseURL: authTestOrigin,
      basePath: "/api/auth",
      secret: "migration-check-only-secret",
      advanced: { database: { generateId: "uuid" } },
      plugins: [sso({ domainVerification: { enabled: true } })],
    } as never);
    const pending = (await compileMigrations()).trim();
    assertFalse(
      /ssoProvider/.test(pending),
      `plugin expects schema changes the migration lacks: ${pending}`,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("SAML: signatures are mandatory and every forged or stale assertion is refused", async () => {
  const idp = await startSamlIdp(reservePort());
  const f = await openSsoFixture([]);
  try {
    // An admin cannot turn signature checking off, and omitting it means on.
    const off = await registerSaml(f, idp, {
      providerId: "saml-off",
      samlConfig: {
        entryPoint: idp.ssoUrl,
        cert: idp.certificatePem,
        wantAssertionsSigned: false,
        idpMetadata: { entityID: idp.entityID },
      },
    });
    assertEquals(off.status, 400, await off.clone().text());
    const omitted = await registerSaml(f, idp, {
      providerId: "saml-omitted",
      samlConfig: {
        entryPoint: idp.ssoUrl,
        cert: idp.certificatePem,
        callbackUrl: `${authTestOrigin}/`,
        audience: `${authTestOrigin}/saml-sp`,
        idpMetadata: { entityID: idp.entityID },
      },
    });
    assertEquals(omitted.status, 200, await omitted.clone().text());
    const stored = await f.pgDatabase.query<{ signed: boolean }>(
      `select ("samlConfig"::jsonb ->> 'wantAssertionsSigned')::boolean as signed
       from public."ssoProvider" where "providerId" = 'saml-omitted'`,
    );
    assertEquals(stored.rows[0].signed, true);
    const relax = await authPost(
      f,
      "/api/auth/sso/update-provider",
      {
        providerId: "saml-omitted",
        samlConfig: { wantAssertionsSigned: false },
      },
      f.adminCookie,
    );
    assertEquals(relax.status, 400);
    await authPost(f, "/api/auth/sso/delete-provider", {
      providerId: "saml-omitted",
    }, f.adminCookie);

    assertEquals((await registerSaml(f, idp)).status, 200);
    await markDomainVerified(f, "saml-acme");
    const attempt = (
      options: Parameters<typeof signInWithSaml>[4],
      email = f.developerEmail,
    ) => signInWithSaml(f, idp, "saml-acme", email, options);

    // Control: the same harness signs a valid assertion in.
    assert((await attempt({})).cookie, "valid assertion must sign in");

    const refused: Record<string, Awaited<ReturnType<typeof attempt>>> = {
      unsigned: await attempt({ faults: { unsigned: true } }),
      tampered: await attempt({
        tamper: (response) =>
          btoa(atob(response).replaceAll(f.developerEmail, f.adminEmail)),
      }),
      wrongAudience: await attempt({
        faults: { audience: "https://other.example/sp" },
      }),
      wrongIssuer: await attempt({
        faults: { issuer: "https://evil.example/idp" },
      }),
      expired: await attempt({
        faults: { notOnOrAfter: new Date(Date.now() - 3_600_000) },
      }),
      foreignInResponseTo: await attempt({
        faults: { inResponseTo: "_never-issued" },
      }),
    };
    for (const [name, result] of Object.entries(refused)) {
      assertEquals(result.cookie, null, `${name} must not sign in`);
    }

    // Replay: the first delivery signs in, the identical second one does not.
    const replayed = await attempt({ replay: true });
    assert(replayed.cookie, "first delivery signs in");
    assertEquals(
      replayed.replay?.cookie,
      null,
      "replayed response must be refused",
    );
  } finally {
    await f.pgDatabase.query(`delete from public."ssoProvider"`);
    await f.finish();
  }
});

Deno.test("OIDC: forged or stale ID tokens and a wrong state are refused", async () => {
  await withOidc(async ({ issuer, f }) => {
    assertEquals((await registerOidc(f, issuer)).status, 200);
    await markDomainVerified(f, "oidc-acme");
    issuer.assert.email = f.developerEmail;
    assert((await signInWithSso(f, "oidc-acme")).cookie, "control signs in");

    const cases: Record<string, Partial<typeof issuer.faults>> = {
      wrongAudience: { aud: "someone-else" },
      wrongIssuer: { iss: "http://evil.example" },
      expired: { expiresIn: -3600 },
      tamperedPayload: { tamper: true },
    };
    for (const [name, faults] of Object.entries(cases)) {
      issuer.faults = faults;
      assertEquals(
        (await signInWithSso(f, "oidc-acme")).cookie,
        null,
        `${name} must not sign in`,
      );
    }
    issuer.faults = {};
    const wrongState = await signInWithSso(f, "oidc-acme", "", {
      state: "forged-state",
    });
    assertEquals(wrongState.cookie, null, "forged state must not sign in");
  });
});

Deno.test("audit failure rolls every SSO mutation back: no change without its audit row", async () => {
  await withOidc(async ({ issuer, f }) => {
    assertEquals((await registerOidc(f, issuer)).status, 200);
    await markDomainVerified(f, "oidc-acme");
    issuer.assert.email = f.developerEmail;
    assert((await signInWithSso(f, "oidc-acme")).cookie, "links an account");
    await f.pgDatabase.query(
      `update public."ssoProvider" set "domainVerified" = false where "providerId" = 'oidc-acme'`,
    );
    const before = await f.pgDatabase.query(
      `select to_jsonb(p) as provider from public."ssoProvider" p where "providerId" = 'oidc-acme'`,
    );
    const linked = () =>
      f.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from public.account where "providerId" = 'oidc-acme'`,
      );
    assertEquals((await linked()).rows[0].count, "1");
    const rowsBefore =
      (await auditRows(f, "auth.sso", f.organizationId)).length;

    const token = await authPost(
      f,
      "/api/auth/sso/request-domain-verification",
      { providerId: "oidc-acme" },
      f.adminCookie,
    );
    const { domainVerificationToken } = await token.json() as {
      domainVerificationToken: string;
    };
    const dns = await startTxtDns();
    await f.pgDatabase.query(
      "revoke insert on bakery.audit_events from bakery_app",
    );
    try {
      dns.publish(
        "_bakery-verify-oidc-acme.example.test",
        domainVerificationToken,
      );
      const verify = await authPost(
        f,
        "/api/auth/sso/verify-domain",
        { providerId: "oidc-acme" },
        f.adminCookie,
      );
      assertEquals(verify.status >= 400, true, "verification is refused");
      const update = await authPost(
        f,
        "/api/auth/sso/update-provider",
        { providerId: "oidc-acme", domain: "changed.test" },
        f.adminCookie,
      );
      assertEquals(update.status >= 400, true);
      const del = await authPost(
        f,
        "/api/auth/sso/delete-provider",
        { providerId: "oidc-acme" },
        f.adminCookie,
      );
      assertEquals(del.status >= 400, true);
      const created = await registerOidc(f, issuer, { providerId: "oidc-new" });
      assertEquals(created.status >= 400, true);
    } finally {
      await f.pgDatabase.query(
        "grant insert on bakery.audit_events to bakery_app",
      );
      dns.close();
    }

    const after = await f.pgDatabase.query(
      `select to_jsonb(p) as provider from public."ssoProvider" p where "providerId" = 'oidc-acme'`,
    );
    assertEquals(after.rows, before.rows, "provider restored exactly");
    assertEquals(
      (await linked()).rows[0].count,
      "1",
      "linked account restored",
    );
    assertEquals(
      (await f.pgDatabase.query(
        `select 1 from public."ssoProvider" where "providerId" = 'oidc-new'`,
      )).rowCount,
      0,
    );
    assertEquals(
      (await auditRows(f, "auth.sso", f.organizationId)).length,
      rowsBefore,
    );
  });
});
