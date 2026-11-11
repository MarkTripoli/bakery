import { assert, assertEquals } from "@std/assert";
import { registerOAuthClient } from "../../apps/server/src/modules/auth/index.ts";
import { authTestOrigin } from "./auth.ts";
import type { Fixture } from "./account-settings.ts";

/** Anything that serves requests: the in-process app or a real stack behind `fetch`. */
export type Driver = {
  app: { fetch(request: Request): Response | Promise<Response> };
};

/** MCP revision the Bakery resource serves; the wire profile has no handshake. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_URL = `${authTestOrigin}/mcp`;
export const MCP_RESOURCE = MCP_URL;
export const OAUTH_ISSUER = `${authTestOrigin}/api/auth`;
export const TEST_REDIRECT_URI = "http://127.0.0.1:43111/callback";
export const READ_AND_OPERATE = ["bakery:read", "bakery:operate"] as const;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/** A fresh PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<
  { verifier: string; challenge: string }
> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Registers a public client through the same code path as the server task. */
export async function registerTestClient(
  fixture: Fixture,
  options: {
    name?: string;
    scopes?: readonly string[];
    redirectUris?: readonly string[];
  } = {},
): Promise<string> {
  return await registerOAuthClient(
    { pgDatabase: fixture.pgDatabase, config: fixture.config.auth! },
    {
      name: options.name ?? `Test client ${crypto.randomUUID().slice(0, 8)}`,
      redirectUris: options.redirectUris ?? [TEST_REDIRECT_URI],
      scopes: options.scopes ?? READ_AND_OPERATE,
    },
  );
}

export type AuthorizeOptions = {
  clientId: string;
  cookie?: string;
  scope?: string;
  challenge?: string | null;
  redirectUri?: string;
  state?: string;
  resource?: string | null;
};

export function authorizeUrl(options: AuthorizeOptions): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? TEST_REDIRECT_URI,
    scope: options.scope ?? READ_AND_OPERATE.join(" "),
    state: options.state ?? "state-" + crypto.randomUUID(),
  });
  if (options.challenge !== null && options.challenge !== undefined) {
    params.set("code_challenge", options.challenge);
    params.set("code_challenge_method", "S256");
  }
  if (options.resource !== null) {
    params.set("resource", options.resource ?? MCP_RESOURCE);
  }
  return `${authTestOrigin}/api/auth/oauth2/authorize?${params}`;
}

export async function authorize(
  fixture: Driver,
  options: AuthorizeOptions,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(authorizeUrl(options), {
      headers: options.cookie ? { cookie: options.cookie } : {},
    }),
  );
}

/** Query string of the consent redirect: the signed `oauth_query` the consent POST needs. */
export async function consentQuery(response: Response): Promise<string> {
  assertEquals(
    response.status,
    302,
    `authorize should redirect to consent: ${await response.clone().text()}`,
  );
  const location = response.headers.get("location");
  assert(location !== null, "authorize redirect has a location");
  const url = new URL(location, authTestOrigin);
  assertEquals(url.pathname, "/oauth/consent");
  return url.search.slice(1);
}

/** Accepts (or denies) a consent and returns the redirect URL the provider issued. */
export async function submitConsent(
  fixture: Driver,
  options: {
    cookie: string;
    oauthQuery: string;
    accept?: boolean;
    scope?: string;
  },
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: authTestOrigin,
        cookie: options.cookie,
      },
      body: JSON.stringify({
        accept: options.accept ?? true,
        oauth_query: options.oauthQuery,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      }),
    }),
  );
}

/** The authorization code carried by a consent or authorize redirect. */
export async function codeFrom(response: Response): Promise<string> {
  let location = response.headers.get("location");
  if (!location) {
    const body = await response.clone().json() as { url?: string };
    location = body.url ?? null;
  }
  assert(location !== null, "response carries a redirect");
  const url = new URL(location);
  const code = url.searchParams.get("code");
  assert(code !== null, `redirect carries a code: ${location}`);
  return code;
}

export async function exchangeCode(
  fixture: Driver,
  options: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri?: string;
    resource?: string | null;
  },
): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? TEST_REDIRECT_URI,
    code_verifier: options.verifier,
  });
  if (options.resource !== null) {
    form.set("resource", options.resource ?? MCP_RESOURCE);
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
  );
}

/** Runs authorize → consent → token and returns the access token and grant context. */
export async function connectClient(
  fixture: Driver,
  options: {
    cookie: string;
    clientId: string;
    scope?: string;
    resource?: string;
  },
): Promise<{ accessToken: string; code: string; verifier: string }> {
  const { verifier, challenge } = await pkcePair();
  const authorized = await authorize(fixture, {
    clientId: options.clientId,
    cookie: options.cookie,
    challenge,
    scope: options.scope,
    resource: options.resource,
  });
  const oauthQuery = await consentQuery(authorized);
  const consent = await submitConsent(fixture, {
    cookie: options.cookie,
    oauthQuery,
  });
  assertEquals(consent.status, 200, await consent.clone().text());
  const code = await codeFrom(consent);
  const token = await exchangeCode(fixture, {
    clientId: options.clientId,
    code,
    verifier,
    resource: options.resource,
  });
  assertEquals(token.status, 200, await token.clone().text());
  const { access_token: accessToken } = await token.json() as {
    access_token: string;
  };
  return { accessToken, code, verifier };
}

export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    token?: string | null;
    scheme?: string;
    headers?: Record<string, string>;
    verb?: string;
    body?: string;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": method,
  });
  if (method === "tools/call" && typeof params.name === "string") {
    headers.set("mcp-name", params.name);
  }
  if (options.token) {
    headers.set(
      "authorization",
      `${options.scheme ?? "Bearer"} ${options.token}`,
    );
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  const verb = options.verb ?? "POST";
  return new Request(MCP_URL, {
    method: verb,
    headers,
    body: verb === "GET" || verb === "HEAD"
      ? undefined
      : options.body ?? JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "bakery-test-client",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
  });
}

export type McpResult = {
  result?: {
    content?: { type: string; text: string }[];
    tools?: { name: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

export async function callTool(
  fixture: Driver,
  token: string,
  name: string,
): Promise<Response> {
  return await fixture.app.fetch(
    mcpRequest("tools/call", { name, arguments: {} }, { token }),
  );
}

export async function listTools(
  fixture: Driver,
  token: string,
): Promise<string[]> {
  const response = await fixture.app.fetch(
    mcpRequest("tools/list", {}, { token }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  const body = await response.json() as McpResult;
  return (body.result?.tools ?? []).map(({ name }) => name).sort();
}
