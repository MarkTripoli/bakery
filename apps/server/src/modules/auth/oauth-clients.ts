import type { ServerAuthConfig } from "@bakery/config";
import type { PgDatabase } from "../../platform/database.ts";
import { isMcpScope, mcpResourceUrl } from "../../platform/mcp/scopes.ts";
import { createReadyAuthProvider } from "./adapters/better-auth.ts";
import { createPostgresAuthPersistence } from "./adapters/postgres.ts";

export type RegisterOAuthClientDependencies = {
  pgDatabase: PgDatabase;
  config: ServerAuthConfig;
};

export type RegisterOAuthClientInput = {
  name: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
};

/**
 * Registers one pre-registered public OAuth client (authorization code +
 * PKCE, no secret) and returns its client id. This is the only way a client
 * is created: dynamic registration is off and every HTTP create privilege is
 * denied. Redirect URIs must be HTTPS or loopback HTTP; scopes are limited
 * to the ones the MCP resource defines.
 */
export async function registerOAuthClient(
  { pgDatabase, config }: RegisterOAuthClientDependencies,
  input: RegisterOAuthClientInput,
): Promise<string> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new Error("OAUTH_CLIENT_NAME_INVALID");
  }
  if (input.redirectUris.length === 0) {
    throw new Error("OAUTH_CLIENT_REDIRECT_URI_REQUIRED");
  }
  if (input.scopes.length === 0 || !input.scopes.every(isMcpScope)) {
    throw new Error("OAUTH_CLIENT_SCOPE_INVALID");
  }
  const redirectUris = input.redirectUris.map(validRedirectUri);
  const auth = await createReadyAuthProvider({
    pgDatabase,
    config,
    persistence: createPostgresAuthPersistence(pgDatabase),
  });
  const { adapter } = await auth.$context;
  const clientId = crypto.randomUUID().replaceAll("-", "") +
    base64Url(crypto.getRandomValues(new Uint8Array(12)));
  const now = new Date();
  // Written through the provider's adapter, not its `create-client` endpoint:
  // that endpoint needs a signed-in session and a privilege Bakery denies to
  // every HTTP caller.
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId,
      name,
      redirectUris,
      scopes: [...input.scopes],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      applicationType: "native",
      requirePKCE: true,
      skipConsent: false,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  // The provider issues tokens only for resources a client is linked to.
  await adapter.create({
    model: "oauthClientResource",
    data: {
      clientId,
      resourceId: mcpResourceUrl(config.publicOrigin),
      createdAt: now,
    },
  });
  return clientId;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/** HTTPS, or plain HTTP only on a loopback host (native clients); no credentials or fragment. */
function validRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OAUTH_CLIENT_REDIRECT_URI_INVALID");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (
    url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) throw new Error("OAUTH_CLIENT_REDIRECT_URI_INVALID");
  return url.href;
}
