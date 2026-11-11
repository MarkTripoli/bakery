import { assertEquals } from "@std/assert";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  sessionCookie,
} from "../auth.ts";
import {
  type InstallationFixture,
  openInstallationFixture,
} from "../installation-settings.ts";
import { signIn } from "../account-settings.ts";
import { reservePort } from "./oidc-issuer.ts";
import type { SamlFaults } from "./saml-idp.ts";

export type SsoFixture = Awaited<ReturnType<typeof openSsoFixture>>;

/**
 * Real installation fixture (SSO plugins mounted) with the given extra
 * trusted origins, e.g. the local OIDC issuer.
 */
export async function openSsoFixture(trustedOrigins: string[] = []) {
  const f = await openInstallationFixture(true, {
    env: {
      BETTER_AUTH_TRUSTED_ORIGINS: [authTestOrigin, ...trustedOrigins].join(
        ",",
      ),
    },
  });
  return f;
}

/** JSON POST to the Better Auth passthrough with a session cookie. */
export function authPost(
  f: InstallationFixture,
  path: string,
  body: unknown,
  cookie: string,
  headers: HeadersInit = {},
) {
  return f.app.fetch(authRequest(path, body, { cookie, headers }));
}

export function authGet(
  f: InstallationFixture,
  path: string,
  cookie: string,
  headers: HeadersInit = {},
) {
  return f.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      headers: { cookie, origin: authTestOrigin, ...headers as object },
    }),
  );
}

export async function auditRows(
  f: InstallationFixture,
  operationPrefix: string,
  organizationId: string,
) {
  const rows = await f.pgDatabase.query<
    {
      operation: string;
      resourceId: string;
      details: unknown;
      principalId: string | null;
    }
  >(
    `select operation, resource_id as "resourceId", details, principal_id as "principalId"
     from bakery.audit_events
     where operation like $1 and organization_id = $2 order by created_at, id`,
    [`${operationPrefix}%`, organizationId],
  );
  return rows.rows;
}

export { assertEquals, cleanupAuthFixture, reservePort, sessionCookie, signIn };

/**
 * Drives one real OIDC authorization-code sign-in: asks Bakery for the
 * authorization URL, follows it at the local issuer, and delivers the code to
 * Bakery's callback. Returns the callback response and the session cookie when
 * one was issued.
 */
export async function signInWithSso(
  f: InstallationFixture,
  providerId: string,
  cookieJar = "",
  options: { state?: string } = {},
) {
  const start = await f.app.fetch(authRequest("/api/auth/sign-in/sso", {
    providerId,
    callbackURL: "/",
  }, { cookie: cookieJar || undefined }));
  const started = await start.json() as { url?: string };
  if (!started.url) {
    return { start, callback: start, cookie: null as string | null };
  }
  const authorize = await fetch(started.url, { redirect: "manual" });
  await authorize.body?.cancel();
  const target = new URL(authorize.headers.get("location")!);
  if (options.state) target.searchParams.set("state", options.state);
  const callback = await f.app.fetch(
    new Request(`${authTestOrigin}${target.pathname}${target.search}`, {
      headers: {
        cookie: [
          cookieJar,
          ...start.headers.getSetCookie().map((c) => c.split(";", 1)[0]),
        ]
          .filter(Boolean).join("; "),
      },
    }),
  );
  const session = callback.headers.getSetCookie().find((value) =>
    value.startsWith("better-auth.session_token=")
  );
  return {
    start,
    callback,
    cookie: session ? session.split(";", 1)[0] : null,
  };
}

export const SECRET_MARKERS = [
  "oidc-client-secret-must-never-be-audited",
  "BEGIN CERTIFICATE",
  "PRIVATE KEY",
];

export async function registerOidc(
  f: InstallationFixture,
  issuer: { issuer: string; clientId: string; clientSecret: string },
  overrides: Record<string, unknown> = {},
  cookie = f.adminCookie,
) {
  return await authPost(f, "/api/auth/sso/register", {
    providerId: "oidc-acme",
    issuer: issuer.issuer,
    domain: "example.test",
    organizationId: f.organizationId,
    oidcConfig: {
      clientId: issuer.clientId,
      clientSecret: issuer.clientSecret,
      discoveryEndpoint: `${issuer.issuer}/.well-known/openid-configuration`,
      scopes: ["openid", "email", "profile"],
      pkce: true,
    },
    ...overrides,
  }, cookie);
}

export async function registerSaml(
  f: InstallationFixture,
  idp: { entityID: string; ssoUrl: string; certificatePem: string },
  overrides: Record<string, unknown> = {},
  cookie = f.adminCookie,
) {
  return await authPost(f, "/api/auth/sso/register", {
    providerId: "saml-acme",
    issuer: `${authTestOrigin}/saml-sp`,
    domain: "example.test",
    organizationId: f.organizationId,
    samlConfig: {
      entryPoint: idp.ssoUrl,
      cert: idp.certificatePem,
      callbackUrl: `${authTestOrigin}/`,
      audience: `${authTestOrigin}/saml-sp`,
      wantAssertionsSigned: true,
      identifierFormat:
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      idpMetadata: {
        entityID: idp.entityID,
        singleSignOnService: [{
          Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
          Location: idp.ssoUrl,
        }],
      },
    },
    ...overrides,
  }, cookie);
}

/**
 * DNS TXT lookup is the only way the provider marks a domain verified, and a
 * test cannot publish DNS records, so the tests flip the flag the lookup would
 * set. The domain-verification token request itself is exercised for real.
 */
export function markDomainVerified(f: InstallationFixture, providerId: string) {
  return f.pgDatabase.query(
    `update public."ssoProvider" set "domainVerified" = true where "providerId" = $1`,
    [providerId],
  );
}

/** Real SAML sign-in: AuthnRequest from Bakery, signed response from the IdP, ACS POST. */
export async function signInWithSaml(
  f: InstallationFixture,
  idp: {
    respond(
      url: string,
      metadata: string,
      email: string,
      faults?: SamlFaults,
    ): Promise<{ SAMLResponse: string; RelayState: string | null }>;
  },
  providerId: string,
  email: string,
  options: {
    tamper?: (samlResponse: string) => string;
    faults?: SamlFaults;
    /** Deliver the same response twice; the second result is returned as `replay`. */
    replay?: boolean;
  } = {},
) {
  const { tamper, faults } = options;
  const start = await f.app.fetch(authRequest("/api/auth/sign-in/sso", {
    providerId,
    callbackURL: "/",
  }));
  const started = await start.json() as { url?: string };
  if (!started.url) return { start, acs: start, cookie: null as string | null };
  const metadata = await (await f.app.fetch(
    new Request(
      `${authTestOrigin}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`,
    ),
  )).text();
  const form = await idp.respond(started.url, metadata, email, faults);
  const deliver = () =>
    f.app.fetch(
      new Request(`${authTestOrigin}/api/auth/sso/saml2/sp/acs/${providerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: start.headers.getSetCookie().map((c) => c.split(";", 1)[0])
            .join("; "),
        },
        body: new URLSearchParams({
          SAMLResponse: tamper ? tamper(form.SAMLResponse) : form.SAMLResponse,
          ...(form.RelayState ? { RelayState: form.RelayState } : {}),
        }),
      }),
    );
  const sessionOf = (response: Response) => {
    const session = response.headers.getSetCookie().find((value) =>
      value.startsWith("better-auth.session_token=")
    );
    return session ? session.split(";", 1)[0] : null;
  };
  const acs = await deliver();
  const replayed = options.replay ? await deliver() : undefined;
  return {
    start,
    acs,
    cookie: sessionOf(acs),
    replay: replayed
      ? { response: replayed, cookie: sessionOf(replayed) }
      : undefined,
  };
}

export async function sessionEmail(f: InstallationFixture, cookie: string) {
  const response = await authGet(f, "/api/auth/get-session", cookie);
  const body = await response.json() as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

export async function passwordSignIn(
  f: InstallationFixture,
  email: string,
  password: string,
) {
  return await f.app.fetch(
    authRequest("/api/auth/sign-in/email", { email, password }),
  );
}

export async function providerCount(f: InstallationFixture) {
  const rows = await f.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from public."ssoProvider"`,
  );
  return Number(rows.rows[0].count);
}
