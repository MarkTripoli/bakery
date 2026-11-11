import { effectiveMcpScopes, MCP_SCOPES, type McpScope } from "./scopes.ts";
import { protectedResourceMetadataUrl } from "./metadata.ts";

/** Claims of a verified access token; values are untrusted until narrowed. */
export type McpTokenClaims = Readonly<Record<string, unknown>>;

/** Live Bakery state the guard consults after the token itself checks out. */
export type McpGrantStore = {
  /** The consent that exists right now for the person, client and organization. */
  findLiveConsent(
    input: McpGrantKey,
  ): Promise<{ scopes: string[] } | undefined>;
  /** Whole epoch seconds of the latest revoke of this grant, if any. */
  revocationEpochSeconds(input: McpGrantKey): Promise<number | undefined>;
  /** The enabled human principal of a provider user, or none. */
  findActivePrincipal(
    providerUserId: string,
  ): Promise<{ principalId: string } | undefined>;
  /** Whether the principal holds a live membership of the organization. */
  hasLiveMembership(
    input: { principalId: string; organizationId: string },
  ): Promise<boolean>;
  /** Records use of the grant; implementations throttle the write. */
  touchActivity(input: McpGrantKey): Promise<void>;
};

export type McpGrantKey = {
  providerUserId: string;
  clientId: string;
  organizationId: string;
};

/** What dispatch may rely on once the guard passes. */
export type McpGrant = McpGrantKey & {
  principalId: string;
  /** Scopes the access token carries. */
  tokenScopes: string[];
  /** Scopes of the consent that is live right now. */
  consentScopes: string[];
  /** Scopes in both, restricted to Bakery's; the input to every tool decision. */
  scopes: McpScope[];
};

export type McpGuardOptions = {
  publicOrigin: string;
  /** Verifies signature, issuer, audience and expiry; rejects otherwise. */
  verifyToken(token: string): Promise<McpTokenClaims>;
  store: McpGrantStore;
};

const BEARER = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * RFC 6750/9728 challenge response. `invalid_token` and `insufficient_scope`
 * are the only errors this resource reports; a request with no credential at
 * all gets the bare challenge naming the protected-resource metadata.
 */
export function challengeResponse(
  publicOrigin: string,
  failure:
    | { status: 401; error?: "invalid_token"; description?: string }
    | { status: 403; error: "insufficient_scope"; scope: readonly McpScope[] },
): Response {
  const parameters = [
    `resource_metadata="${protectedResourceMetadataUrl(publicOrigin)}"`,
  ];
  if (failure.error) parameters.push(`error="${failure.error}"`);
  if (failure.status === 403) {
    parameters.push(`scope="${failure.scope.join(" ")}"`);
  } else if (failure.description) {
    parameters.push(`error_description="${failure.description}"`);
  }
  const description = failure.status === 403
    ? "The grant does not include the scope this tool needs."
    : failure.description ?? "A valid access token is required.";
  return new Response(
    JSON.stringify({
      error: failure.error ??
        (failure.status === 401 ? "unauthorized" : "forbidden"),
      error_description: description,
    }),
    {
      status: failure.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": `Bearer ${parameters.join(", ")}`,
      },
    },
  );
}

function scopeList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(" ").filter((scope) => scope.length > 0)
    : [];
}

/**
 * Admits a request to the MCP resource or returns the challenge to send back.
 * The order is fixed and every step fails closed:
 *
 * 1. Bearer credential only — a browser cookie is never read.
 * 2. Signature, issuer, audience and expiry.
 * 3. Required `azp` client claim, subject and organization claims; no
 *    sender-constrained (`cnf`) tokens, which this resource cannot honor.
 * 4. The consent for this person, client and organization exists now.
 * 5. The token was issued after the grant's latest revocation.
 * 6. Effective scopes (token scopes ∩ live consent scopes) are not empty.
 * 7. The principal is enabled and the membership is live.
 *
 * Dispatch happens only after this returns a grant.
 */
export async function guardMcpRequest(
  request: Request,
  options: McpGuardOptions,
): Promise<McpGrant | Response> {
  const { publicOrigin, store } = options;
  const header = request.headers.get("authorization");
  if (header === null) return challengeResponse(publicOrigin, { status: 401 });
  const bearer = BEARER.exec(header);
  if (!bearer) {
    return challengeResponse(publicOrigin, {
      status: 401,
      error: "invalid_token",
      description: "Send the access token as a Bearer credential.",
    });
  }
  const invalid = (description = "The access token is not valid.") =>
    challengeResponse(publicOrigin, {
      status: 401,
      error: "invalid_token",
      description,
    });

  let claims: McpTokenClaims;
  try {
    claims = await options.verifyToken(bearer[1]);
  } catch {
    return invalid();
  }

  const { azp, sub, iat, cnf } = claims;
  const organizationId = claims.organization_id;
  if (
    typeof azp !== "string" || azp.length === 0 ||
    typeof sub !== "string" || !UUID.test(sub) ||
    typeof organizationId !== "string" || !UUID.test(organizationId) ||
    typeof iat !== "number" || !Number.isFinite(iat) ||
    cnf !== undefined
  ) return invalid();

  const key: McpGrantKey = {
    providerUserId: sub,
    clientId: azp,
    organizationId,
  };

  const consent = await store.findLiveConsent(key);
  if (!consent) return invalid("The client is no longer connected.");

  const revokedAt = await store.revocationEpochSeconds(key);
  if (revokedAt !== undefined && Math.floor(iat) <= revokedAt) {
    return invalid("The client was disconnected after this token was issued.");
  }

  const tokenScopes = scopeList(claims.scope);
  const scopes = effectiveMcpScopes(tokenScopes, consent.scopes);
  if (scopes.length === 0) {
    return challengeResponse(publicOrigin, {
      status: 403,
      error: "insufficient_scope",
      scope: [MCP_SCOPES[0]],
    });
  }

  const principal = await store.findActivePrincipal(sub);
  if (
    !principal ||
    !await store.hasLiveMembership({
      principalId: principal.principalId,
      organizationId,
    })
  ) return invalid("The person no longer has access.");

  await store.touchActivity(key);
  return {
    ...key,
    principalId: principal.principalId,
    tokenScopes,
    consentScopes: consent.scopes,
    scopes,
  };
}
