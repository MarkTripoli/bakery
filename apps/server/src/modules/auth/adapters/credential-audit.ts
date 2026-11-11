import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import type { PgDatabase } from "../../../platform/database.ts";
import { recordAuthAudit } from "../application/audit.ts";

/**
 * Better Auth routes whose success changes how a person signs in, mapped to
 * the audit operation each records. Failed calls (an `APIError` return) write
 * nothing. The call context carries no Bakery action, so these rows have no
 * organization and attribute the acting person's principal.
 */
export const CREDENTIAL_AUDIT_OPERATIONS: Readonly<Record<string, string>> =
  Object.freeze({
    "/passkey/verify-registration": "auth.passkey.add",
    "/passkey/delete-passkey": "auth.passkey.delete",
    "/passkey/update-passkey": "auth.passkey.rename",
    "/two-factor/enable": "auth.twoFactor.enable",
    "/two-factor/disable": "auth.twoFactor.disable",
    "/two-factor/generate-backup-codes": "auth.twoFactor.regenerateBackupCodes",
  });

export const CREDENTIAL_AUDIT_RESOURCE_TYPE = "auth_credential";

/**
 * Operation for any change to a credential account's password, recorded from
 * the `account.update` database hook so `/change-password`, `/reset-password`
 * and server-side password writes all land in one place.
 */
export const PASSWORD_CHANGE_OPERATION = "auth.password.change";

export type CredentialAuditDeps = {
  database: PgDatabase;
  log?: (code: string) => void;
};

/**
 * Appends one audit row for a person's own credential change. Never throws:
 * an audit write failure must not turn a completed sign-in change into an
 * error, so it is logged by code only (no values) and swallowed.
 */
export async function recordCredentialAudit(
  { database, log = () => {} }: CredentialAuditDeps,
  input: {
    providerUserId: string;
    operation: string;
    requestId?: string | null;
    details?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  try {
    const principal = await database.query<{ id: string }>(
      "select id from bakery.principals where provider_user_id = $1",
      [input.providerUserId],
    );
    const id = input.requestId || crypto.randomUUID();
    await recordAuthAudit(database, { requestId: id, traceId: id }, {
      organizationId: null,
      principalId: principal.rows[0]?.id ?? null,
      operation: input.operation,
      resourceType: CREDENTIAL_AUDIT_RESOURCE_TYPE,
      resourceId: input.providerUserId,
      details: input.details,
    });
  } catch {
    log("AUTH_AUDIT_WRITE_FAILED");
  }
}

/**
 * Records sign-in credential changes made through Better Auth's own routes.
 * Owns no endpoints; password changes are recorded by the `account.update`
 * database hook instead (see `better-auth.ts`).
 */
export function credentialAuditPlugin(
  deps: CredentialAuditDeps,
): BetterAuthPlugin {
  return {
    id: "bakery-credential-audit",
    hooks: {
      after: [{
        matcher: (context) =>
          Object.hasOwn(CREDENTIAL_AUDIT_OPERATIONS, context.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          if (isAPIError(ctx.context.returned)) return;
          const providerUserId = ctx.context.session?.user.id ??
            ctx.context.newSession?.user.id;
          if (!providerUserId) return;
          await recordCredentialAudit(deps, {
            providerUserId,
            operation: CREDENTIAL_AUDIT_OPERATIONS[ctx.path],
            requestId: ctx.request?.headers.get("x-request-id"),
          });
        }),
      }],
    },
  };
}
