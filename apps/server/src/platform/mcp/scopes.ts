/**
 * OAuth scopes Bakery's MCP resource understands; the provider issues nothing
 * else. They are the same bundles access tokens carry, decided by the one
 * `scopeAllows` function.
 */
export const McpScope = Object.freeze(
  {
    Read: AccessScope.Read,
    Operate: AccessScope.Operate,
    Admin: AccessScope.Admin,
  } as const,
);
export type McpScope = (typeof McpScope)[keyof typeof McpScope];
export const MCP_SCOPES: readonly McpScope[] = Object.freeze([
  McpScope.Read,
  McpScope.Operate,
  McpScope.Admin,
]);

import type { CatalogPermissionKey } from "@bakery/contracts/contracts";
import {
  AccessScope,
  minimalScopes,
  scopeAllows,
  scopeImplies,
} from "../../modules/auth/application/scopes.ts";

/** Path of the protected MCP resource below the public origin. */
export const MCP_RESOURCE_PATH = "/mcp";

/** Canonical resource identifier (RFC 8707/9728): the audience of every MCP access token. */
export function mcpResourceUrl(publicOrigin: string): string {
  return `${new URL(publicOrigin).origin}${MCP_RESOURCE_PATH}`;
}

/** Issuer of Bakery's OAuth authorization server: the Better Auth base path below the public origin. */
export function oauthIssuerUrl(publicOrigin: string): string {
  return `${new URL(publicOrigin).origin}/api/auth`;
}

/** Tools the resource exposes and the one scope each needs. */
export const McpTool = Object.freeze(
  { Whoami: "whoami", OrganizationGet: "organization_get" } as const,
);
export type McpTool = (typeof McpTool)[keyof typeof McpTool];
export const MCP_TOOL_PERMISSION: Readonly<
  Record<McpTool, CatalogPermissionKey>
> = Object.freeze({
  [McpTool.Whoami]: "identity:read",
  [McpTool.OrganizationGet]: "organization:read",
});

/** Narrowest scope bundles that would let each tool run. */
export const MCP_TOOL_SCOPE: Readonly<Record<McpTool, McpScope[]>> = Object
  .freeze({
    [McpTool.Whoami]: minimalScopes(MCP_TOOL_PERMISSION[McpTool.Whoami]),
    [McpTool.OrganizationGet]: minimalScopes(
      MCP_TOOL_PERMISSION[McpTool.OrganizationGet],
    ),
  });

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

export type McpToolDecision =
  | { allowed: true }
  | { allowed: false; missingScopes: McpScope[] };

/**
 * The single scope decision for the MCP resource: a tool runs only when its
 * scope is in the token's scopes AND in the scopes of the consent that is live
 * right now. Scopes only restrict what the person may already do; they never
 * add authority. Kept as one pure function so it can fold into a single
 * `authorize()` later.
 */
export function decideMcpToolAccess(input: {
  tool: McpTool;
  tokenScopes: readonly string[];
  consentScopes: readonly string[];
}): McpToolDecision {
  const permission = MCP_TOOL_PERMISSION[input.tool];
  const allowed = scopeAllows(permission, input.tokenScopes) &&
    scopeAllows(permission, input.consentScopes);
  return allowed
    ? { allowed: true }
    : { allowed: false, missingScopes: MCP_TOOL_SCOPE[input.tool] };
}

/** Scopes both the token and the live consent hold, directly or through a broader bundle. */
export function effectiveMcpScopes(
  tokenScopes: readonly string[],
  consentScopes: readonly string[],
): McpScope[] {
  return MCP_SCOPES.filter((scope) =>
    scopeImplies(tokenScopes, scope) && scopeImplies(consentScopes, scope)
  );
}
