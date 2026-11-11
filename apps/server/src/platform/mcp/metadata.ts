import { Hono } from "hono";
import {
  MCP_RESOURCE_PATH,
  MCP_SCOPES,
  mcpResourceUrl,
  oauthIssuerUrl,
} from "./scopes.ts";

/** RFC 9728 location of the protected-resource metadata for `/mcp`. */
export const PROTECTED_RESOURCE_METADATA_PATH =
  `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
/** RFC 8414 location of the authorization-server metadata for the `/api/auth` issuer. */
export const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server/api/auth";

export function protectedResourceMetadataUrl(publicOrigin: string): string {
  return `${new URL(publicOrigin).origin}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

/** RFC 9728 document: the resource identifier, its one issuer and the header-only bearer method. */
export function protectedResourceMetadata(publicOrigin: string) {
  return {
    resource: mcpResourceUrl(publicOrigin),
    authorization_servers: [oauthIssuerUrl(publicOrigin)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SCOPES],
    resource_name: "Bakery",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Discovery documents. The protected-resource metadata is static; the
 * authorization-server metadata is the provider's own document, served at the
 * RFC 8414 path for an issuer with a path component.
 */
export function createMcpMetadataRoutes(options: {
  publicOrigin: string;
  /** The Better Auth handler, used to read the provider's metadata document. */
  providerHandler(request: Request): Promise<Response>;
}) {
  const app = new Hono();
  const origin = new URL(options.publicOrigin).origin;
  app.get(
    PROTECTED_RESOURCE_METADATA_PATH,
    () => jsonResponse(protectedResourceMetadata(origin)),
  );
  app.get(AUTHORIZATION_SERVER_METADATA_PATH, async () => {
    const response = await options.providerHandler(
      new Request(`${origin}/api/auth/.well-known/oauth-authorization-server`),
    );
    if (!response.ok) return jsonResponse({ error: "unavailable" }, 503);
    return jsonResponse(await response.json());
  });
  return app;
}
