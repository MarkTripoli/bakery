import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import {
  resolveSessionAssurance,
  SessionAssurance,
} from "../domain/assurance.ts";
import { isPostgresUniqueViolation } from "../../../platform/postgres-errors.ts";
import {
  assertNotLastSignInMethod,
  PASSKEY_POLICY_ERROR_CODES,
} from "./passkey-policy.ts";

/** Signed cookie the plugin sets while a two-factor challenge is pending. */
const TWO_FACTOR_COOKIE_NAME = "two_factor";

/** Authenticator-app issuer label; never client-overridable (used by `adapters/better-auth.ts` too, so there is exactly one literal). */
export const TOTP_ISSUER = "Bakery";

/** Plugin endpoint path (below `/api/auth`) that re-proves the password on the current session. */
const REAUTHENTICATE_PATH = "/bakery/reauthenticate";
/** Failed and successful password re-proofs allowed per window and client address. */
const REAUTHENTICATE_RATE_LIMIT = { window: 60, max: 5 } as const;

/** Wrong-password budget per person and lockout window for `/bakery/reauthenticate`; counted per user, not per address, so rotating addresses never buys more guesses. */
const REAUTHENTICATE_MAX_FAILURES = 5;
const REAUTHENTICATE_LOCKOUT_MS = 15 * 60_000;
const REAUTHENTICATE_FAILURE_PREFIX = "bakery-reauth-failure-";

/** `/api/auth/*` paths a pending (unverified) session may still reach. */
const PENDING_ALLOWED_PATHS: Record<string, true> = {
  "/get-session": true,
  "/sign-out": true,
  "/two-factor/verify-totp": true,
  "/two-factor/verify-backup-code": true,
};

/** How long a factor-proof stamp authorizes disable/regenerate. */
const FACTOR_FRESH_MS = 5 * 60_000;
/** How long a sign-in stays fresh enough for management calls: every caller on `fresh` paths, passwordless callers on `password-or-fresh` paths. */
const IDENTITY_FRESH_MS = 10 * 60_000;
/** TTL for the per-code replay marker: one TOTP period + the verification window + slack. */
const TOTP_REPLAY_TTL_MS = 90_000;
/** Failed-verification budget and lockout duration for a pending session's factor attempts (mirrors the provider's own sign-in-path lockout). */
const LOCKOUT_MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

/**
 * `password-or-fresh`: the request body carries the password, so only a
 * passwordless caller needs a recent sign-in. `fresh`: passkey bodies carry
 * no password, so every caller needs a sign-in within `IDENTITY_FRESH_MS`.
 */
const MANAGEMENT_PATHS: Record<string, "password-or-fresh" | "fresh"> = {
  "/two-factor/enable": "password-or-fresh",
  "/two-factor/get-totp-uri": "password-or-fresh",
  "/two-factor/disable": "password-or-fresh",
  "/two-factor/generate-backup-codes": "password-or-fresh",
  "/passkey/generate-register-options": "fresh",
  "/passkey/verify-registration": "fresh",
  "/passkey/update-passkey": "fresh",
  "/passkey/delete-passkey": "fresh",
};
/**
 * `totp-users`: a person without TOTP has no factor to prove; a passkey is
 * not a TOTP substitute, so removing one needs proof only when TOTP is on.
 */
const FACTOR_PROOF_PATHS: Record<string, "always" | "totp-users"> = {
  "/two-factor/disable": "always",
  "/two-factor/generate-backup-codes": "always",
  "/passkey/delete-passkey": "totp-users",
};
/**
 * `otpOptions.sendOTP` is never configured, so `/two-factor/verify-otp` is
 * registered but unreachable (`send-otp` throws first). If OTP is ever
 * enabled, add that path here too — otherwise a session created through it
 * is silently never stamped and stays `Pending` forever.
 */
const VERIFY_PATHS: Record<string, true> = {
  "/two-factor/verify-totp": true,
  "/two-factor/verify-backup-code": true,
};

async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Reads the before-hook's carried-forward replay-marker identifier off the shared dispatch context. */
function replayMarkerFrom(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null || !("bakeryTotpMarker" in ctx)) {
    return undefined;
  }
  const { bakeryTotpMarker } = ctx;
  return typeof bakeryTotpMarker === "string" ? bakeryTotpMarker : undefined;
}

type TwoFactorRow = {
  userId?: string;
  failedVerificationCount?: number;
  lockedUntil?: string | Date | null;
};

/**
 * Bakery's own Better Auth plugin: it owns no endpoints, only policy hooks
 * layered in front of the `twoFactor` plugin. It must run first in the
 * `plugins` array so its `hooks.before` sees every request before the
 * `two-factor` plugin's own hooks do.
 */
export function bakerySessionAssurance(
  deps: { now: () => Date },
): BetterAuthPlugin {
  return {
    id: "bakery-session-assurance",
    endpoints: {
      bakeryReauthenticate: createAuthEndpoint(
        REAUTHENTICATE_PATH,
        {
          method: "POST",
          body: z.object({
            password: z.string().max(1024).describe(
              "The signed-in person's current password; may be empty so the handler can report a missing password after it checks the account.",
            ),
          }).describe("Password re-proof for the current session."),
        },
        async (ctx) => {
          // A pending-factor session never reaches this handler: the
          // before-hook refuses it with TWO_FACTOR_REQUIRED first.
          const current = await getSessionFromCtx(ctx, {
            disableRefresh: true,
          });
          if (!current) {
            throw new APIError("UNAUTHORIZED", {
              code: "UNAUTHORIZED",
              message: "Sign in to continue",
            });
          }
          const account = await ctx.context.internalAdapter
            .findCredentialAccount(current.user.id);
          if (!account?.password) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_NOT_SET",
              message: "This account has no password",
            });
          }
          // Blank input cannot match, so it neither verifies nor spends budget.
          if (ctx.body.password === "") {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_PASSWORD",
              message: "Invalid password",
            });
          }
          const nowMs = deps.now().getTime();
          const failurePrefix =
            `${REAUTHENTICATE_FAILURE_PREFIX}${current.user.id}-`;
          const failureRows = () =>
            ctx.context.adapter.findMany<{ expiresAt: string | Date }>({
              model: "verification",
              where: [{
                field: "identifier",
                operator: "starts_with",
                value: failurePrefix,
              }],
            }).then((rows) =>
              rows.filter((row) => new Date(row.expiresAt).getTime() > nowMs)
            );
          // Spend the attempt BEFORE verifying so concurrent guesses are
          // counted too; a success clears the budget below.
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${failurePrefix}${crypto.randomUUID()}`,
            value: "1",
            expiresAt: new Date(nowMs + REAUTHENTICATE_LOCKOUT_MS),
          });
          if ((await failureRows()).length > REAUTHENTICATE_MAX_FAILURES) {
            throw new APIError("TOO_MANY_REQUESTS", {
              code: "RATE_LIMITED",
              message: "Too many attempts. Try again later.",
            }, { "Retry-After": String(REAUTHENTICATE_LOCKOUT_MS / 1000) });
          }
          const matches = await ctx.context.password.verify({
            hash: account.password,
            password: ctx.body.password,
          });
          if (!matches) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_PASSWORD",
              message: "Invalid password",
            });
          }
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [{
              field: "identifier",
              operator: "starts_with",
              value: failurePrefix,
            }],
          });
          // Stamp the CURRENT session only: no session is created or
          // replaced, so the cookie, factor proof and passkey link survive.
          await ctx.context.internalAdapter.updateSession(
            current.session.token,
            { reauthenticatedAt: deps.now() },
          );
          return ctx.json({ reauthenticated: true });
        },
      ),
    },
    rateLimit: [{
      pathMatcher: (path) => path === REAUTHENTICATE_PATH,
      ...REAUTHENTICATE_RATE_LIMIT,
    }],
    schema: {
      session: {
        fields: {
          /** Last time the person re-proved their password on this session (`/bakery/reauthenticate`). */
          reauthenticatedAt: { type: "date", required: false, input: false },
          factorVerifiedAt: { type: "date", required: false, input: false },
          /** Passkey whose ceremony created the session; cascades with the passkey row. */
          passkeyId: { type: "string", required: false, input: false },
        },
      },
    },
    $ERROR_CODES: {
      TWO_FACTOR_REQUIRED: {
        code: "TWO_FACTOR_REQUIRED",
        message: "Complete two-factor verification to continue",
      },
      FACTOR_PROOF_REQUIRED: {
        code: "FACTOR_PROOF_REQUIRED",
        message: "Verify your authenticator or a backup code first",
      },
      FRESH_SIGN_IN_REQUIRED: {
        code: "FRESH_SIGN_IN_REQUIRED",
        message: "Sign in again to continue",
      },
      PASSWORD_NOT_SET: {
        code: "PASSWORD_NOT_SET",
        message: "This account has no password",
      },
      ...PASSKEY_POLICY_ERROR_CODES,
    },
    hooks: {
      before: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          try {
            const now = deps.now().getTime();
            // `/get-session` and `/sign-out` are unconditionally allowlisted
            // for pending sessions and nothing else in this hook branches on
            // them, so skip the extra session round-trip for both.
            const skipSessionLookup = ctx.path === "/get-session" ||
              ctx.path === "/sign-out";
            // `disableRefresh: true`: a policy read must never mutate session
            // state. Without it, `getSessionFromCtx` re-enters `/get-session`,
            // which — once the session is older than `updateAge` (24h) —
            // rotates the cookie and sets `ctx.context.newSession` itself,
            // which the after-hook would misread as "a new session was just
            // created" and skip stamping `factorVerifiedAt` entirely.
            const session = skipSessionLookup
              ? null
              : await getSessionFromCtx(ctx, { disableRefresh: true });

            if (session) {
              const assurance = resolveSessionAssurance({
                twoFactorEnabled: !!session.user.twoFactorEnabled,
                factorVerifiedAt: session.session.factorVerifiedAt ?? null,
              });
              if (
                assurance === SessionAssurance.Pending &&
                !Object.hasOwn(PENDING_ALLOWED_PATHS, ctx.path)
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Complete two-factor verification to continue",
                });
              }
            }

            // Account lockout for the pending-session verify flow: the
            // plugin's own budget/lockout (`assertTwoFactorNotLocked`,
            // `beginAttempt`) only applies when there is no existing session
            // (`isSignIn`), so a pending session (GitHub/passwordless sign-in
            // awaiting its factor) would otherwise brute-force unbudgeted.
            if (Object.hasOwn(VERIFY_PATHS, ctx.path) && session) {
              const twoFactorRow = await ctx.context.adapter.findOne<
                TwoFactorRow
              >({
                model: "twoFactor",
                where: [{ field: "userId", value: session.user.id }],
              });
              const lockedUntil = twoFactorRow?.lockedUntil;
              if (lockedUntil) {
                if (new Date(lockedUntil).getTime() > now) {
                  throw new APIError("TOO_MANY_REQUESTS", {
                    code: "ACCOUNT_TEMPORARILY_LOCKED",
                    message:
                      "Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
                  });
                }
                // Lapsed lock: clear it (guarded so a concurrent request that
                // just re-locked the account is never undone), mirroring the
                // provider's own `assertTwoFactorNotLocked`.
                await ctx.context.adapter.update({
                  model: "twoFactor",
                  where: [
                    { field: "userId", value: session.user.id },
                    {
                      field: "lockedUntil",
                      operator: "lte",
                      value: new Date(now),
                    },
                  ],
                  update: { failedVerificationCount: 0, lockedUntil: null },
                });
              }
            }

            const requestBody: unknown = ctx.body;
            const requestField = (name: string): unknown =>
              typeof requestBody === "object" && requestBody !== null &&
                name in requestBody
                ? (requestBody as Record<string, unknown>)[name]
                : undefined;
            let body: Record<string, unknown> | undefined;
            if (
              Object.hasOwn(VERIFY_PATHS, ctx.path) &&
              requestField("trustDevice")
            ) {
              body = { ...ctx.body, trustDevice: false };
            }
            if (ctx.path === "/two-factor/enable") {
              body = { ...(body ?? ctx.body), issuer: TOTP_ISSUER };
            }
            if (
              ctx.path === "/passkey/verify-registration" &&
              requestField("createSession")
            ) {
              // Registration is management, not sign-in: a session minted
              // here carries no `factorVerifiedAt` and would replace a
              // Verified cookie with a Pending one.
              body = { ...(body ?? ctx.body), createSession: false };
            }

            const managementRule = Object.hasOwn(MANAGEMENT_PATHS, ctx.path)
              ? MANAGEMENT_PATHS[ctx.path]
              : undefined;
            if (managementRule && session) {
              const passwordProves = managementRule === "password-or-fresh" &&
                !!(await ctx.context.internalAdapter
                  .findCredentialAccount(session.user.id))?.password;
              const signedInAt = Math.max(
                new Date(session.session.createdAt).getTime(),
                session.session.reauthenticatedAt
                  ? new Date(session.session.reauthenticatedAt).getTime()
                  : 0,
              );
              if (!passwordProves && now - signedInAt > IDENTITY_FRESH_MS) {
                throw new APIError("FORBIDDEN", {
                  code: "FRESH_SIGN_IN_REQUIRED",
                  message: "Sign in again to continue",
                });
              }
            }

            const factorRule = Object.hasOwn(FACTOR_PROOF_PATHS, ctx.path)
              ? FACTOR_PROOF_PATHS[ctx.path]
              : undefined;
            if (
              factorRule && session &&
              (factorRule === "always" || !!session.user.twoFactorEnabled)
            ) {
              const factorVerifiedAt = session.session.factorVerifiedAt;
              if (
                !factorVerifiedAt ||
                now - new Date(factorVerifiedAt).getTime() > FACTOR_FRESH_MS
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "FACTOR_PROOF_REQUIRED",
                  message: "Verify your authenticator or a backup code first",
                });
              }
            }

            if (ctx.path === "/passkey/delete-passkey" && session) {
              await assertNotLastSignInMethod(
                ctx.context,
                session.user.id,
                requestField("id"),
              );
            }

            let bakeryTotpMarker: string | undefined;
            if (ctx.path === "/two-factor/verify-totp") {
              let userId = session?.user.id;
              if (!userId) {
                const cookie = ctx.context.createAuthCookie(
                  TWO_FACTOR_COOKIE_NAME,
                );
                const signedCookie = await ctx.getSignedCookie(
                  cookie.name,
                  ctx.context.secret,
                );
                const challenge = signedCookie
                  ? await ctx.context.internalAdapter.findVerificationValue(
                    signedCookie,
                  )
                  : null;
                userId = challenge?.value;
              }
              if (userId) {
                const code = requestField("code");
                if (typeof code === "string") {
                  // Insert-first replay guard: a unique identifier per
                  // (user, code) makes two concurrent submissions of the same
                  // code race on the database instead of both reading an
                  // empty/stale marker and both being accepted.
                  const identifier =
                    `bakery-totp-used-${userId}-${await sha256hex(
                      `${userId}:${code}`,
                    )}`;
                  try {
                    await ctx.context.internalAdapter.createVerificationValue({
                      identifier,
                      value: "1",
                      expiresAt: new Date(now + TOTP_REPLAY_TTL_MS),
                    });
                    bakeryTotpMarker = identifier;
                  } catch (insertError) {
                    if (isAPIError(insertError)) throw insertError;
                    if (isPostgresUniqueViolation(insertError)) {
                      throw APIError.from("UNAUTHORIZED", {
                        code: "INVALID_CODE",
                        message: "Invalid code",
                      });
                    }
                    throw insertError;
                  }
                }
              }
            }

            const contextPatch: Record<string, unknown> = {};
            if (body) contextPatch.body = body;
            if (bakeryTotpMarker) {
              contextPatch.bakeryTotpMarker = bakeryTotpMarker;
            }
            if (Object.keys(contextPatch).length > 0) {
              return { context: contextPatch };
            }
            return;
          } catch (error) {
            if (isAPIError(error)) throw error;
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Internal Server Error",
            });
          }
        }),
      }],
      after: [{
        matcher: (context) =>
          Object.hasOwn(VERIFY_PATHS, context.path ?? "") ||
          context.path === "/two-factor/disable" ||
          context.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          try {
            const now = deps.now();
            const returned = ctx.context.returned;

            if (isAPIError(returned)) {
              if (ctx.path === "/two-factor/verify-totp") {
                // A wrong guess (or a lockout/other endpoint failure) must
                // not leave its insert-first marker behind: that marker is
                // keyed per exact code value, and leaving it would refuse a
                // later legitimately valid code that happens to equal it.
                // The identifier is the one the before-hook actually wrote
                // (carried via the dispatch context), never re-derived —
                // re-deriving from `ctx.context.session`/`newSession` can
                // disagree with what was inserted (e.g. a challenge-path
                // verify where no session exists yet).
                const marker = replayMarkerFrom(ctx);
                if (marker) {
                  await ctx.context.internalAdapter
                    .deleteVerificationByIdentifier(marker)
                    .catch(() => {});
                }
              }

              // Lockout bookkeeping must never override the endpoint's own
              // response: if this fails, the caller still sees the real
              // failure (wrong code, etc.), not an unrelated 500.
              try {
                const session = ctx.context.session;
                const returnedCode = returned.body?.code;
                if (
                  Object.hasOwn(VERIFY_PATHS, ctx.path) &&
                  session &&
                  (returnedCode === "INVALID_CODE" ||
                    returnedCode === "INVALID_BACKUP_CODE")
                ) {
                  const incremented = await ctx.context.adapter.incrementOne<
                    TwoFactorRow
                  >({
                    model: "twoFactor",
                    where: [{ field: "userId", value: session.user.id }],
                    increment: { failedVerificationCount: 1 },
                  });
                  const failures = incremented?.failedVerificationCount ?? 0;
                  if (failures >= LOCKOUT_MAX_FAILURES) {
                    await ctx.context.adapter.update({
                      model: "twoFactor",
                      where: [{ field: "userId", value: session.user.id }],
                      update: {
                        lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
                      },
                    });
                  }
                }
              } catch (lockoutError) {
                ctx.context.logger.warn(
                  "bakery-session-assurance: lockout bookkeeping failed",
                  lockoutError,
                );
              }
              return;
            }

            if (ctx.path === "/change-password") {
              // `revokeOtherSessions` deletes every session and mints a
              // replacement that carries no factor proof, which would leave a
              // TOTP user Pending right after proving their current password
              // from a Verified session. Carry the proof to the replacement.
              const prior = ctx.context.session;
              const replacement = ctx.context.newSession;
              const proof = prior?.session.factorVerifiedAt;
              if (
                prior && replacement && proof &&
                replacement.session.token !== prior.session.token
              ) {
                await ctx.context.internalAdapter.updateSession(
                  replacement.session.token,
                  { factorVerifiedAt: proof },
                );
              }
              return;
            }

            if (Object.hasOwn(VERIFY_PATHS, ctx.path)) {
              const prior = ctx.context.session;
              const created = ctx.context.newSession;
              // "Rotated" means a genuinely different session token, not
              // merely a truthy `newSession` — `getSessionFromCtx`'s own
              // cookie refresh also populates `newSession` while keeping the
              // same token (`api/routes/session.mjs` `updateSession(session.
              // session.token, ...)`), which must not be mistaken for the
              // enrollment-completion rotation below.
              const rotated = !!created &&
                created.session.token !== prior?.session.token;
              if (prior && !rotated) {
                await ctx.context.internalAdapter.updateSession(
                  prior.session.token,
                  { factorVerifiedAt: now },
                );
              } else if (
                prior && rotated && prior.user.twoFactorEnabled === false
              ) {
                const sessions = await ctx.context.internalAdapter
                  .listSessions(created.user.id);
                const otherTokens = sessions
                  .map((entry) => entry.token)
                  .filter((token) => token !== created.session.token);
                if (otherTokens.length > 0) {
                  await ctx.context.internalAdapter.deleteSessions(
                    otherTokens,
                  );
                }
              }

              const verifiedUserId = (created ?? prior)?.user.id;
              if (verifiedUserId) {
                await ctx.context.adapter.update({
                  model: "twoFactor",
                  where: [{ field: "userId", value: verifiedUserId }],
                  update: { failedVerificationCount: 0, lockedUntil: null },
                });
              }
            } else if (ctx.path === "/two-factor/disable") {
              const newSession = ctx.context.newSession;
              if (newSession) {
                const sessions = await ctx.context.internalAdapter
                  .listSessions(newSession.user.id);
                const otherTokens = sessions
                  .map((entry) => entry.token)
                  .filter((token) => token !== newSession.session.token);
                if (otherTokens.length > 0) {
                  await ctx.context.internalAdapter.deleteSessions(
                    otherTokens,
                  );
                }
              }
            }
          } catch (error) {
            if (isAPIError(error)) throw error;
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Internal Server Error",
            });
          }
        }),
      }],
    },
  };
}
