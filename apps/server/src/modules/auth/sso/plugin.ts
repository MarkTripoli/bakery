import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { sso } from "@better-auth/sso";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../platform/database.ts";
import { recordAuthAudit } from "../application/audit.ts";
import {
  isOrganizationId,
  type ProviderSnapshot,
  readActor,
  readOrganizationAccess,
  readProvider,
  restoreProvider,
  snapshotProvider,
  type SsoActor,
} from "./access.ts";
import {
  SSO_AUDIT_RESOURCE_TYPE,
  SSO_PROVIDER_MUTATION_PATHS,
  type SsoProviderMutationPath,
} from "./operations.ts";

export type SsoModuleDependencies = Readonly<{
  database: PgDatabase;
  now: () => Date;
  log: (code: string) => void;
}>;

const ADMIN_ROLE = "admin";
/** Registered providers one administrator may create; Bakery authorizes per organization. */
const PROVIDERS_PER_USER = 100;

const MANAGEMENT_PATHS = new Set<string>([
  ...Object.keys(SSO_PROVIDER_MUTATION_PATHS),
  "/sso/request-domain-verification",
]);
/** Provider endpoints replaced by `/bakery-sso/*`: they list across the whole table. */
const CLOSED_PATHS = new Set<string>(["/sso/providers", "/sso/get-provider"]);

type Pending = {
  actor: SsoActor;
  organizationId: string;
  providerId: string;
  path: SsoProviderMutationPath;
  fields: string[];
  snapshot?: ProviderSnapshot;
};

const PENDING_KEY = "bakerySsoPending";

function refuse(
  code: string,
  status: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "UNAUTHORIZED",
  message: string,
): never {
  throw new APIError(status, { code, message });
}

/** Parsed JSON body of an endpoint result, whether it is a `Response` or a plain object. */
async function readReturnedJson(
  returned: unknown,
): Promise<Record<string, unknown> | null> {
  if (returned instanceof Response) {
    try {
      return await returned.clone().json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return returned && typeof returned === "object"
    ? { ...(returned as Record<string, unknown>) }
    : null;
}

const SECRET_KEYS = new Set([
  "clientSecret",
  "privateKey",
  "privateKeyPass",
  "encPrivateKey",
  "encPrivateKeyPass",
]);

/** Copy of a provider payload with every credential field removed, at any depth. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEYS.has(key))
        .map(([key, entry]) => [key, redactSecrets(entry)]),
    );
  }
  return value;
}

/** Better Auth plugins for SSO (OIDC and SAML provider management and sign-in). */
export function createSsoAuthPlugins(
  dependencies: SsoModuleDependencies,
): BetterAuthPlugin[] {
  const { database, log } = dependencies;

  const ssoPlugin = sso({
    domainVerification: { enabled: true, tokenPrefix: "bakery-verify" },
    providersLimit: PROVIDERS_PER_USER,
    trustEmailVerified: false,
    organizationProvisioning: { disabled: true },
    resolveUser: async (input, context) => {
      const linked = await context.database.findOne({
        model: "account",
        where: [
          { field: "providerId", value: input.providerId },
          { field: "accountId", value: input.accountKey.accountId },
        ],
      });
      if (linked) return { action: "continue" };
      const provider = await readProvider(database, input.providerId);
      const organizationId = provider?.organizationId;
      if (!provider || !organizationId) {
        return {
          action: "reject",
          code: "RESOURCE_NOT_FOUND",
          message: "SSO is not available for this organization.",
        };
      }
      // First sign-in of an existing person: link only when the organization
      // proved control of the email's domain (the provider's `email_verified`
      // claim is not trusted; the verified domain is the trust anchor).
      const email = input.providerUser.email.toLowerCase();
      const emailDomain = email.slice(email.lastIndexOf("@") + 1);
      const provenDomain = provider.domainVerified &&
        (emailDomain === provider.domain.toLowerCase() ||
          emailDomain.endsWith(`.${provider.domain.toLowerCase()}`));
      if (!provenDomain) {
        return {
          action: "reject",
          code: "SSO_DOMAIN_NOT_VERIFIED",
          message: "The email domain is not verified for this provider.",
        };
      }
      const existing = await context.database.findOne<{ id: string }>({
        model: "user",
        where: [{ field: "email", value: email }],
      });
      return existing
        ? { action: "link", userId: existing.id, profile: "preserve" }
        : { action: "continue" };
    },
    guardProviderMutation: async (input) => {
      if (input.action === "delete") return;
      const provider = await readProvider(database, input.provider.providerId);
      if (!provider?.organizationId) throw new Error("RESOURCE_NOT_FOUND");
    },
  });

  const guard: BetterAuthPlugin = {
    id: "bakery-sso-guard",
    hooks: {
      before: [{
        matcher: (context) =>
          MANAGEMENT_PATHS.has(context.path ?? "") ||
          CLOSED_PATHS.has(context.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          if (CLOSED_PATHS.has(ctx.path)) {
            refuse("RESOURCE_NOT_FOUND", "NOT_FOUND", "Not found.");
          }
          // Access management needs a browser session cookie; a bearer token
          // never authenticates here.
          if (ctx.headers?.get("authorization")) {
            refuse(
              "SESSION_REQUIRED",
              "FORBIDDEN",
              "A browser session is required.",
            );
          }
          const session = await getSessionFromCtx(ctx);
          if (!session?.user) {
            refuse("AUTH_REQUIRED", "UNAUTHORIZED", "Sign in required.");
          }
          const actor = await readActor(database, session.user.id);
          if (!actor) refuse("AUTH_FORBIDDEN", "FORBIDDEN", "Forbidden.");

          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const query = (ctx.query ?? {}) as Record<string, unknown>;
          const path = ctx.path as SsoProviderMutationPath;
          const isRegister = ctx.path === "/sso/register";

          let organizationId: string | null;
          let providerId: string;
          if (isRegister) {
            providerId = String(body.providerId ?? "");
            organizationId = isOrganizationId(body.organizationId)
              ? body.organizationId
              : null;
            if (!organizationId) {
              refuse(
                "RESOURCE_NOT_FOUND",
                "NOT_FOUND",
                "Organization not found.",
              );
            }
          } else {
            providerId = String(body.providerId ?? query.providerId ?? "");
            const provider = providerId
              ? await readProvider(database, providerId)
              : null;
            if (!provider?.organizationId) {
              refuse("RESOURCE_NOT_FOUND", "NOT_FOUND", "Provider not found.");
            }
            organizationId = provider.organizationId;
          }

          // 1. tenant lookup
          const access = await readOrganizationAccess(
            database,
            organizationId,
            actor,
          );
          if (!access.organizationExists || access.role === null) {
            refuse(
              "RESOURCE_NOT_FOUND",
              "NOT_FOUND",
              "Organization not found.",
            );
          }
          // 2. permission
          if (access.role !== ADMIN_ROLE) {
            refuse(
              "AUTH_FORBIDDEN",
              "FORBIDDEN",
              "Organization administrator required.",
            );
          }

          // Unsigned SAML assertions would let anyone who can reach the ACS
          // assert a verified-domain email and take over its local account, so
          // signatures are not an admin option.
          if (
            (isRegister || ctx.path === "/sso/update-provider") &&
            body.samlConfig && typeof body.samlConfig === "object"
          ) {
            const saml = body.samlConfig as Record<string, unknown>;
            if (saml.wantAssertionsSigned === false) {
              refuse(
                "SAML_ASSERTIONS_MUST_BE_SIGNED",
                "BAD_REQUEST",
                "SAML assertions must be signed.",
              );
            }
            saml.wantAssertionsSigned = true;
          }

          if (isRegister) {
            // Better Auth would check its own `member` table, which Bakery does
            // not keep; the organization is attached atomically with the audit
            // row in the after hook below.
            delete (ctx.body as Record<string, unknown>).organizationId;
            (ctx.context as Record<string, unknown>)[PENDING_KEY] = {
              actor,
              organizationId,
              providerId,
              path,
              fields: [],
            } satisfies Pending;
            return;
          }
          const snapshot = await snapshotProvider(database, providerId);
          // Better Auth authorizes an existing provider by its owner; Bakery
          // has just authorized the caller as the organization's admin, so the
          // acting admin takes the ownership pointer.
          await database.query(
            `update public."ssoProvider" set "userId" = $2 where "providerId" = $1 and "userId" is distinct from $2`,
            [providerId, actor.providerUserId],
          );
          if (path in SSO_PROVIDER_MUTATION_PATHS) {
            (ctx.context as Record<string, unknown>)[PENDING_KEY] = {
              actor,
              organizationId,
              providerId,
              path,
              fields: path === "/sso/update-provider"
                ? Object.keys(body).filter((key) => key !== "providerId").sort()
                : [],
              snapshot,
            } satisfies Pending;
          }
        }),
      }],
      after: [{
        matcher: (context) =>
          Object.hasOwn(SSO_PROVIDER_MUTATION_PATHS, context.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const pending =
            (ctx.context as Record<string, unknown>)[PENDING_KEY] as
              | Pending
              | undefined;
          if (!pending) return;
          const returned = ctx.context.returned;
          if (returned instanceof Error || returned instanceof APIError) {
            // A refused mutation must not leave the ownership pointer moved.
            const owner = pending.snapshot?.provider?.userId;
            if (typeof owner === "string") {
              await database.query(
                `update public."ssoProvider" set "userId" = $2 where "providerId" = $1`,
                [pending.providerId, owner],
              ).catch(() => undefined);
            }
            return;
          }
          const requestId = ctx.headers?.get("x-request-id") ||
            crypto.randomUUID();
          const operation = SSO_PROVIDER_MUTATION_PATHS[pending.path];
          try {
            await withPgTransaction(database, async (transaction) => {
              if (pending.path === "/sso/register") {
                const attached = await transaction.query(
                  `update public."ssoProvider" set "organizationId" = $2
                   where "providerId" = $1 and "organizationId" is null`,
                  [pending.providerId, pending.organizationId],
                );
                if (attached.rowCount !== 1) {
                  throw new Error("SSO_ATTACH_FAILED");
                }
              }
              await recordAuthAudit(
                transaction,
                { requestId, traceId: requestId },
                {
                  organizationId: pending.organizationId,
                  principalId: pending.actor.principalId,
                  operation,
                  resourceType: SSO_AUDIT_RESOURCE_TYPE,
                  resourceId: pending.providerId,
                  details: pending.path === "/sso/update-provider"
                    ? { changedFields: pending.fields }
                    : {},
                },
              );
            });
          } catch {
            log("AUTH_AUDIT_WRITE_FAILED");
            if (pending.snapshot) {
              // No SSO change may stand without its audit row: put it back.
              await withPgTransaction(
                database,
                (transaction) =>
                  restoreProvider(
                    transaction,
                    pending.providerId,
                    pending.snapshot!,
                  ),
              ).catch(() => log("AUTH_SSO_RESTORE_FAILED"));
              throw new APIError("INTERNAL_SERVER_ERROR", {
                code: "AUDIT_UNAVAILABLE",
                message:
                  "The change was rolled back because it could not be audited.",
              });
            }
            if (pending.path === "/sso/register") {
              // Never leave a provider no organization owns: compensate.
              await database.query(
                `delete from public."ssoProvider" where "providerId" = $1 and "organizationId" is null`,
                [pending.providerId],
              ).catch(() => undefined);
              refuse(
                "INTERNAL",
                "BAD_REQUEST",
                "SSO provider could not be registered.",
              );
            }
          }
          if (pending.path === "/sso/register") {
            // The provider echoes the stored configuration, client secret
            // included, and has no organization yet; neither belongs in the
            // response.
            const payload = await readReturnedJson(returned);
            if (payload) {
              return ctx.json({
                ...(redactSecrets(payload) as Record<string, unknown>),
                organizationId: pending.organizationId,
              });
            }
          }
        }),
      }],
    },
  };

  return [ssoPlugin, guard];
}
