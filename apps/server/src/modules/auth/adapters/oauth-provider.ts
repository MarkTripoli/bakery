import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { z } from "zod";
import type { ServerAuthConfig } from "@bakery/config";
import type { PgDatabase } from "../../../platform/database.ts";
import { MCP_SCOPES, mcpResourceUrl } from "../../../platform/mcp/scopes.ts";

/** SPA route that renders the consent (and, for people in several organizations, organization choice) step. */
export const OAUTH_CONSENT_PAGE = "/oauth/consent";
/** SPA route the provider sends signed-out people to before authorization continues. */
export const OAUTH_LOGIN_PAGE = "/sign-in";
/** Access-token claim that carries the one organization the grant is bound to. */
export const OAUTH_ORGANIZATION_CLAIM = "organization_id";
/** Plugin endpoint (below `/api/auth`) where a person picks the organization a consent binds. */
export const OAUTH_SELECT_ORGANIZATION_PATH =
  "/bakery/oauth/select-organization";

/** Short-lived access tokens; refresh tokens renew them and the guard re-checks consent on every call. */
const ACCESS_TOKEN_TTL_SECONDS = 600;
/** How long an organization choice stays usable for the authorization flow it was made in. */
const ORGANIZATION_SELECTION_TTL_MS = 10 * 60_000;
const SELECTION_PREFIX = "bakery-oauth-org-";

/** Organizations a person currently belongs to through a live membership, oldest first. */
export async function liveOrganizationIds(
  database: Pick<PgDatabase, "query">,
  providerUserId: string,
): Promise<string[]> {
  const result = await database.query<{ organizationId: string }>(
    `select membership.organization_id as "organizationId"
      from bakery.organization_memberships as membership
      join bakery.principals as principal
        on principal.id = membership.principal_id
      where principal.provider_user_id = $1
        and principal.principal_type = 'human'
        and principal.disabled_at is null
        and membership.status = 'active'
      order by membership.joined_at, membership.organization_id`,
    [providerUserId],
  );
  return result.rows.map(({ organizationId }) => organizationId);
}

async function selectedOrganizationId(
  database: Pick<PgDatabase, "query">,
  sessionId: string,
  live: readonly string[],
): Promise<string | undefined> {
  const result = await database.query<{ value: string }>(
    `select value from public.verification
      where identifier = $1 and "expiresAt" > now()
      order by "createdAt" desc
      limit 1`,
    [`${SELECTION_PREFIX}${sessionId}`],
  );
  const value = result.rows[0]?.value;
  return value !== undefined && live.includes(value) ? value : undefined;
}

function noOrganization(): APIError {
  return new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description: "No organization is available to connect",
  });
}

/**
 * Bakery's endpoint for choosing which one organization the next consent
 * binds. The choice lives in a short-lived `verification` row keyed by the
 * session, because the provider's reference-id callback sees only the user
 * and session. Pending-factor sessions are refused before this runs by
 * `bakerySessionAssurance`'s before-hook.
 */
function bakeryOAuthOrganization(
  database: Pick<PgDatabase, "query">,
): BetterAuthPlugin {
  return {
    id: "bakery-oauth-organization",
    endpoints: {
      bakerySelectOAuthOrganization: createAuthEndpoint(
        OAUTH_SELECT_ORGANIZATION_PATH,
        {
          method: "POST",
          body: z.object({
            organizationId: z.string().uuid().describe(
              "Organization the connected client may act in; the person must hold a live membership in it.",
            ),
          }).describe(
            "Choice of the single organization an OAuth consent binds.",
          ),
        },
        async (ctx) => {
          const current = await getSessionFromCtx(ctx, {
            disableRefresh: true,
          });
          if (!current) {
            throw new APIError("UNAUTHORIZED", {
              code: "UNAUTHORIZED",
              message: "Sign in to continue",
            });
          }
          const live = await liveOrganizationIds(database, current.user.id);
          const organizationId = ctx.body.organizationId.toLowerCase();
          if (!live.includes(organizationId)) throw noOrganization();
          const identifier = `${SELECTION_PREFIX}${current.session.id}`;
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [{ field: "identifier", value: identifier }],
          });
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: organizationId,
            expiresAt: new Date(Date.now() + ORGANIZATION_SELECTION_TTL_MS),
          });
          return ctx.json({ organizationId });
        },
      ),
    },
  };
}

/**
 * `jwt()` signs resource-bound access tokens; `mcp()` is the one OAuth
 * provider. Clients are created only by the `register-oauth-client` server
 * task, so every HTTP-reachable create/update/delete privilege is denied
 * (the admin create endpoint is `SERVER_ONLY` upstream and never mounted).
 * Dynamic registration stays off, and the session-to-JWT header the `jwt()`
 * plugin would otherwise add to `/get-session` is disabled.
 */
export function createOAuthProviderPlugins(deps: {
  config: Pick<ServerAuthConfig, "publicOrigin">;
  database: Pick<PgDatabase, "query">;
}) {
  const { database } = deps;
  return [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource: mcpResourceUrl(deps.config.publicOrigin),
      loginPage: OAUTH_LOGIN_PAGE,
      consentPage: OAUTH_CONSENT_PAGE,
      scopes: [...MCP_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
      customAccessTokenClaims: ({ referenceId }) =>
        referenceId ? { [OAUTH_ORGANIZATION_CLAIM]: referenceId } : {},
      postLogin: {
        page: OAUTH_CONSENT_PAGE,
        shouldRedirect: async ({ user, session }) => {
          const live = await liveOrganizationIds(database, user.id);
          if (live.length === 0) throw noOrganization();
          if (live.length === 1) return false;
          return await selectedOrganizationId(database, session.id, live) ===
            undefined;
        },
        consentReferenceId: async ({ user, session }) => {
          const live = await liveOrganizationIds(database, user.id);
          if (live.length === 1) return live[0];
          const selected = await selectedOrganizationId(
            database,
            session.id,
            live,
          );
          if (selected === undefined) throw noOrganization();
          return selected;
        },
      },
    }),
    bakeryOAuthOrganization(database),
  ] as const;
}
