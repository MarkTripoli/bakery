import { assertEquals } from "@std/assert";
import {
  createAuthProviderClient,
  type PasskeySummary,
} from "../../packages/contracts/src/auth-provider-client.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  type AppFixture,
  authRequest,
  authTestOrigin,
  get,
  sessionCookie,
} from "./auth.ts";
import {
  challengeCookie,
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "./webauthn.ts";

/** The plugin derives the RP ID from the public origin (`authTestOrigin`). */
export const passkeyRpId = "127.0.0.1";

type Fixture = Awaited<ReturnType<typeof import("./auth.ts").openAuthFixture>>;

/**
 * The typed provider client wired to the in-process app with its own cookie
 * jar, so the cookies a ceremony sets are echoed back like a browser would.
 */
export function clientWithJar(
  fixture: AppFixture,
  initialCookie?: string,
) {
  const jar = new Map<string, string>();
  const seed = (pair: string) => {
    const [name, ...rest] = pair.split("=");
    jar.set(name, rest.join("="));
  };
  if (initialCookie) seed(initialCookie);
  const fetchViaApp = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", authTestOrigin);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join(
      "; ",
    );
    if (cookie) headers.set("cookie", cookie);
    const response = await fixture.app.fetch(
      new Request(input, { ...init, headers }),
    );
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const [name, ...rest] = pair.split("=");
      const expired = attributes.some((attribute) =>
        /^\s*max-age=0\s*$/i.test(attribute)
      ) || rest.join("") === "";
      if (expired) jar.delete(name);
      else jar.set(name, rest.join("="));
    }
    return response;
  }) as typeof fetch;
  return {
    client: createAuthProviderClient({
      baseUrl: authTestOrigin,
      fetch: fetchViaApp,
    }),
    cookies: () =>
      [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    sessionCookie: () => {
      const value = jar.get("better-auth.session_token");
      return value === undefined ? null : `better-auth.session_token=${value}`;
    },
  };
}

export async function seedPasswordUser(
  fixture: Fixture,
  label: string,
): Promise<{ email: string; password: string }> {
  const suffix = crypto.randomUUID();
  const email = `${label}-${suffix}@example.test`;
  const password = `Account-${label}-${suffix}`;
  await createSuperuser({
    pgDatabase: fixture.pgDatabase,
    config: fixture.config.auth!,
  }, { email, displayName: label, password });
  return { email, password };
}

export async function passwordSignIn(
  fixture: AppFixture,
  email: string,
  password: string,
): Promise<string> {
  const response = await fixture.app.fetch(
    authRequest("/api/auth/sign-in/email", { email, password }),
  );
  assertEquals(response.status, 200);
  return sessionCookie(response);
}

/** Registers `authenticator` for the person behind `cookie` through the typed client. */
export async function registerWithClient(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
  cookie: string,
  name: string,
): Promise<{ passkey: PasskeySummary; sessionCookie: string }> {
  const session = clientWithJar(fixture, cookie);
  const options = await session.client.passkey.generateRegisterOptions({});
  const passkey = await session.client.passkey.verifyRegistration({
    response: await authenticator.register({ challenge: options.challenge }),
    name,
  });
  return { passkey, sessionCookie: cookie };
}

export async function newAuthenticator(): Promise<SoftwareAuthenticator> {
  return await createSoftwareAuthenticator({
    origin: authTestOrigin,
    rpId: passkeyRpId,
  });
}

/** Anonymous passkey sign-in ceremony; returns the session cookie it minted. */
export async function passkeySignIn(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
): Promise<string> {
  const optionsResponse = await fixture.app.fetch(
    get("/api/auth/passkey/generate-authenticate-options"),
  );
  assertEquals(optionsResponse.status, 200);
  const options = await optionsResponse.json() as { challenge: string };
  const response = await fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-authentication",
    {
      response: await authenticator.authenticate({
        challenge: options.challenge,
      }),
    },
    { cookie: challengeCookie(optionsResponse) },
  ));
  assertEquals(response.status, 200);
  return sessionCookie(response);
}

export async function meStatus(
  fixture: AppFixture,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fixture.app.fetch(get("/v1/me", cookie));
  return { status: response.status, body: await response.json() };
}
