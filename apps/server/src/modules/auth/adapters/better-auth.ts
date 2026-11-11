import { betterAuth, type BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { ServerAuthConfig } from "@bakery/config";
import { createTranslator } from "@bakery/i18n";
import type { PgDatabase } from "../../../platform/database.ts";
import { requestLocale } from "../../../platform/locale.ts";
import { RegistrationMode } from "@bakery/contracts/installation-settings";
import type { InstallationSettingsReader } from "../application/installation-settings.ts";
import { createPostgresInstallationSettingsReader } from "./installation-settings-postgres.ts";
import {
  decideRegistration,
  RegistrationAction,
  RegistrationErrorCode,
} from "../domain/registration.ts";
import {
  type AuthPersistence,
  createPostgresAuthPersistence,
} from "./postgres.ts";
import { AuthErrorCode } from "../domain/errors.ts";
import { bakerySessionAssurance, TOTP_ISSUER } from "./session-assurance.ts";
import {
  authenticatingPasskeyId,
  createPasskeyPlugin,
} from "./passkey-policy.ts";
import {
  credentialAuditPlugin,
  PASSWORD_CHANGE_OPERATION,
  recordCredentialAudit,
} from "./credential-audit.ts";
import { createOAuthProviderPlugins } from "./oauth-provider.ts";
import { createSsoModules } from "../sso/mod.ts";
import { createScimAuthPlugins } from "../scim/mod.ts";

/**
 * Header Bakery injects into the `/api/auth/*` passthrough request, carrying
 * the connection's remote address so the provider's per-IP rate limiter has
 * a value to key on. Any client-supplied copy is stripped before injection
 * (see `transport/http/routes.ts`).
 *
 * Behind a reverse proxy, `info.remoteAddr` (`main.ts`) is the proxy's own
 * address, so every real client would collapse onto one rate-limit bucket.
 * Set `BAKERY_TRUSTED_PROXY_CIDRS` to the proxy's addresses and `mainRouter`
 * replaces the peer with the client resolved from `X-Forwarded-For`
 * (`platform/client-address.ts`), but only when the immediate peer is in that
 * list. Unset, the peer address is used unchanged; terminating TLS in-process
 * is the other supported shape. The header carries a single address; the
 * provider's `ipAddressHeaders` never sees a client-supplied chain.
 */
export const REMOTE_ADDRESS_HEADER = "x-bakery-remote-addr";

/**
 * Requests under this path carry an authenticated SCIM bearer credential and
 * are an administrator-provisioned path, not self-service sign-up, so the
 * sign-up policy does not apply to the users they create.
 */
const SCIM_PROVISIONING_PATH_PREFIX = "/scim/v2/";

export type AuthProviderDependencies = {
  pgDatabase: PgDatabase;
  config: ServerAuthConfig;
  installationSettings?: InstallationSettingsReader;
  persistence?: AuthPersistence;
  now?: () => Date;
  log?: (code: string) => void;
};

export function buildBetterAuthOptions({
  pgDatabase,
  config,
  installationSettings = createPostgresInstallationSettingsReader(pgDatabase),
  persistence = createPostgresAuthPersistence(pgDatabase),
  now = () => new Date(),
  log = (code) => console.error(`better-auth: ${code}`),
}: AuthProviderDependencies) {
  const requestPolicies = new WeakMap<Request, Promise<boolean>>();
  const signupsEnabled = (request?: Request): Promise<boolean> => {
    const cached = request && requestPolicies.get(request);
    if (cached) return cached;
    const policy = installationSettings.current().then((settings) =>
      settings.registrationMode === RegistrationMode.Invitation
    );
    if (request) requestPolicies.set(request, policy);
    return policy;
  };
  return {
    database: pgDatabase,
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: { enabled: true, autoSignIn: false },
    session: { cookieCache: { enabled: false } },
    plugins: [
      bakerySessionAssurance({ now }),
      credentialAuditPlugin({ database: pgDatabase, log }),
      twoFactor({
        issuer: TOTP_ISSUER,
        skipVerificationOnEnable: false,
        allowPasswordless: true,
        twoFactorCookieMaxAge: 600,
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: {
          amount: 10,
          length: 10,
          storeBackupCodes: "encrypted",
        },
      }),
      createPasskeyPlugin(config),
      ...createOAuthProviderPlugins({ config, database: pgDatabase }),
      ...createSsoModules({ database: pgDatabase, now, log }),
      ...createScimAuthPlugins({ database: pgDatabase, clock: now }),
    ],
    rateLimit: { enabled: true, storage: "database", window: 10, max: 100 },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: [REMOTE_ADDRESS_HEADER] },
    },
    logger: {
      level: "warn",
      log: (level) => log(`AUTH_PROVIDER_${level.toUpperCase()}`),
    },
    onAPIError: {
      onError: () => log(AuthErrorCode.ProviderError),
    },
    ...(config.github
      ? {
        socialProviders: {
          github: {
            clientId: config.github.clientId,
            clientSecret: config.github.clientSecret,
          },
        },
      }
      : {}),
    user: {
      // Optional personal-profile fields; the provider owns the columns
      // (provider migration 0006) and only Bakery's profile operations write
      // them. `input: false` keeps `/api/auth/update-user` and sign-up from
      // bypassing the profile bounds and the `profile_version` bump.
      additionalFields: {
        firstName: {
          type: "string",
          required: false,
          input: false,
          fieldName: "first_name",
        },
        lastName: {
          type: "string",
          required: false,
          input: false,
          fieldName: "last_name",
        },
        title: {
          type: "string",
          required: false,
          input: false,
          fieldName: "title",
        },
        profileVersion: {
          type: "number",
          required: false,
          input: false,
          defaultValue: 1,
          fieldName: "profile_version",
        },
      },
      validateUserInfo: async ({ user, source }, context) => {
        if (context.path?.startsWith(SCIM_PROVISIONING_PATH_PREFIX)) return;
        const locale = requestLocale(context.request, undefined);
        const translate = createTranslator({ locale, surface: "auth" });
        try {
          const decision = await decideRegistration({
            action: source.action,
            email: typeof user.email === "string" ? user.email : undefined,
            providerUserId: typeof user.id === "string" ? user.id : undefined,
            hasRequest: context.request !== undefined,
            now: now(),
            signupsEnabled:
              source.action === RegistrationAction.CreateUser && context.request
                ? await signupsEnabled(context.request)
                : true,
          }, persistence);
          if (!decision) return decision;
          if (decision.error === RegistrationErrorCode.SignupsDisabled) {
            log(AuthErrorCode.SignupsDisabled);
          }
          return {
            error: decision.error,
            errorDescription: translate(
              decision.error === RegistrationErrorCode.SignupsDisabled
                ? "auth.registration.paused"
                : "auth.registration.identityNotAllowed",
            ),
          };
        } catch {
          return {
            error: RegistrationErrorCode.IdentityNotAllowed,
            errorDescription: translate(
              "auth.registration.identityNotAllowed",
            ),
          };
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (_user, context): Promise<boolean | void> => {
            // Only a present endpoint context with no request marks the CLI
            // bootstrap, which calls `auth.api.*` directly. A missing context
            // is not a CLI claim, so it still has to clear the live policy: this hook
            // exists to backstop paths that bypass `validateUserInfo`, and
            // `createWithHooks` resolves the context from async local storage,
            // which can be absent. Same shape as `session.create.before`.
            if (context != null && context.request === undefined) {
              return;
            }
            if (context?.path?.startsWith(SCIM_PROVISIONING_PATH_PREFIX)) {
              return;
            }
            try {
              if (await signupsEnabled(context?.request)) return;
            } catch {
              log(AuthErrorCode.IdentityUnavailable);
              return false;
            }
            log(AuthErrorCode.SignupsDisabled);
            return false;
          },
          after: async (user) => {
            try {
              await persistence.upsertHumanPrincipal({
                providerUserId: user.id,
                displayName: user.name,
              });
            } catch {
              log(AuthErrorCode.PrincipalSyncFailed);
            }
          },
        },
      },
      account: {
        update: {
          after: async (account) => {
            if (account?.providerId !== "credential") return;
            if (typeof account.userId !== "string") return;
            await recordCredentialAudit({ database: pgDatabase, log }, {
              providerUserId: account.userId,
              operation: PASSWORD_CHANGE_OPERATION,
            });
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (context != null && context.request === undefined) return;
            try {
              await persistence.upsertHumanPrincipalForProviderUser(
                session.userId,
              );
              if (!await persistence.hasEnabledPrincipal(session.userId)) {
                return false;
              }
              // otpOptions.sendOTP is never configured, so /two-factor/verify-otp
              // is unreachable; enabling it requires stamping factorVerifiedAt for
              // that path too (and adding it to VERIFY_PATHS in session-assurance.ts).
              if (
                context?.path === "/two-factor/verify-totp" ||
                context?.path === "/two-factor/verify-backup-code"
              ) {
                return { data: { ...session, factorVerifiedAt: now() } };
              }
              const passkeyId = context
                ? await authenticatingPasskeyId(
                  context.context,
                  context.path,
                  context.body,
                )
                : undefined;
              if (passkeyId) return { data: { ...session, passkeyId } };
              return undefined;
            } catch {
              return false;
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

export function createAuthProvider(dependencies: AuthProviderDependencies) {
  return betterAuth(buildBetterAuthOptions(dependencies));
}

/**
 * Builds the provider and waits for its plugin `init` hooks. `betterAuth()`
 * starts them in the background and the OAuth provider's hook queries the
 * database, so a caller that closes the pool (or boots a server) without
 * awaiting `$context` leaves an unhandled rejection. A failed init rejects
 * here instead.
 */
export async function createReadyAuthProvider(
  dependencies: AuthProviderDependencies,
) {
  const auth = createAuthProvider(dependencies);
  await auth.$context;
  return auth;
}
