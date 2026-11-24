import { assert, assertEquals, assertMatch } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import {
  bearerGet,
  cleanupDesktopSignIns,
  exchangeDesktopSignIn,
  signInDesktop,
} from "../helpers/desktop-sign-in.ts";

/**
 * #77 slice 5: the desktop window gets an ordinary browser session from the
 * app's credential through a one-use code, never a bearer value on a page
 * load. Replay, expiry, a signed-out desktop, a cross-site navigation and a
 * browser session asking for a code are each refused.
 */

async function withFixture(run: (f: InstallationFixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await f.pgDatabase.query(
      `delete from bakery.desktop_handoffs
        where principal_id in ($1::uuid, $2::uuid)`,
      [f.developerId, f.adminId],
    );
    await cleanupDesktopSignIns(f);
    await f.finish();
  }
}

function createHandoff(
  f: InstallationFixture,
  credential: string,
  returnTo: string,
): Promise<Response> {
  return Promise.resolve(f.app.fetch(
    new Request(`${authTestOrigin}/v1/desktop-handoffs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ returnTo }),
    }),
  ));
}

async function codeFor(
  f: InstallationFixture,
  credential: string,
  returnTo = "/projects",
): Promise<{ code: string; expiresAt: string }> {
  const response = await createHandoff(f, credential, returnTo);
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json();
}

function openHandoff(
  f: InstallationFixture,
  code: string,
  site: string | null = "none",
): Promise<Response> {
  const headers = new Headers();
  if (site !== null) headers.set("sec-fetch-site", site);
  return Promise.resolve(f.app.fetch(
    new Request(
      `${authTestOrigin}/api/desktop/handoff?code=${encodeURIComponent(code)}`,
      { headers },
    ),
  ));
}

/** The session cookie the handoff set, as a Cookie request header. */
function cookieOf(response: Response): string | null {
  const set = response.headers.get("set-cookie");
  if (set === null) return null;
  return set.split(";", 1)[0];
}

function me(f: InstallationFixture, cookie: string): Promise<Response> {
  return Promise.resolve(f.app.fetch(
    new Request(`${authTestOrigin}/v1/me`, { headers: { cookie } }),
  ));
}

Deno.test("the desktop window gets a browser session for the same person and lands on the asked page", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const issued = await codeFor(f, desktop.credential, "/projects?tab=open");
    assertMatch(issued.code, /^[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(issued.expiresAt) - Date.now();
    assert(ttl > 25_000 && ttl <= 30_000, String(ttl));

    const opened = await openHandoff(f, issued.code);
    assertEquals(opened.status, 303);
    assertEquals(opened.headers.get("location"), "/projects?tab=open");
    assertEquals(opened.headers.get("cache-control"), "no-store");
    assertEquals(opened.headers.get("referrer-policy"), "no-referrer");
    const setCookie = opened.headers.get("set-cookie")!;
    assertMatch(setCookie, /^better-auth\.session_token=/);
    assertMatch(setCookie, /HttpOnly/);
    assertMatch(setCookie, /SameSite=Lax/);
    assertMatch(setCookie, /Path=\//);

    const cookie = cookieOf(opened)!;
    const who = await me(f, cookie);
    assertEquals(who.status, 200, await who.clone().text());
    assertEquals((await who.json()).principalId, f.developerId);

    // A separate session: the desktop credential is not the cookie.
    assert(!cookie.includes(desktop.credential));
    const rows = await f.pgDatabase.query<
      { browser_session_id: string; consumed_at: Date | null }
    >(
      `select browser_session_id, consumed_at from bakery.desktop_handoffs
        where desktop_session_id = $1`,
      [desktop.sessionId],
    );
    assertEquals(rows.rows.length, 1);
    assert(rows.rows[0].consumed_at !== null);
    assert(rows.rows[0].browser_session_id !== desktop.sessionId);
    const stored = JSON.stringify(
      (await f.pgDatabase.query(
        "select * from bakery.desktop_handoffs where desktop_session_id = $1",
        [desktop.sessionId],
      )).rows,
    );
    assert(!stored.includes(issued.code), "only the code's digest is stored");

    const audit = await f.pgDatabase.query<
      { operation: string; details: unknown }
    >(
      `select operation, details from bakery.audit_events
        where resource_type = 'desktop_handoff' order by created_at`,
    );
    assertEquals(
      audit.rows.map((row) => row.operation),
      ["desktopHandoffs.create", "auth.desktopHandoff.redeem"],
    );
    assert(!JSON.stringify(audit.rows).includes(issued.code));
  });
});

Deno.test("a replayed code is refused and ends the browser session the first visit opened", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const { code } = await codeFor(f, desktop.credential);
    const first = await openHandoff(f, code);
    const cookie = cookieOf(first)!;
    assertEquals((await me(f, cookie)).status, 200);

    const replay = await openHandoff(f, code);
    assertEquals(replay.status, 303);
    assertEquals(replay.headers.get("location"), "/sign-in");
    assertEquals(replay.headers.get("set-cookie"), null);
    assertEquals((await me(f, cookie)).status, 401);
    // The desktop sign-in itself is untouched.
    const still = await f.app.fetch(bearerGet("/v1/me", desktop.credential));
    assertEquals(still.status, 200);
  });
});

Deno.test("an expired code is spent and refused with no session set", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const { code } = await codeFor(f, desktop.credential);
    await f.pgDatabase.query(
      `update bakery.desktop_handoffs set expires_at = now() - interval '1 second'
        where desktop_session_id = $1`,
      [desktop.sessionId],
    );
    const opened = await openHandoff(f, code);
    assertEquals(opened.status, 303);
    assertEquals(opened.headers.get("location"), "/sign-in");
    assertEquals(opened.headers.get("set-cookie"), null);
    const row = await f.pgDatabase.query<{ consumed_at: Date | null }>(
      "select consumed_at from bakery.desktop_handoffs where desktop_session_id = $1",
      [desktop.sessionId],
    );
    assert(row.rows[0].consumed_at !== null);
  });
});

Deno.test("a code whose desktop sign-in has ended opens nothing", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const { code } = await codeFor(f, desktop.credential);
    await f.pgDatabase.query("delete from public.session where id = $1", [
      desktop.sessionId,
    ]);
    const opened = await openHandoff(f, code);
    assertEquals(opened.headers.get("location"), "/sign-in");
    assertEquals(opened.headers.get("set-cookie"), null);
  });
});

Deno.test("a cross-site or same-site navigation is refused and leaves the code unspent", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const { code } = await codeFor(f, desktop.credential);
    for (const site of ["cross-site", "same-site"]) {
      const opened = await openHandoff(f, code, site);
      assertEquals(opened.status, 303);
      assertEquals(opened.headers.get("location"), "/sign-in");
      assertEquals(opened.headers.get("set-cookie"), null);
    }
    // The app's own navigation still works.
    const own = await openHandoff(f, code, "none");
    assert(cookieOf(own) !== null);
  });
});

Deno.test("only the desktop app's sign-in can ask for a code", async () => {
  await withFixture(async (f) => {
    const browser = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/desktop-handoffs`, {
        method: "POST",
        headers: {
          cookie: f.developerCookie,
          origin: authTestOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ returnTo: "/projects" }),
      }),
    );
    assertEquals(browser.status, 403, await browser.clone().text());
    const anonymous = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/desktop-handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: authTestOrigin },
        body: JSON.stringify({ returnTo: "/projects" }),
      }),
    );
    assertEquals(anonymous.status, 401);
  });
});

Deno.test("a return path that leaves the origin, or loops into the handoff, is refused", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    for (
      const returnTo of [
        "//evil.example/x",
        "https://evil.example/",
        "/\\evil.example",
        "projects",
        "/api/desktop/handoff",
        "/.//evil.example",
        "/a/..//evil.example",
        "/%2e//evil.example",
      ]
    ) {
      const response = await createHandoff(f, desktop.credential, returnTo);
      assertEquals(response.status, 422, returnTo);
    }
  });
});

Deno.test("each person's code opens a session for that person only", async () => {
  await withFixture(async (f) => {
    const developer = await signInDesktop(f, f.developerCookie);
    const admin = await signInDesktop(f, f.adminCookie);
    const developerCode = (await codeFor(f, developer.credential)).code;
    const adminCode = (await codeFor(f, admin.credential)).code;
    const asAdmin = cookieOf(await openHandoff(f, adminCode))!;
    const asDeveloper = cookieOf(await openHandoff(f, developerCode))!;
    assertEquals((await (await me(f, asAdmin)).json()).principalId, f.adminId);
    assertEquals(
      (await (await me(f, asDeveloper)).json()).principalId,
      f.developerId,
    );
  });
});

Deno.test("signing the desktop app out ends the browser sessions it handed off", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const cookie = cookieOf(
      await openHandoff(f, (await codeFor(f, desktop.credential)).code),
    )!;
    assertEquals((await me(f, cookie)).status, 200);
    const signOut = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me/sessions/revoke-current`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktop.credential}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: "{}",
      }),
    );
    assertEquals(signOut.status, 200, await signOut.clone().text());
    assertEquals((await me(f, cookie)).status, 401);
  });
});

Deno.test("revoking the Bakery app from the sessions list ends its window sessions too", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const cookie = cookieOf(
      await openHandoff(f, (await codeFor(f, desktop.credential)).code),
    )!;
    const revoked = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me/sessions/${desktop.sessionId}`, {
        method: "DELETE",
        headers: {
          cookie: f.developerCookie,
          origin: authTestOrigin,
          "idempotency-key": crypto.randomUUID(),
        },
      }),
    );
    assertEquals(revoked.status, 200, await revoked.clone().text());
    assertEquals((await me(f, cookie)).status, 401);
    // The person's own browser sign-in is untouched.
    assertEquals((await me(f, f.developerCookie)).status, 200);
  });
});

Deno.test("a handed-off session never outlives the desktop sign-in it came from", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    // Asking for a code renews the desktop sign-in, so shorten it after.
    const { code } = await codeFor(f, desktop.credential);
    await f.pgDatabase.query(
      `update public.session set "expiresAt" = now() + interval '1 hour'
        where id = $1`,
      [desktop.sessionId],
    );
    const opened = await openHandoff(f, code);
    const maxAge = Number(
      /Max-Age=(\d+)/.exec(opened.headers.get("set-cookie")!)![1],
    );
    assert(maxAge > 0 && maxAge <= 3600, String(maxAge));
    const rows = await f.pgDatabase.query<{ browser: Date; desktop: Date }>(
      `select b."expiresAt" as browser, d."expiresAt" as desktop
         from bakery.desktop_handoffs h
         join public.session b on b.id = h.browser_session_id
         join public.session d on d.id = h.desktop_session_id
        where h.desktop_session_id = $1`,
      [desktop.sessionId],
    );
    assert(rows.rows[0].browser.getTime() <= rows.rows[0].desktop.getTime());
  });
});
Deno.test("signing out other sessions from the person's browser ends the app and its window sessions", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const cookie = cookieOf(
      await openHandoff(f, (await codeFor(f, desktop.credential)).code),
    )!;
    assertEquals((await me(f, cookie)).status, 200);
    const r = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me/sessions/revoke-others`, {
        method: "POST",
        headers: {
          cookie: f.developerCookie,
          origin: authTestOrigin,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: "{}",
      }),
    );
    const rt = await r.text();
    assertEquals(r.status, 200, rt);
    const win = (await me(f, cookie)).status;
    assertEquals(win, 401);
    assertEquals((await me(f, f.developerCookie)).status, 200);
  });
});

Deno.test("sign out other sessions asked from a window keeps that window", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const cookie = cookieOf(
      await openHandoff(f, (await codeFor(f, desktop.credential)).code),
    )!;
    const r = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/me/sessions/revoke-others`, {
        method: "POST",
        headers: {
          cookie,
          origin: authTestOrigin,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: "{}",
      }),
    );
    await r.body?.cancel();
    const own = (await me(f, cookie)).status;
    assertEquals(r.status, 200);
    assertEquals(own, 200);
  });
});

Deno.test("a replayed desktop sign-in code ends the window sessions it handed off", async () => {
  await withFixture(async (f) => {
    const desktop = await signInDesktop(f, f.developerCookie);
    const cookie = cookieOf(
      await openHandoff(f, (await codeFor(f, desktop.credential)).code),
    )!;
    assertEquals((await me(f, cookie)).status, 200);
    const replay = await exchangeDesktopSignIn(f, desktop.id, {
      code: desktop.code,
      codeVerifier: desktop.verifier,
    });
    await replay.body?.cancel();
    const win = (await me(f, cookie)).status;
    assertEquals(win, 401);
  });
});
