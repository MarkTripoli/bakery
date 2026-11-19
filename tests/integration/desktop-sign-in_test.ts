import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import {
  answerDesktopPage,
  bearerGet,
  cleanupDesktopSignIns,
  codeFromDonePage,
  DESKTOP_REDIRECT,
  desktopClient,
  exchangeDesktopSignIn,
  refusalOf,
  signInDesktop,
  startDesktopSignIn,
  viewDesktopPage,
} from "../helpers/desktop-sign-in.ts";

async function withFixture(run: (f: InstallationFixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await cleanupDesktopSignIns(f);
    await f.finish();
  }
}

Deno.test("the desktop handoff issues a bkd_ credential the page API accepts as the person", async () => {
  await withFixture(async (f) => {
    const started = await startDesktopSignIn(f);
    assertEquals(
      new URL(started.confirmUrl).pathname,
      "/api/desktop/sign-in",
    );
    const ttl = Date.parse(started.expiresAt) - Date.now();
    assert(ttl > 9 * 60_000 && ttl <= 10 * 60_000, String(ttl));

    const page = await viewDesktopPage(f, started.id, {
      cookie: f.developerCookie,
    });
    assertEquals(page.status, 200);
    assertEquals(page.headers.get("cache-control"), "no-store");
    assertMatch(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    const html = await page.text();
    assert(html.includes("Sign in to the Bakery app?"));
    assert(html.includes("Test Studio"));
    assert(html.includes("Continue to the app"));

    const code = await codeFromDonePage(
      await answerDesktopPage(f, f.developerCookie, started.id, "continue"),
    );
    const exchanged = await exchangeDesktopSignIn(f, started.id, {
      code,
      codeVerifier: started.verifier,
    });
    assertEquals(exchanged.status, 201, await exchanged.clone().text());
    const issued = await exchanged.json() as {
      credential: string;
      sessionId: string;
    };
    assertMatch(issued.credential, /^bkd_[A-Za-z0-9_-]{43}$/);

    const me = await f.app.fetch(bearerGet("/v1/me", issued.credential));
    assertEquals(me.status, 200, await me.clone().text());
    assertEquals((await me.json()).principalId, f.developerId);

    const sessions = await f.app.fetch(
      bearerGet("/v1/me/sessions", issued.credential),
    );
    assertEquals(sessions.status, 200);
    const listed = (await sessions.json()).items as {
      id: string;
      current: boolean;
      userAgent: string;
    }[];
    const row = listed.find((item) => item.id === issued.sessionId);
    assertEquals(row?.userAgent, "Bakery app · Test Studio");
    assertEquals(row?.current, true);

    const stored = await f.pgDatabase.query<Record<string, unknown>>(
      "select * from bakery.desktop_sign_in_requests where id = $1",
      [started.id],
    );
    const text = JSON.stringify(stored.rows[0]);
    assert(!text.includes(code) && !text.includes(started.verifier));
    const audit = await f.pgDatabase.query<
      { operation: string; details: unknown }
    >(
      `select operation, details from bakery.audit_events
       where resource_type = 'desktop_sign_in' and resource_id = $1
       order by created_at`,
      [started.id],
    );
    assertEquals(
      audit.rows.map((r) => r.operation),
      ["auth.desktopSignIn.approve", "desktopSignIns.exchange"],
    );
    const auditText = JSON.stringify(audit.rows);
    assert(!auditText.includes(issued.credential) && !auditText.includes(code));
  });
});

Deno.test("a handoff code is single-use and its replay ends the sign-in it issued", async () => {
  await withFixture(async (f) => {
    const issued = await signInDesktop(f, f.developerCookie);
    const replay = await exchangeDesktopSignIn(f, issued.id, {
      code: issued.code,
      codeVerifier: issued.verifier,
    });
    assertEquals(await refusalOf(replay), {
      status: 409,
      code: "STATE_CONFLICT",
      reason: "desktop_sign_in_used",
    });
    const me = await f.app.fetch(bearerGet("/v1/me", issued.credential));
    assertEquals(me.status, 401);
    const page = await viewDesktopPage(f, issued.id, {
      cookie: f.developerCookie,
    });
    assertEquals(page.status, 409);
    assert(
      (await page.text()).includes("This sign-in request was already used"),
    );
  });
});

Deno.test("an expired request is refused on the page and at the exchange", async () => {
  await withFixture(async (f) => {
    const started = await startDesktopSignIn(f);
    const code = await codeFromDonePage(
      await answerDesktopPage(f, f.developerCookie, started.id, "continue"),
    );
    await f.pgDatabase.query(
      "update bakery.desktop_sign_in_requests set expires_at = now() - interval '1 second' where id = $1",
      [started.id],
    );
    assertEquals(
      await refusalOf(
        await exchangeDesktopSignIn(f, started.id, {
          code,
          codeVerifier: started.verifier,
        }),
      ),
      {
        status: 409,
        code: "STATE_CONFLICT",
        reason: "desktop_sign_in_expired",
      },
    );
    const unanswered = await startDesktopSignIn(f);
    await f.pgDatabase.query(
      "update bakery.desktop_sign_in_requests set expires_at = now() - interval '1 second' where id = $1",
      [unanswered.id],
    );
    const page = await viewDesktopPage(f, unanswered.id, {
      cookie: f.developerCookie,
    });
    assertEquals(page.status, 410);
    assert(
      (await page.text()).includes("This sign-in request ran out of time"),
    );
  });
});

Deno.test("a wrong PKCE verifier spends the request and issues nothing", async () => {
  await withFixture(async (f) => {
    const started = await startDesktopSignIn(f);
    const code = await codeFromDonePage(
      await answerDesktopPage(f, f.developerCookie, started.id, "continue"),
    );
    const wrong = await exchangeDesktopSignIn(f, started.id, {
      code,
      codeVerifier: "x".repeat(64),
    });
    assertEquals(await refusalOf(wrong), {
      status: 409,
      code: "STATE_CONFLICT",
      reason: "desktop_sign_in_mismatch",
    });
    const retry = await exchangeDesktopSignIn(f, started.id, {
      code,
      codeVerifier: started.verifier,
    });
    assertEquals((await refusalOf(retry)).reason, "desktop_sign_in_used");
    const sessions = await f.pgDatabase.query(
      `select 1 from public.session where "userAgent" = 'Bakery app · Test Studio'
       and "userId" = (select provider_user_id from bakery.principals where id = $1)`,
      [f.developerId],
    );
    assertEquals(sessions.rowCount, 0);
  });
});

Deno.test("a wrong code is a mismatch, and the client must be the built-in desktop client", async () => {
  await withFixture(async (f) => {
    const started = await startDesktopSignIn(f);
    await codeFromDonePage(
      await answerDesktopPage(f, f.developerCookie, started.id, "continue"),
    );
    assertEquals(
      (await refusalOf(
        await exchangeDesktopSignIn(f, started.id, {
          code: "A".repeat(43),
          codeVerifier: started.verifier,
        }),
      )).reason,
      "desktop_sign_in_mismatch",
    );

    const other = await f.app.fetch(
      new Request("http://127.0.0.1:8788/v1/desktop-sign-ins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "some-other-app",
          codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          codeChallengeMethod: "S256",
          redirectUri: DESKTOP_REDIRECT,
          computerName: "Elsewhere",
        }),
      }),
      desktopClient(),
    );
    assert(other.status === 400 || other.status === 422, String(other.status));

    const bound = await startDesktopSignIn(f);
    const code = await codeFromDonePage(
      await answerDesktopPage(f, f.developerCookie, bound.id, "continue"),
    );
    await f.pgDatabase.query(
      "update bakery.desktop_sign_in_requests set client_id = 'some-other-app' where id = $1",
      [bound.id],
    );
    assertEquals(
      (await refusalOf(
        await exchangeDesktopSignIn(f, bound.id, {
          code,
          codeVerifier: bound.verifier,
        }),
      )).reason,
      "desktop_sign_in_mismatch",
    );
  });
});

Deno.test("cancelled, unanswered and unknown requests get reasons the app can tell apart", async () => {
  await withFixture(async (f) => {
    const pending = await startDesktopSignIn(f);
    assertEquals(
      (await refusalOf(
        await exchangeDesktopSignIn(f, pending.id, {
          code: "A".repeat(43),
          codeVerifier: pending.verifier,
        }),
      )).reason,
      "desktop_sign_in_pending",
    );
    const cancelled = await answerDesktopPage(
      f,
      f.developerCookie,
      pending.id,
      "cancel",
    );
    assertEquals(cancelled.status, 200);
    assert((await cancelled.text()).includes("Sign-in was cancelled"));
    assertEquals(
      (await refusalOf(
        await exchangeDesktopSignIn(f, pending.id, {
          code: "A".repeat(43),
          codeVerifier: pending.verifier,
        }),
      )).reason,
      "desktop_sign_in_cancelled",
    );
    const unknown = await exchangeDesktopSignIn(f, crypto.randomUUID(), {
      code: "A".repeat(43),
      codeVerifier: pending.verifier,
    });
    assertEquals((await refusalOf(unknown)).code, "RESOURCE_NOT_FOUND");
    const missing = await viewDesktopPage(f, "not-a-request", {
      cookie: f.developerCookie,
    });
    assertEquals(missing.status, 404);
    assert((await missing.text()).includes("Nothing to sign in"));
  });
});

Deno.test("only a signed-in browser on a trusted origin can answer, never the app's own credential", async () => {
  await withFixture(async (f) => {
    const started = await startDesktopSignIn(f);
    const signedOut = await viewDesktopPage(f, started.id);
    assertEquals(signedOut.status, 401);
    const issued = await signInDesktop(f, f.developerCookie);
    const viaBearer = await viewDesktopPage(f, started.id, {
      authorization: `Bearer ${issued.credential}`,
    });
    assertEquals(viaBearer.status, 404);
    const crossSite = await answerDesktopPage(
      f,
      f.developerCookie,
      started.id,
      "continue",
      "https://evil.example",
    );
    assertEquals(crossSite.status, 403);
    const row = await f.pgDatabase.query<{ decision: string | null }>(
      "select decision from bakery.desktop_sign_in_requests where id = $1",
      [started.id],
    );
    assertEquals(row.rows[0].decision, null);
  });
});

Deno.test("only loopback or app-link redirect addresses can open a request", async () => {
  await withFixture(async (f) => {
    for (
      const redirectUri of ["https://evil.example/cb", "http://localhost:1/cb"]
    ) {
      const response = await f.app.fetch(
        new Request("http://127.0.0.1:8788/v1/desktop-sign-ins", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "bakery-desktop",
            codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            codeChallengeMethod: "S256",
            redirectUri,
            computerName: "Studio",
          }),
        }),
        desktopClient(),
      );
      assertEquals(response.status, 422, redirectUri);
    }
  });
});
