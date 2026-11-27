import { assert, assertEquals } from "@std/assert";
import { call } from "./installation-settings.ts";
import {
  BOT_TOKEN,
  clear,
  connectOnce,
  type Fixture,
  open,
  TEAM_ID,
} from "./slack-connect.ts";
import { SLACK_BOT_SCOPES } from "../../packages/integration-slack/src/server/provider.ts";
import { registerSlackInstallation } from "../../apps/server/src/modules/integrations/slack-receipts.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

export const APP_ID = "A0TESTAPP";
export const CLIENT_ID = "1234.5678";
export const KEY_ID = "slack-identity-test-key";
export const SLACK_USER = "U0MEMBER01";
export const IDENTITY_CALLBACK = "/v1/integration-auth/slack/identity-callback";

export type SigningKey = Readonly<{
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}>;

export async function signingKey(kid = KEY_ID): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");

const encodeJson = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signIdToken(
  key: SigningKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const head = `${encodeJson({ alg: "RS256", typ: "JWT", kid: key.jwk.kid })}.${
    encodeJson(claims)
  }`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key.privateKey,
      new TextEncoder().encode(head),
    ),
  );
  return `${head}.${base64url(signature)}`;
}

export function identityClaims(
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const subject = typeof overrides.sub === "string"
    ? overrides.sub
    : SLACK_USER;
  return {
    iss: "https://slack.com",
    aud: CLIENT_ID,
    sub: subject,
    "https://slack.com/user_id": subject,
    "https://slack.com/team_id": TEAM_ID,
    nonce,
    iat: now,
    exp: now + 300,
    auth_time: now,
    ...overrides,
  };
}

type Call = { url: string; body: string; authorization: string | null };

export function fakeSlackIdentity(key: SigningKey) {
  const calls: Call[] = [];
  const state: {
    idToken: string | null;
    tokenOk: boolean;
    keys: JsonWebKey[];
  } = { idToken: null, tokenOk: true, keys: [key.jwk] };
  const respond = (input: URL, init: RequestInit): Response => {
    const headers = new Headers(init.headers);
    const body = init.body instanceof URLSearchParams
      ? init.body.toString()
      : init.body === undefined || init.body === null
      ? ""
      : new TextDecoder().decode(init.body as Uint8Array);
    calls.push({
      url: input.href,
      body,
      authorization: headers.get("authorization"),
    });
    if (input.href === "https://slack.com/api/oauth.v2.access") {
      return Response.json({
        ok: true,
        access_token: BOT_TOKEN,
        token_type: "bot",
        scope: SLACK_BOT_SCOPES.join(","),
        bot_user_id: "U0TESTBOT",
        app_id: APP_ID,
        team: { id: TEAM_ID, name: "Test Workspace" },
        enterprise: null,
        authed_user: { id: "U0TESTUSER" },
      });
    }
    if (input.href === "https://slack.com/api/auth.test") {
      return Response.json({
        ok: headers.get("authorization") === `Bearer ${BOT_TOKEN}`,
        team_id: TEAM_ID,
        team: "Test Workspace",
        bot_id: "B0TESTBOT",
      });
    }
    if (input.href === "https://slack.com/api/openid.connect.token") {
      if (!state.tokenOk || state.idToken === null) {
        return Response.json({ ok: false, error: "invalid_code" });
      }
      return Response.json({
        ok: true,
        access_token: "xoxp-identity-access",
        token_type: "Bearer",
        id_token: state.idToken,
      });
    }
    if (input.href === "https://slack.com/openid/connect/keys") {
      return Response.json({ keys: state.keys });
    }
    return new Response("not found", { status: 404 });
  };
  const fetch = (input: URL, init: RequestInit) =>
    Promise.resolve(respond(input, init));
  return { calls, fetch, state, issued: { token: BOT_TOKEN } };
}

export async function openLinking() {
  const key = await signingKey();
  const slack = fakeSlackIdentity(key);
  const o = await open(slack);
  await clearIdentityRows(o.fixture);
  return {
    ...o,
    key,
    slack,
    finish: async () => {
      try {
        await clearIdentityRows(o.fixture);
      } finally {
        await o.finish();
      }
    },
  };
}

export async function registerWorkspace(
  fixture: Fixture,
  organizationId: string = fixture.organizationId,
  teamId: string = TEAM_ID,
) {
  const registered = await withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      registerSlackInstallation(transaction, {
        organizationId,
        installation: {
          kind: "workspace",
          appId: APP_ID,
          teamId,
          botUserId: "U0TESTBOT",
          scopes: [],
        },
      }),
  );
  assert(registered.ok, JSON.stringify(registered));
}

export async function connectWorkspace(
  o: Awaited<ReturnType<typeof openLinking>>,
) {
  const connectionId = await connectOnce(o);
  await registerWorkspace(o.fixture);
  return connectionId;
}

export async function clearIdentityRows(fixture: Fixture) {
  const pg = fixture.pgDatabase;
  await pg.query(
    "delete from bakery.slack_identity_attempts where app_id = $1",
    [APP_ID],
  );
  await pg.query(
    "delete from bakery.external_identity_links where provider = 'slack' and external_app_id = $1",
    [APP_ID],
  );
  await pg.query(
    "delete from bakery.slack_installations where app_id = $1",
    [APP_ID],
  );
}

export async function clearLinking(fixture: Fixture) {
  await clearIdentityRows(fixture);
  await clear(fixture);
}

export function orgHeaders(organizationId: string): Record<string, string> {
  return { "Bakery-Organization-Id": organizationId };
}

export function readLink(
  fixture: Fixture,
  cookie: string,
  organizationId: string = fixture.organizationId,
) {
  return call(fixture, "GET", "/v1/me/slack-link", cookie, {
    headers: orgHeaders(organizationId),
  });
}

export function unlink(
  fixture: Fixture,
  cookie: string,
  organizationId: string = fixture.organizationId,
) {
  return call(fixture, "DELETE", "/v1/me/slack-link", cookie, {
    body: {},
    headers: orgHeaders(organizationId),
  });
}

export function startLink(
  fixture: Fixture,
  cookie: string,
  organizationId: string = fixture.organizationId,
) {
  return call(fixture, "POST", "/v1/me/slack-link/attempts", cookie, {
    body: {},
    headers: orgHeaders(organizationId),
  });
}

export async function startedLink(fixture: Fixture, cookie: string) {
  const response = await startLink(fixture, cookie);
  assertEquals(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    authorizationUrl: string;
    expiresAt: string;
  };
  const url = new URL(body.authorizationUrl);
  return {
    ...body,
    url,
    state: url.searchParams.get("state")!,
    nonce: url.searchParams.get("nonce")!,
  };
}

export function identityCallback(
  fixture: Fixture,
  cookie: string,
  query: Record<string, string>,
) {
  return call(
    fixture,
    "GET",
    `${IDENTITY_CALLBACK}?${new URLSearchParams(query)}`,
    cookie,
  );
}

export function linkResult(response: Response): string | null {
  assertEquals(response.status, 303);
  const location = new URL(response.headers.get("location")!, "https://x");
  assertEquals(location.pathname, "/settings/security");
  assertEquals(location.hash, "#slack");
  assertEquals([...location.searchParams.keys()], ["slackLink"]);
  return location.searchParams.get("slackLink");
}

export async function completeLink(
  o: Awaited<ReturnType<typeof openLinking>>,
  cookie: string,
  overrides: Record<string, unknown> = {},
  key: SigningKey = o.key,
): Promise<string | null> {
  const started = await startedLink(o.fixture, cookie);
  o.slack.state.idToken = await signIdToken(
    key,
    identityClaims(started.nonce, overrides),
  );
  return linkResult(
    await identityCallback(o.fixture, cookie, {
      code: "identity-code",
      state: started.state,
    }),
  );
}

export async function linkRows(fixture: Fixture, organizationId?: string) {
  return (await fixture.pgDatabase.query<
    {
      principal_id: string;
      state: string;
      revoke_reason: string | null;
      version: number;
    }
  >(
    `select principal_id, state, revoke_reason, version
       from bakery.external_identity_links
      where provider = 'slack' and external_app_id = $1
        and organization_id = $2
      order by created_at`,
    [APP_ID, organizationId ?? fixture.organizationId],
  )).rows;
}

export async function attemptRow(fixture: Fixture, state: string) {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    ),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (await fixture.pgDatabase.query<
    { status: string; failure_code: string | null }
  >(
    "select status, failure_code from bakery.slack_identity_attempts where state_hash = $1",
    [hash],
  )).rows[0];
}
