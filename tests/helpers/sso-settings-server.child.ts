/**
 * The real Bakery API on a real test database, a real local OpenID Provider and
 * a real UDP TXT DNS server in one process: the browser proof of the single
 * sign-on settings page (apps/web/tests/sso-real-api.spec.ts). Nothing is
 * stubbed on Bakery's side; the page's requests are forwarded to this API
 * unchanged.
 *
 * Usage: deno run -A --config deno.json
 *   tests/helpers/sso-settings-server.child.ts
 *
 * The API keeps the test public origin (`authTestOrigin`); the caller sends
 * that Origin. Prints one JSON line: the API URL, the control URL, the public
 * origin, the seeded Admin's and Developer's session cookies, the organization
 * id and the OpenID Provider the spec registers. The control server plays what
 * a person or an identity provider does outside the page:
 *
 * - POST /dns {name, value}: publish a TXT record the domain check will find.
 * - POST /password-sign-in {who}: password sign-in as the seeded "admin" or
 *   "developer"; answers the status, problem code and session cookies issued.
 * - POST /sso-sign-in {providerId}: the Developer signs in through the issuer.
 * - GET /state: the stored provider rows and the overview the page reads.
 *
 * Runs until stdin closes or SIGTERM, then removes what it seeded.
 */
import { authTestOrigin } from "./auth.ts";
import { startTxtDns } from "./dns-txt.ts";
import { reservePort, startOidcIssuer } from "./sso/oidc-issuer.ts";
import {
  authGet,
  openSsoFixture,
  passwordSignIn,
  sessionEmail,
  signInWithSso,
} from "./sso/sso-fixture.ts";

const issuer = await startOidcIssuer(reservePort());
const f = await openSsoFixture([issuer.issuer]);
const dns = await startTxtDns();

async function problemCode(response: Response): Promise<string | null> {
  const body = await response.clone().json().catch(() => ({})) as {
    code?: string;
  };
  return body.code ?? null;
}

/** Session cookies a response sets; a cleared cookie (Max-Age=0) is no session. */
function issuedSessions(response: Response): number {
  return response.headers.getSetCookie().filter((cookie) =>
    cookie.startsWith("better-auth.session_token=") &&
    !cookie.includes("Max-Age=0")
  ).length;
}

async function control(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/state") {
    const stored = await f.pgDatabase.query(
      `select "providerId", "organizationId", domain, issuer, "domainVerified"
       from public."ssoProvider" order by "providerId"`,
    );
    const overview = await (await authGet(
      f,
      `/api/auth/bakery-sso/providers?organizationId=${f.organizationId}`,
      f.adminCookie,
    )).json();
    return Response.json({ stored: stored.rows, overview });
  }
  const body = request.method === "POST"
    ? await request.json().catch(() => null) as Record<string, string> | null
    : null;
  if (body === null) {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (path === "/dns") {
    dns.publish(body.name, body.value);
    return Response.json({ published: body.name });
  }
  if (path === "/password-sign-in") {
    const email = body.who === "admin"
      ? f.adminEmail
      : body.who === "developer"
      ? f.developerEmail
      : null;
    if (email === null) {
      return Response.json({ error: "who is admin or developer" }, {
        status: 400,
      });
    }
    const response = await passwordSignIn(f, email, f.password);
    return Response.json({
      status: response.status,
      code: await problemCode(response),
      sessions: issuedSessions(response),
    });
  }
  if (path === "/sso-sign-in") {
    issuer.assert.email = f.developerEmail;
    const signedIn = await signInWithSso(f, body.providerId);
    return Response.json({
      signedIn: signedIn.cookie !== null,
      email: signedIn.cookie ? await sessionEmail(f, signedIn.cookie) : null,
      usedClientSecret: issuer.tokenRequests.some((request) =>
        request.includes(btoa(`${issuer.clientId}:${issuer.clientSecret}`))
      ),
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

const api = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  (request, info) => f.app.fetch(request, { remoteAddr: info.remoteAddr }),
);
const controller = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  control,
);
console.log(JSON.stringify({
  apiUrl: `http://127.0.0.1:${api.addr.port}`,
  controlUrl: `http://127.0.0.1:${controller.addr.port}`,
  publicOrigin: authTestOrigin,
  adminCookie: f.adminCookie,
  developerCookie: f.developerCookie,
  organizationId: f.organizationId,
  developerEmail: f.developerEmail,
  issuer: {
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
  },
}));
const stop = Promise.withResolvers<void>();
Deno.addSignalListener("SIGTERM", () => stop.resolve());
Deno.addSignalListener("SIGINT", () => stop.resolve());
try {
  await Promise.race([
    (async () => {
      const buffer = new Uint8Array(1);
      while (await Deno.stdin.read(buffer) !== null) {
        // Keep serving until the spec closes stdin.
      }
    })(),
    stop.promise,
  ]);
} finally {
  await api.shutdown();
  await controller.shutdown();
  try {
    await f.pgDatabase.query(`delete from public."ssoProvider"`);
  } finally {
    dns.close();
    await issuer.close();
    await f.finish();
  }
}
