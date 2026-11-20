import { assert, assertEquals, assertFalse } from "@std/assert";
import { Hono } from "hono";
import {
  base64Url,
  canonicalDesktopRedirect,
  claimsDesktopCredential,
  constantTimeEqual,
  DESKTOP_APP_LINK_REDIRECT,
  DESKTOP_CLIENT_ID,
  desktopAuthorization,
  desktopCredentialFromAuthorization,
  desktopSessionLabel,
  DesktopSignInDecision,
  DesktopSignInRefusal,
  type DesktopSignInRequestState,
  desktopSocketUpgrade,
  exchangeRefusalFor,
  generateDesktopCredential,
  normalizeComputerName,
  pageStateFor,
  pkceMatches,
  randomSecret,
  sha256Base64Url,
} from "../../apps/server/src/modules/auth/domain/desktop-sign-in.ts";
import {
  minutesSince,
  render,
  renderConfirmPage,
  signInPage,
} from "../../apps/server/src/modules/auth/transport/http/desktop-sign-in-pages.ts";
import {
  createOriginGuard,
  desktopSessionHeaders,
  readSessionToken,
} from "../../apps/server/src/modules/auth/middleware.ts";

const now = new Date("2026-11-19T12:00:00Z");
const later = new Date(now.getTime() + 60_000);
const earlier = new Date(now.getTime() - 1);
const secret = "desktop-sign-in-unit-secret-value-32-bytes";

function request(
  overrides: Partial<DesktopSignInRequestState> = {},
): DesktopSignInRequestState {
  return {
    clientId: DESKTOP_CLIENT_ID,
    expiresAt: later,
    decision: null,
    consumedAt: null,
    ...overrides,
  };
}

Deno.test("a credential is bkd_ plus 43 base64url characters and parses only from a Bearer header", () => {
  const credential = generateDesktopCredential();
  assert(/^bkd_[A-Za-z0-9_-]{43}$/.test(credential), credential);
  assertEquals(
    desktopCredentialFromAuthorization(`Bearer ${credential}`),
    credential,
  );
  assertEquals(
    desktopCredentialFromAuthorization(`Bearer\t${credential}`),
    credential,
  );
  assertEquals(desktopCredentialFromAuthorization(credential), null);
  assertEquals(
    desktopCredentialFromAuthorization(`Bearer ${credential}x`),
    null,
  );
  assertEquals(desktopCredentialFromAuthorization("Bearer bky_abc"), null);
  assertEquals(desktopCredentialFromAuthorization(null), null);
  assert(claimsDesktopCredential("Bearer bkd_short"));
  assertFalse(claimsDesktopCredential("Bearer bky_" + randomSecret()));
  assertFalse(claimsDesktopCredential(null));
});

Deno.test("PKCE S256 matches only the verifier its challenge came from", async () => {
  // RFC 7636 appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assertEquals(await sha256Base64Url(verifier), challenge);
  assert(await pkceMatches(verifier, challenge));
  assertFalse(await pkceMatches(verifier.replace("d", "e"), challenge));
  assertFalse(await pkceMatches("short", challenge));
  assertFalse(await pkceMatches(verifier, challenge.slice(1)));
  assertFalse(await pkceMatches(verifier, verifier));
});

Deno.test("constant-time comparison agrees with equality", () => {
  assert(constantTimeEqual("abc", "abc"));
  assertFalse(constantTimeEqual("abc", "abd"));
  assertFalse(constantTimeEqual("abc", "abcd"));
  assertFalse(constantTimeEqual("", "a"));
  assertEquals(base64Url(new Uint8Array([251, 255])), "-_8");
});

Deno.test("only loopback IP literals with a port, or the app link, are redirect addresses", () => {
  assertEquals(
    canonicalDesktopRedirect("http://127.0.0.1:53682/callback"),
    "http://127.0.0.1:53682/callback",
  );
  assertEquals(
    canonicalDesktopRedirect("http://[::1]:53682/"),
    "http://[::1]:53682/",
  );
  assertEquals(
    canonicalDesktopRedirect(DESKTOP_APP_LINK_REDIRECT),
    DESKTOP_APP_LINK_REDIRECT,
  );
  for (
    const refused of [
      "http://localhost:53682/callback",
      "https://127.0.0.1:53682/callback",
      "http://127.0.0.1/callback",
      "http://127.0.0.1:53682/callback?x=1",
      "http://127.0.0.1:53682/callback#x",
      "http://user:pass@127.0.0.1:53682/",
      "http://evil.example:53682/",
      "bakery://auth/callback?x=1",
      "bakery://other",
      "not a url",
    ]
  ) assertEquals(canonicalDesktopRedirect(refused), null, refused);
});

Deno.test("computer names are trimmed, bounded and free of control characters", () => {
  assertEquals(normalizeComputerName("  Mark's MacBook  "), "Mark's MacBook");
  assertEquals(normalizeComputerName("   "), null);
  assertEquals(normalizeComputerName("a".repeat(65)), null);
  assertEquals(normalizeComputerName("a".repeat(64)), "a".repeat(64));
  assertEquals(normalizeComputerName("bad\nname"), null);
  assertEquals(normalizeComputerName("bad\u2028name"), null);
  assertEquals(normalizeComputerName("bad\u0085name"), null);
  assertEquals(desktopSessionLabel("Studio"), "Bakery app · Studio");
});

Deno.test("the browser page shows confirm only for a live, unanswered request", () => {
  assertEquals(pageStateFor(null, now), "missing");
  assertEquals(pageStateFor(request({ clientId: "other" }), now), "missing");
  assertEquals(pageStateFor(request(), now), "confirm");
  assertEquals(pageStateFor(request({ expiresAt: earlier }), now), "expired");
  assertEquals(pageStateFor(request({ expiresAt: now }), now), "expired");
  assertEquals(
    pageStateFor(request({ decision: DesktopSignInDecision.Approved }), now),
    "used",
  );
  assertEquals(
    pageStateFor(request({ decision: DesktopSignInDecision.Cancelled }), now),
    "cancelled",
  );
  assertEquals(
    pageStateFor(
      request({
        decision: DesktopSignInDecision.Cancelled,
        consumedAt: earlier,
      }),
      now,
    ),
    "used",
  );
  assertEquals(
    pageStateFor(
      request({ expiresAt: earlier, decision: DesktopSignInDecision.Approved }),
      now,
    ),
    "used",
  );
});

Deno.test("exchange refusals name a reason and say whether they spend or revoke", () => {
  const approved = request({ decision: DesktopSignInDecision.Approved });
  assertEquals(exchangeRefusalFor(approved, DESKTOP_CLIENT_ID, now), null);
  assertEquals(
    exchangeRefusalFor(
      { ...approved, consumedAt: earlier },
      DESKTOP_CLIENT_ID,
      now,
    ),
    { reason: DesktopSignInRefusal.Used, burn: false, revokeIssued: true },
  );
  assertEquals(
    exchangeRefusalFor(approved, "someone-else", now),
    { reason: DesktopSignInRefusal.Mismatch, burn: true, revokeIssued: false },
  );
  assertEquals(
    exchangeRefusalFor(
      { ...approved, clientId: "someone-else" },
      DESKTOP_CLIENT_ID,
      now,
    ),
    { reason: DesktopSignInRefusal.Mismatch, burn: true, revokeIssued: false },
  );
  assertEquals(
    exchangeRefusalFor(
      request({ decision: DesktopSignInDecision.Cancelled }),
      DESKTOP_CLIENT_ID,
      now,
    )?.reason,
    DesktopSignInRefusal.Cancelled,
  );
  assertEquals(
    exchangeRefusalFor(
      { ...approved, expiresAt: earlier },
      DESKTOP_CLIENT_ID,
      now,
    )?.reason,
    DesktopSignInRefusal.Expired,
  );
  assertEquals(
    exchangeRefusalFor(request(), DESKTOP_CLIENT_ID, now)?.reason,
    DesktopSignInRefusal.Pending,
  );
});

Deno.test("a desktop credential becomes exactly one signed session cookie and no Authorization", async () => {
  const credential = generateDesktopCredential();
  const headers = await desktopSessionHeaders(
    new Headers({
      authorization: `Bearer ${credential}`,
      cookie: "better-auth.session_token=someone-else.sig; theme=dark",
      "accept-language": "ar-XB",
    }),
    credential,
    secret,
  );
  assertFalse(headers.has("authorization"));
  assertEquals(headers.get("accept-language"), "ar-XB");
  const cookie = headers.get("cookie")!;
  assertFalse(cookie.includes("someone-else"));
  assertFalse(cookie.includes("theme"));
  assertEquals(await readSessionToken(headers, secret), credential);
  assertEquals(await readSessionToken(headers, "a-different-secret"), null);
});

Deno.test("live updates read the desktop credential from the Authorization header", async () => {
  const credential = generateDesktopCredential();
  assertEquals(
    await readSessionToken(
      new Headers({ authorization: `Bearer ${credential}` }),
      secret,
    ),
    credential,
  );
  assertEquals(
    await readSessionToken(
      new Headers({ authorization: `Bearer bky_${randomSecret()}` }),
      secret,
    ),
    null,
  );
});

Deno.test("the origin guard lets a desktop bearer through and still refuses cookies from other origins", async () => {
  const app = new Hono();
  app.use(
    "/v1/events",
    createOriginGuard({
      publicBaseUrl: "https://bakery.example",
      trustedOrigins: ["https://bakery.example"],
    }),
  );
  app.get("/v1/events", (context) => context.text("ok"));
  const call = (headers: HeadersInit) =>
    app.fetch(new Request("https://bakery.example/v1/events", { headers }));
  const credential = generateDesktopCredential();
  assertEquals(
    (await call({ authorization: `Bearer ${credential}` })).status,
    200,
  );
  assertEquals(
    (await call({ origin: "https://bakery.example" })).status,
    200,
  );
  const foreign = await call({
    origin: "https://evil.example",
    cookie: "better-auth.session_token=x.y",
  });
  assertEquals(foreign.status, 403);
  const malformed = await call({ authorization: "Bearer bkd_short" });
  assertEquals(malformed.status, 403);
  const accessToken = await call({
    authorization: `Bearer bky_${randomSecret()}`,
  });
  assertEquals(accessToken.status, 403);
});

Deno.test("the confirmation page renders in every locale with escaped values", async () => {
  for (const locale of ["en", "en-XA", "ar-XB"] as const) {
    const response = renderConfirmPage(locale, {
      name: "Ada <b>",
      email: "ada@example.test",
      computerName: 'Studio "1"',
      createdAt: new Date("2026-11-19T12:34:00Z"),
      requestId: "00000000-0000-4000-8000-000000000000",
    });
    assertEquals(response.status, 200, locale);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert(html.includes(`lang="${locale}"`), locale);
    assertEquals(html.includes('dir="rtl"'), locale === "ar-XB");
    assert(html.includes("Ada &lt;b&gt;") && !html.includes("Ada <b>"));
    assert(html.includes("Studio &quot;1&quot;"));
    assert(html.includes('datetime="2026-11-19T12:34:00.000Z"'));
    assert(html.includes('name="decision" value="continue"'));
  }
  const english = await renderConfirmPage("en", {
    name: "Ada",
    email: "ada@example.test",
    computerName: "Studio",
    createdAt: new Date("2026-11-19T12:34:00Z"),
    requestId: "r",
  }).text();
  assert(english.includes("Sign in to the Bakery app?"));
  assert(english.includes("Continue to the app"));
  assert(english.includes("Not Ada? Use another account"));
});

Deno.test("the confirm page says how long ago the app asked", async () => {
  const createdAt = new Date("2026-11-19T12:00:00Z");
  const page = (offsetMs: number) =>
    renderConfirmPage("en", {
      name: "Ada",
      email: "ada@example.test",
      computerName: "Studio",
      createdAt,
      requestId: "r",
      now: new Date(createdAt.getTime() + offsetMs),
    }).text();
  assert((await page(30_000)).includes(">just now</time>"));
  assert((await page(60_000)).includes(">1 minute ago</time>"));
  assert((await page(4 * 60_000 + 59_000)).includes(">4 minutes ago</time>"));
  assertEquals(minutesSince(createdAt, new Date(createdAt.getTime() - 1)), 0);
  const html = await page(0);
  assert(html.includes('aria-label="Bakery"') && html.includes("<svg"));
  assert(!html.includes("#1d4ed8"));
});

Deno.test("signed out: one Sign in button that remembers only this exact request", async () => {
  const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const response = render("en", signInPage("en", id));
  assertEquals(response.status, 401);
  const csp = response.headers.get("content-security-policy")!;
  const nonce = /script-src 'nonce-([a-f0-9]+)'/.exec(csp)?.[1];
  assert(nonce, csp);
  const html = await response.text();
  assert(html.includes("Sign in to continue"));
  assert(html.includes("the question comes back afterwards"));
  assertEquals(html.match(/class="button primary"/g)?.length, 1);
  assert(html.includes(`<script nonce="${nonce}">`));
  assert(html.includes('"bakery.auth.returnTo.v1"'));
  assert(
    html.includes(
      '"/api/desktop/sign-in?request=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
    ),
  );
  const unsafe = await render(
    "en",
    signInPage("en", '"></script><script>alert(1)</script>'),
  ).text();
  assertFalse(unsafe.includes("<script"));
});

Deno.test("a socket carries the desktop credential as a subprotocol, and nothing else does", () => {
  const credential = generateDesktopCredential();
  const upgrade = (protocols: string, extra: Record<string, string> = {}) =>
    new Headers({
      upgrade: "websocket",
      "sec-websocket-protocol": protocols,
      ...extra,
    });
  const carried = upgrade("bakery.desktop, bakery.credential." + credential);
  assertEquals(
    desktopAuthorization(carried, "/v1/events"),
    "Bearer " + credential,
  );
  assertEquals(
    desktopCredentialFromAuthorization(
      desktopAuthorization(carried, "/v1/events"),
    ),
    credential,
  );
  assertEquals(desktopSocketUpgrade(carried), { protocol: "bakery.desktop" });
  // The header wins when both are present.
  assertEquals(
    desktopAuthorization(
      upgrade("bakery.desktop", { authorization: "Bearer x" }),
      "/v1/events",
    ),
    "Bearer x",
  );
  // Not an upgrade, no desktop protocol, two credentials, or an access token.
  const plain = new Headers({
    "sec-websocket-protocol": "bakery.desktop, bakery.credential." + credential,
  });
  for (
    const headers of [
      plain,
      upgrade("bakery.credential." + credential),
      upgrade(
        "bakery.desktop, bakery.credential." + credential +
          ", bakery.credential." + credential,
      ),
      upgrade("bakery.desktop, bakery.credential.bky_" + randomSecret()),
    ]
  ) assertEquals(desktopAuthorization(headers, "/v1/events"), null);
  assertEquals(desktopSocketUpgrade(upgrade("chat")), {});
  // Any route but the two sockets ignores the carrier, upgrade or not.
  for (const path of ["/v1/me", "/v1/events/x", undefined]) {
    assertEquals(desktopAuthorization(carried, path), null, String(path));
  }
  assertEquals(
    desktopAuthorization(carried, "/v1/collaboration"),
    "Bearer " + credential,
  );
});
