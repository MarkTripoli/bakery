import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { registerOAuthClient } from "../../apps/server/src/modules/auth/oauth-clients.ts";
import {
  cleanupAuthFixture,
  nextClientEnv,
  openAuthFixture,
} from "../helpers/auth.ts";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const origin = required("BAKERY_BROWSER_BASE_URL");
const url = new URL(origin);
// Chromium refuses WebAuthn on IP hosts, so the lane origin is
// `http://localhost:<port>`: loopback by name is the only origin a real
// browser accepts both as a secure context and as a WebAuthn relying party.
if (
  url.origin !== origin || url.protocol !== "http:" ||
  url.hostname !== "localhost" || !url.port
) {
  throw new Error("BAKERY_BROWSER_BASE_URL_INVALID");
}
const port = Number(url.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("BAKERY_BROWSER_BASE_URL_INVALID");
}

const email = required("BAKERY_BROWSER_EMAIL");
const password = required("BAKERY_BROWSER_PASSWORD");
const displayName = "Browser Admin";
const totpSuffix = crypto.randomUUID();
const totpEmail = `browser-totp-${totpSuffix}@example.test`;
const totpPassword = `Browser-Totp-${totpSuffix}`;
const passkeySuffix = crypto.randomUUID();
const passkeyEmail = `browser-passkey-${passkeySuffix}@example.test`;
const passkeyPassword = `Browser-Passkey-${passkeySuffix}`;
const fixture = await openAuthFixture({
  publicOrigin: origin,
  secret: required("BAKERY_BROWSER_AUTH_SECRET"),
});

try {
  // This server owns the lane's database. An OAuth token makes better-auth
  // store a signing key in public.jwks, encrypted with this run's random
  // secret; any key left by another lane (or an earlier run) cannot be
  // decrypted here, and ours could not be decrypted there. Clear it both ways.
  await fixture.pgDatabase.query("delete from public.jwks").catch(() => {});
  await createSuperuser({
    pgDatabase: fixture.pgDatabase,
    config: fixture.config.auth!,
  }, { email, displayName, password });
  const scope = await fixture.pgDatabase.query<{ organizationId: string }>(
    `select membership.organization_id as "organizationId"
     from bakery.organization_memberships as membership
     join bakery.principals as principal
       on principal.id = membership.principal_id
     join public."user" as provider_user
       on provider_user.id = principal.provider_user_id
     where provider_user.email = $1`,
    [email],
  );
  const organizationId = scope.rows[0]?.organizationId;
  if (!organizationId) throw new Error("BROWSER_EVENTS_ORGANIZATION_REQUIRED");
  const applicationId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'Browser events')`,
    [
      applicationId,
      organizationId,
      `browser-events-${applicationId.slice(0, 8)}`,
    ],
  );
  const authHtml = await Deno.readTextFile(
    new URL("./fixtures/auth.html", import.meta.url),
  );
  fixture.app.get(
    "/__test__/auth",
    (context) => context.html(authHtml, 200, { "cache-control": "no-store" }),
  );
  const eventsHtml = (await Deno.readTextFile(
    new URL("./fixtures/events.html", import.meta.url),
  )).replaceAll("__ORGANIZATION_ID__", organizationId).replaceAll(
    "__APPLICATION_ID__",
    applicationId,
  );
  fixture.app.get(
    "/__test__/events",
    (context) => context.html(eventsHtml, 200, { "cache-control": "no-store" }),
  );

  // `createSuperuser` enforces a single system-wide bootstrap admin, so a
  // second full superuser account for this fixture would conflict with the
  // primary `BAKERY_BROWSER_EMAIL` admin above. `auth.api.signUpEmail`
  // called server-side (no inbound HTTP request) bypasses the invite-only
  // gate the same way `createsuperuser.ts`'s own provider callback does,
  // and the provider's `user.create.after` hook creates the matching
  // `bakery.principals` row automatically; no organization membership is
  // needed since the two-factor endpoints under test don't require one.
  await fixture.auth.api.signUpEmail({
    body: {
      email: totpEmail,
      name: "Browser TOTP",
      password: totpPassword,
      rememberMe: false,
    },
  });
  const twoFactorHtml = await Deno.readTextFile(
    new URL("./fixtures/two-factor.html", import.meta.url),
  );
  fixture.app.get(
    "/__test__/two-factor",
    (context) =>
      context.html(twoFactorHtml, 200, { "cache-control": "no-store" }),
  );
  fixture.app.get(
    "/__test__/two-factor/credentials",
    (context) =>
      context.json({ email: totpEmail, password: totpPassword }, 200, {
        "cache-control": "no-store",
      }),
  );
  // A person with a password and no authenticator: the passkey spec enrolls
  // TOTP through the fixture itself, so it must start without one.
  await fixture.auth.api.signUpEmail({
    body: {
      email: passkeyEmail,
      name: "Browser Passkey",
      password: passkeyPassword,
      rememberMe: false,
    },
  });
  // OAuth for the MCP spec: one pre-registered public client whose redirect
  // URI is the callback fixture, the consent page at the provider's
  // configured path, and the callback that shows the code or error.
  const mcpRedirectUri = `${origin}/__test__/mcp/callback`;
  const mcpClientId = await registerOAuthClient(
    { pgDatabase: fixture.pgDatabase, config: fixture.config.auth! },
    {
      name: "Browser MCP client",
      redirectUris: [mcpRedirectUri],
      scopes: ["bakery:read", "bakery:operate"],
    },
  );
  const consentHtml = await Deno.readTextFile(
    new URL("./fixtures/oauth-consent.html", import.meta.url),
  );
  const callbackHtml = await Deno.readTextFile(
    new URL("./fixtures/oauth-callback.html", import.meta.url),
  );
  fixture.app.get(
    "/oauth/consent",
    (context) =>
      context.html(consentHtml, 200, { "cache-control": "no-store" }),
  );
  fixture.app.get(
    "/__test__/mcp/callback",
    (context) =>
      context.html(callbackHtml, 200, { "cache-control": "no-store" }),
  );
  fixture.app.get(
    "/__test__/mcp/credentials",
    (context) =>
      context.json(
        {
          email,
          password,
          clientId: mcpClientId,
          redirectUri: mcpRedirectUri,
        },
        200,
        { "cache-control": "no-store" },
      ),
  );
  const passkeysHtml = await Deno.readTextFile(
    new URL("./fixtures/passkeys.html", import.meta.url),
  );
  fixture.app.get(
    "/__test__/passkeys",
    (context) =>
      context.html(passkeysHtml, 200, { "cache-control": "no-store" }),
  );
  fixture.app.get(
    "/__test__/passkeys/credentials",
    (context) =>
      context.json({ email: passkeyEmail, password: passkeyPassword }, 200, {
        "cache-control": "no-store",
      }),
  );
  // The passkeys fixture renders the approved design from
  // docs/technical-design/auth-mocks (the exported Paper inputs the design
  // doc prescribes for workers). Only the stylesheet and the Geist fonts are
  // served, from a fixed allowlist, so the fixture has one source of truth
  // for tokens and layout instead of a copy.
  const designRoot = new URL("../../docs/technical-design/", import.meta.url);
  const designAssets: Record<string, string> = {
    "auth-mocks/auth.css": "text/css; charset=utf-8",
    "enterprise-mocks/fonts/geist-400.ttf": "font/ttf",
    "enterprise-mocks/fonts/geist-500.ttf": "font/ttf",
    "enterprise-mocks/fonts/geist-600.ttf": "font/ttf",
    "enterprise-mocks/fonts/geist-mono-400.ttf": "font/ttf",
  };
  fixture.app.get("/__test__/design/*", async (context) => {
    const asset = context.req.path.slice("/__test__/design/".length);
    const contentType = designAssets[asset];
    if (!contentType) return context.notFound();
    const body = await Deno.readFile(new URL(asset, designRoot));
    return context.body(body, 200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
  });
  // Every spec in this lane shares one server process, so a real per-
  // connection remote address (all loopback, 127.0.0.1) would put every
  // spec's `/sign-in/*` calls in the same rate-limit bucket; the browser
  // lane exercises the UI flow, not the limiter, so give each request its
  // own synthetic client instead (`tests/security/...` covers the limiter).
  const server = Deno.serve({
    // The page origin is `localhost`; bind the loopback IP explicitly so the
    // listener does not depend on how `localhost` resolves on this host.
    hostname: "127.0.0.1",
    port,
    onListen: () => {},
  }, (request) => fixture.app.fetch(request, nextClientEnv()));
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    shutdownPromise ??= (async () => {
      await server.shutdown();
      await server.finished;
    })();
  const stop = () => void shutdown();
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
  }
} finally {
  await fixture.pgDatabase.query("delete from public.jwks").catch(() => {});
  // The client and its grants are this run's own rows.
  await fixture.pgDatabase.query(
    `delete from public."oauthConsent" where "clientId" in
       (select "clientId" from public."oauthClient" where name = 'Browser MCP client')`,
  ).catch(() => {});
  await fixture.pgDatabase.query(
    `delete from public."oauthClient" where name = 'Browser MCP client'`,
  ).catch(() => {});
  await cleanupAuthFixture(fixture.pgDatabase, [
    email,
    totpEmail,
    passkeyEmail,
  ]);
  await fixture.close();
}
