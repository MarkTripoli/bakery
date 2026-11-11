import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import { withPgTransaction } from "../../../platform/database.ts";
import { recordAuthAudit } from "../application/audit.ts";
import {
  holdsPasswordOrPasskey,
  isOrganizationId,
  readActor,
  readEnforcedMemberships,
  readOrganizationAccess,
} from "./access.ts";
import {
  SSO_AUDIT_OPERATIONS,
  SSO_ENFORCEMENT_RESOURCE_TYPE,
} from "./operations.ts";
import type { SsoModuleDependencies } from "./plugin.ts";

const ADMIN_ROLE = "admin";

const enforcementBody = z.object({
  organizationId: z.string().describe(
    "Identifier of the organization whose SSO enforcement is being set.",
  ),
  enforce: z.boolean().describe(
    "True to require SSO sign-in for the organization's members; false to lift enforcement.",
  ),
}).describe(
  "Request body that turns SSO enforcement on or off for one organization.",
);

const organizationQuery = z.object({
  organizationId: z.string().describe(
    "Identifier of the organization to read SSO settings for.",
  ),
}).describe(
  "Query string naming the organization whose SSO settings are read.",
);

function refuse(
  code: string,
  status:
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "BAD_REQUEST"
    | "UNAUTHORIZED"
    | "CONFLICT",
  message: string,
): never {
  throw new APIError(status, { code, message });
}

/** Session paths that are SSO sign-ins: they never face the enforcement check. */
function isSsoSignIn(path: string | undefined): boolean {
  return path?.startsWith("/sso/") === true;
}

/**
 * SSO enforcement and the Bakery-owned SSO settings endpoints. Enforcement
 * blocks password, passkey and social session creation for members of an
 * organization that enforces SSO, unless the person is an administrator of
 * every such organization and still holds a password or a passkey
 * (break-glass).
 */
export function createSsoEnforcementPlugin(
  dependencies: SsoModuleDependencies,
): BetterAuthPlugin {
  const { database, log } = dependencies;

  async function requireOrganizationAdmin(
    providerUserId: string,
    organizationIdInput: string,
  ) {
    const actor = await readActor(database, providerUserId);
    if (!actor) refuse("AUTH_FORBIDDEN", "FORBIDDEN", "Forbidden.");
    if (!isOrganizationId(organizationIdInput)) {
      refuse("RESOURCE_NOT_FOUND", "NOT_FOUND", "Organization not found.");
    }
    const access = await readOrganizationAccess(
      database,
      organizationIdInput,
      actor,
    );
    if (!access.organizationExists || access.role === null) {
      refuse("RESOURCE_NOT_FOUND", "NOT_FOUND", "Organization not found.");
    }
    return { actor, access, organizationId: organizationIdInput };
  }

  return {
    id: "bakery-sso-enforcement",
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              before: async (session, context) => {
                // The CLI bootstrap calls `auth.api.*` without a request.
                if (context != null && context.request === undefined) return;
                if (isSsoSignIn(context?.path)) return;
                try {
                  const enforced = await readEnforcedMemberships(
                    database,
                    session.userId,
                  );
                  if (enforced.length === 0) return;
                  const breakGlass = enforced.every((entry) =>
                    entry.role === ADMIN_ROLE
                  ) && await holdsPasswordOrPasskey(database, session.userId);
                  if (breakGlass) return;
                } catch {
                  log("AUTH_SSO_ENFORCEMENT_UNAVAILABLE");
                  throw new APIError("FORBIDDEN", {
                    code: "SSO_REQUIRED",
                    message: "Single sign-on is required.",
                  });
                }
                throw new APIError("FORBIDDEN", {
                  code: "SSO_REQUIRED",
                  message: "Your organization requires single sign-on.",
                });
              },
            },
          },
        },
      },
    }),
    endpoints: {
      listBakerySsoProviders: createAuthEndpoint(
        "/bakery-sso/providers",
        { method: "GET", use: [sessionMiddleware], query: organizationQuery },
        async (ctx) => {
          if (ctx.headers?.get("authorization")) {
            refuse(
              "SESSION_REQUIRED",
              "FORBIDDEN",
              "A browser session is required.",
            );
          }
          const { organizationId, access } = await requireOrganizationAdmin(
            ctx.context.session.user.id,
            ctx.query.organizationId,
          );
          if (access.role !== ADMIN_ROLE) {
            refuse(
              "AUTH_FORBIDDEN",
              "FORBIDDEN",
              "Organization administrator required.",
            );
          }
          const rows = await database.query<{
            providerId: string;
            issuer: string;
            domain: string;
            domainVerified: boolean | null;
            oidc: boolean;
          }>(
            `select "providerId", issuer, domain, "domainVerified",
                    "oidcConfig" is not null as oidc
             from public."ssoProvider" where "organizationId" = $1
             order by "providerId"`,
            [organizationId],
          );
          const settings = await database.query<{ enforce: boolean }>(
            "select enforce from bakery.organization_sso_settings where organization_id = $1",
            [organizationId],
          );
          return ctx.json({
            enforce: settings.rows[0]?.enforce === true,
            providers: rows.rows.map((row) => ({
              providerId: row.providerId,
              issuer: row.issuer,
              domain: row.domain,
              domainVerified: row.domainVerified === true,
              protocol: row.oidc ? "oidc" : "saml",
            })),
          });
        },
      ),
      getBakerySsoEnforcement: createAuthEndpoint(
        "/bakery-sso/enforcement",
        { method: "GET", use: [sessionMiddleware], query: organizationQuery },
        async (ctx) => {
          if (ctx.headers?.get("authorization")) {
            refuse(
              "SESSION_REQUIRED",
              "FORBIDDEN",
              "A browser session is required.",
            );
          }
          const { organizationId, access } = await requireOrganizationAdmin(
            ctx.context.session.user.id,
            ctx.query.organizationId,
          );
          if (access.role !== ADMIN_ROLE) {
            refuse(
              "AUTH_FORBIDDEN",
              "FORBIDDEN",
              "Organization administrator required.",
            );
          }
          const row = await database.query<{ enforce: boolean }>(
            "select enforce from bakery.organization_sso_settings where organization_id = $1",
            [organizationId],
          );
          return ctx.json({ enforce: row.rows[0]?.enforce === true });
        },
      ),
      updateBakerySsoEnforcement: createAuthEndpoint(
        "/bakery-sso/enforcement",
        { method: "POST", use: [sessionMiddleware], body: enforcementBody },
        async (ctx) => {
          if (ctx.headers?.get("authorization")) {
            refuse(
              "SESSION_REQUIRED",
              "FORBIDDEN",
              "A browser session is required.",
            );
          }
          // tenant lookup
          const { actor, access, organizationId } =
            await requireOrganizationAdmin(
              ctx.context.session.user.id,
              ctx.body.organizationId,
            );
          // permission
          if (access.role !== ADMIN_ROLE) {
            refuse(
              "AUTH_FORBIDDEN",
              "FORBIDDEN",
              "Organization administrator required.",
            );
          }
          const requestId = ctx.headers?.get("x-request-id") ||
            crypto.randomUUID();
          await withPgTransaction(database, async (transaction) => {
            if (ctx.body.enforce) {
              // Enforcing without a verified provider would lock everyone but
              // the break-glass administrators out.
              const verified = await transaction.query(
                `select 1 from public."ssoProvider"
                 where "organizationId" = $1 and "domainVerified" is true limit 1`,
                [organizationId],
              );
              if (verified.rowCount === 0) {
                refuse(
                  "SSO_PROVIDER_REQUIRED",
                  "CONFLICT",
                  "Register and verify an SSO provider before enforcing SSO.",
                );
              }
            }
            await transaction.query(
              `insert into bakery.organization_sso_settings
                 (organization_id, enforce, updated_by_principal_id, updated_at)
               values ($1, $2, $3, $4)
               on conflict (organization_id) do update
                 set enforce = excluded.enforce,
                     updated_by_principal_id = excluded.updated_by_principal_id,
                     updated_at = excluded.updated_at`,
              [
                organizationId,
                ctx.body.enforce,
                actor.principalId,
                dependencies.now(),
              ],
            );
            await recordAuthAudit(
              transaction,
              { requestId, traceId: requestId },
              {
                organizationId,
                principalId: actor.principalId,
                operation: SSO_AUDIT_OPERATIONS.enforcementUpdate,
                resourceType: SSO_ENFORCEMENT_RESOURCE_TYPE,
                resourceId: organizationId,
                details: { enforce: ctx.body.enforce },
              },
            );
          });
          return ctx.json({ enforce: ctx.body.enforce });
        },
      ),
    },
  };
}
