import { assert, assertEquals, assertFalse } from "@std/assert";
import { Hono } from "hono";
import {
  base64Url,
  canonicalDesktopRedirect,
  claimsDesktopCredential,
  constantTimeEqual,
  DESKTOP_APP_LINK_REDIRECT,
  DESKTOP_CLIENT_ID,
  desktopCredentialFromAuthorization,
  desktopSessionLabel,
  DesktopSignInDecision,
  DesktopSignInRefusal,
  type DesktopSignInRequestState,
  exchangeRefusalFor,
  generateDesktopCredential,
  normalizeComputerName,
  pageStateFor,
  pkceMatches,
  randomSecret,
  sha256Base64Url,
} from "../../apps/server/src/modules/auth/domain/desktop-sign-in.ts";
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
