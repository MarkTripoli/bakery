import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "./auth.ts";
import {
  base64Url,
  DESKTOP_CLIENT_ID,
  sha256Base64Url,
} from "../../apps/server/src/modules/auth/domain/desktop-sign-in.ts";

/** The slice of a fixture the desktop sign-in helpers drive. */
export type DesktopFixture = {
  app: {
    fetch(
      request: Request,
      env?: { remoteAddr: Deno.NetAddr },
    ): Response | Promise<Response>;
  };
  pgDatabase: {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rowCount: number | null }>;
  };
};

/** A distinct client address per call site, so per-address limits never couple tests. */
export function desktopClient(): { remoteAddr: Deno.NetAddr } {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  return {
    remoteAddr: {
      transport: "tcp",
      hostname: `10.${octet()}.${octet()}.${octet()}`,
      port: 40000,
    },
  };
}

export const DESKTOP_REDIRECT = "http://127.0.0.1:53682/callback";

export type StartedDesktopSignIn = {
  id: string;
  confirmUrl: string;
  expiresAt: string;
  verifier: string;
};

/** Every request id a test opened, so teardown can remove the rows. */
export const openedDesktopSignIns: string[] = [];

function json(path: string, body: unknown): Request {
  return new Request(`${authTestOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function startDesktopSignIn(
  f: DesktopFixture,
  env = desktopClient(),
  overrides: Record<string, unknown> = {},
): Promise<StartedDesktopSignIn> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const response = await f.app.fetch(
    json("/v1/desktop-sign-ins", {
      clientId: DESKTOP_CLIENT_ID,
      codeChallenge: await sha256Base64Url(verifier),
      codeChallengeMethod: "S256",
      redirectUri: DESKTOP_REDIRECT,
      computerName: "Test Studio",
      ...overrides,
    }),
    env,
  );
  assertEquals(response.status, 201, await response.clone().text());
  const body = await response.json() as Omit<StartedDesktopSignIn, "verifier">;
  openedDesktopSignIns.push(body.id);
  return { ...body, verifier };
}

/** GET of the browser confirmation page, as the person's browser sends it. */
export async function viewDesktopPage(
  f: DesktopFixture,
  id: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await f.app.fetch(
    new Request(
      `${authTestOrigin}/api/desktop/sign-in?request=${encodeURIComponent(id)}`,
      { headers },
    ),
  );
}

/** The browser's form answer on the confirmation page. */
export async function answerDesktopPage(
  f: DesktopFixture,
  cookie: string,
  id: string,
  decision: "continue" | "cancel",
  origin: string | null = authTestOrigin,
): Promise<Response> {
  const headers = new Headers({
    cookie,
    "content-type": "application/x-www-form-urlencoded",
  });
  if (origin !== null) headers.set("origin", origin);
  return await f.app.fetch(
    new Request(`${authTestOrigin}/api/desktop/sign-in`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ request: id, decision }).toString(),
    }),
  );
}

/** The one-time code in the done page's "Open the Bakery app" link. */
export async function codeFromDonePage(response: Response): Promise<string> {
  assertEquals(response.status, 200);
  const html = await response.text();
  const match = /href="(http:\/\/127\.0\.0\.1:53682\/callback\?[^"]+)"/.exec(
    html,
  );
  assert(match, "the done page links back to the app");
  const url = new URL(match[1].replaceAll("&amp;", "&"));
  return url.searchParams.get("code")!;
}

export async function exchangeDesktopSignIn(
  f: DesktopFixture,
  id: string,
  body: { code: string; codeVerifier: string; clientId?: string },
  env = desktopClient(),
): Promise<Response> {
  return await f.app.fetch(
    json(`/v1/desktop-sign-ins/${id}/credential`, {
      clientId: DESKTOP_CLIENT_ID,
      ...body,
    }),
    env,
  );
}

export type IssuedDesktopCredential = {
  id: string;
  code: string;
  verifier: string;
  credential: string;
  sessionId: string;
  expiresAt: string;
};

/** The whole handoff for the person signed in with `cookie`. */
export async function signInDesktop(
  f: DesktopFixture,
  cookie: string,
): Promise<IssuedDesktopCredential> {
  const started = await startDesktopSignIn(f);
  const code = await codeFromDonePage(
    await answerDesktopPage(f, cookie, started.id, "continue"),
  );
  const response = await exchangeDesktopSignIn(f, started.id, {
    code,
    codeVerifier: started.verifier,
  });
  assertEquals(response.status, 201, await response.clone().text());
  const issued = await response.json() as {
    credential: string;
    sessionId: string;
    expiresAt: string;
  };
  return { id: started.id, code, verifier: started.verifier, ...issued };
}

/** A GET the desktop app sends with its credential. */
export function bearerGet(
  path: string,
  credential: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${authTestOrigin}${path}`, {
    headers: { authorization: `Bearer ${credential}`, ...headers },
  });
}

/** A POST the desktop app sends with its credential alone: no cookie, no origin. */
export function bearerPost(
  path: string,
  credential: string,
  body: unknown = {},
): Request {
  return new Request(`${authTestOrigin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** A refusal's status and STATE_CONFLICT reason. */
export async function refusalOf(
  response: Response,
): Promise<{ status: number; code: string; reason?: string }> {
  const body = await response.json() as { code: string; reason?: string };
  return {
    status: response.status,
    code: body.code,
    ...(body.reason ? { reason: body.reason } : {}),
  };
}

export async function cleanupDesktopSignIns(f: DesktopFixture): Promise<void> {
  const ids = openedDesktopSignIns.splice(0);
  if (ids.length > 0) {
    await f.pgDatabase.query(
      "delete from bakery.desktop_sign_in_requests where id = any($1::uuid[])",
      [ids],
    );
  }
  await f.pgDatabase.query(
    `delete from public."rateLimit" where key like 'bakery-desktop-sign-in:%'`,
  );
}
