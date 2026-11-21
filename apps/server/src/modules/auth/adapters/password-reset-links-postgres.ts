import { createHash, randomBytes } from "node:crypto";
import { PrincipalType } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import type { InstallationActor } from "../application/authority.ts";
import {
  type AuthAuditCorrelation,
  recordAuthAudit,
} from "../application/audit.ts";
import { spendRateLimitAttempt } from "./rate-limit-postgres.ts";

/** How long an issued link stays redeemable. */
export const PASSWORD_RESET_LINK_TTL_MS = 60 * 60_000;
/** Web route the UI serves for redemption; the token rides in its query. */
export const PASSWORD_RESET_PATH = "/sign-in/reset-password";
const TOKEN_BYTES = 32;

/**
 * Redemption attempts per window, spent before the link is looked up so a
 * failed guess counts. Keyed per client address and per token-digest prefix,
 * in the provider's own `rateLimit` table under a Bakery key prefix; for
 * these keys `lastRequest` holds the window start in epoch milliseconds.
 */
const REDEMPTION_RATE_LIMIT = {
  windowMs: 60_000,
  maxPerAddress: 10,
  maxPerToken: 5,
} as const;
const RATE_LIMIT_KEY_PREFIX = "bakery-password-reset";

/** The auth provider's own password hashing and length rule (sign-up and change password use the same). */
export type PasswordHasher = {
  hash(password: string): Promise<string>;
  config: { minPasswordLength: number; maxPasswordLength: number };
};

export type IssuedPasswordResetLink = {
  id: string;
  url: string;
  expiresAt: string;
  revokedLinkCount: number;
};

export type RedeemedPasswordResetLink = {
  linkId: string;
  principalId: string;
  revokedSessionCount: number;
};

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The one refusal for an unknown, used, expired or revoked link, so none is distinguishable. */
function linkUnusable(): StandardError {
  return new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

/**
 * Issues a link for one enabled human and revokes that person's earlier
 * unused links. The plaintext token exists only in the returned URL.
 */
export async function issuePasswordResetLink(
  transaction: PgTransactionClient,
  actor: InstallationActor,
  target: string,
  publicBaseUrl: string,
  now = new Date(),
): Promise<IssuedPasswordResetLink> {
  const principal = await transaction.query(
    `select id from bakery.principals
     where id = $1 and principal_type = $2 and disabled_at is null
       and provider_user_id is not null
     for update`,
    [target, PrincipalType.Human],
  );
  if (principal.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const revoked = await transaction.query(
    `update bakery.password_reset_links set revoked_at = $2
     where principal_id = $1 and used_at is null and revoked_at is null`,
    [target, now],
  );
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_LINK_TTL_MS);
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.password_reset_links (
       principal_id, token_hash, issued_by_principal_id, created_at, expires_at
     ) values ($1, $2, $3, $4, $5) returning id`,
    [target, digest(token), actor.subject.principalId, now, expiresAt],
  );
  const url = new URL(PASSWORD_RESET_PATH, new URL(publicBaseUrl).origin);
  url.searchParams.set("token", token);
  return {
    id: inserted.rows[0].id,
    url: url.toString(),
    expiresAt: expiresAt.toISOString(),
    revokedLinkCount: revoked.rowCount ?? 0,
  };
}

function checkPasswordRule(password: string, hasher: PasswordHasher): void {
  if (password.length < hasher.config.minPasswordLength) {
    throw unprocessable(["newPassword"], "password_too_short");
  }
  if (password.length > hasher.config.maxPasswordLength) {
    throw unprocessable(["newPassword"], "password_too_long");
  }
}

/**
 * Redeems a link: in one transaction it locks the live link, sets the
 * password through the provider's hashing, consumes the link, deletes every
 * browser session of the person and writes the audit row.
 */
export async function redeemPasswordResetLink(
  database: PgDatabase,
  input: { token: string; newPassword: string },
  dependencies: {
    hasher: PasswordHasher;
    clientAddress: string | undefined;
    correlation: AuthAuditCorrelation;
    now?: Date;
  },
): Promise<RedeemedPasswordResetLink> {
  const now = dependencies.now ?? new Date();
  const tokenHash = digest(input.token);
  const limits = [
    [
      `${RATE_LIMIT_KEY_PREFIX}:address:${
        dependencies.clientAddress ?? "unknown"
      }`,
      REDEMPTION_RATE_LIMIT.maxPerAddress,
    ],
    [
      `${RATE_LIMIT_KEY_PREFIX}:token:${tokenHash.slice(0, 16)}`,
      REDEMPTION_RATE_LIMIT.maxPerToken,
    ],
  ] as const;
  for (const [key, max] of limits) {
    const retryAfterSeconds = await spendRateLimitAttempt(
      database,
      key,
      { max, windowMs: REDEMPTION_RATE_LIMIT.windowMs },
      now.getTime(),
    );
    if (retryAfterSeconds !== undefined) {
      throw new StandardError({
        code: "RATE_LIMITED",
        params: { retryAfterSeconds },
      });
    }
  }
  checkPasswordRule(input.newPassword, dependencies.hasher);
  const passwordHash = await dependencies.hasher.hash(input.newPassword);
  return await withPgTransaction(database, async (transaction) => {
    const link = await transaction.query<
      { id: string; principalId: string; providerUserId: string }
    >(
      `select link.id, link.principal_id as "principalId",
         principal.provider_user_id as "providerUserId"
       from bakery.password_reset_links as link
       join bakery.principals as principal on principal.id = link.principal_id
       where link.token_hash = $1 and link.used_at is null
         and link.revoked_at is null and link.expires_at > $2
         and principal.disabled_at is null
         and principal.provider_user_id is not null
       for update of link`,
      [tokenHash, now],
    );
    if (link.rows.length !== 1) throw linkUnusable();
    const { id, principalId, providerUserId } = link.rows[0];
    const updated = await transaction.query(
      `update public.account set password = $2, "updatedAt" = $3
       where "userId" = $1 and "providerId" = 'credential'`,
      [providerUserId, passwordHash, now],
    );
    if ((updated.rowCount ?? 0) === 0) {
      // A person who only signed in through SSO or GitHub gains a password
      // credential, as the provider's own set-password does.
      await transaction.query(
        `insert into public.account (
           "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
         ) values ($1, 'credential', $1, $2, $3, $3)`,
        [providerUserId, passwordHash, now],
      );
    }
    await transaction.query(
      "update bakery.password_reset_links set used_at = $2 where id = $1",
      [id, now],
    );
    const sessions = await transaction.query(
      'delete from public.session where "userId" = $1',
      [providerUserId],
    );
    const revokedSessionCount = sessions.rowCount ?? 0;
    await recordAuthAudit(transaction, dependencies.correlation, {
      organizationId: null,
      principalId,
      operation: AuthImplementedAction.PasswordResetsRedeem,
      resourceType: "password_reset_link",
      resourceId: id,
      details: { revokedSessionCount },
    });
    return { linkId: id, principalId, revokedSessionCount };
  });
}
