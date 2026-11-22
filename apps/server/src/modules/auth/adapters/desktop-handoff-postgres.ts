import { StandardError, unprocessable } from "@bakery/contracts/http";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import {
  type AuthAuditCorrelation,
  recordAuthAudit,
} from "../application/audit.ts";
import { sha256Hex } from "../application/access-tokens.ts";
import {
  DESKTOP_CREDENTIAL_PREFIX,
  DESKTOP_SESSION_TTL_MS,
  isOneTimeCode,
  randomSecret,
} from "../domain/desktop-sign-in.ts";
import {
  DESKTOP_HANDOFF_TTL_MS,
  DesktopHandoffRefusal,
  safeReturnPath,
} from "../domain/desktop-handoff.ts";

/** Audit resource type of every handoff row. */
export const DESKTOP_HANDOFF_RESOURCE_TYPE = "desktop_handoff";
/** Audit operations written by the handoff page. */
export const DesktopHandoffAuditOperation = Object.freeze(
  {
    Redeem: "auth.desktopHandoff.redeem",
    Refuse: "auth.desktopHandoff.refuse",
    ReplayRevoke: "auth.desktopHandoff.replayRevoke",
  } as const,
);

export type DesktopHandoffCreated = { code: string; expiresAt: string };

/**
 * `desktopHandoffs.create`: a one-use code for the desktop sign-in that made
 * the request. Only a desktop sign-in may ask: a browser cookie session or an
 * access token is refused, so a page in a browser can never mint a code.
 */
export async function createDesktopHandoff(
  transaction: PgTransactionClient,
  input: { sessionId: string | undefined; returnTo: string },
  dependencies: {
    principalId: string;
    correlation: AuthAuditCorrelation;
    now?: Date;
  },
): Promise<DesktopHandoffCreated> {
  const now = dependencies.now ?? new Date();
  if (!input.sessionId) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  const session = await transaction.query<{ desktop: boolean }>(
    `select starts_with(token, $2) as desktop from public.session
      where id = $1 and "expiresAt" > $3`,
    [input.sessionId, DESKTOP_CREDENTIAL_PREFIX, now],
  );
  if (session.rows[0]?.desktop !== true) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const returnTo = safeReturnPath(input.returnTo);
  if (returnTo === null) {
    throw unprocessable(["returnTo"], "desktop_handoff_return_to_invalid");
  }
  const code = randomSecret();
  const expiresAt = new Date(now.getTime() + DESKTOP_HANDOFF_TTL_MS);
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.desktop_handoffs
       (code_hash, desktop_session_id, principal_id, return_to, created_at,
        expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      await sha256Hex(code),
      input.sessionId,
      dependencies.principalId,
      returnTo,
      now,
      expiresAt,
    ],
  );
  await recordAuthAudit(transaction, dependencies.correlation, {
    organizationId: null,
    principalId: dependencies.principalId,
    operation: AuthImplementedAction.DesktopHandoffsCreate,
    resourceType: DESKTOP_HANDOFF_RESOURCE_TYPE,
    resourceId: inserted.rows[0].id,
    details: { desktopSessionId: input.sessionId },
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export type DesktopHandoffOutcome =
  | { kind: "issued"; token: string; returnTo: string; expiresAt: Date }
  | { kind: "refused"; reason: DesktopHandoffRefusal };

type HandoffRow = {
  id: string;
  desktopSessionId: string;
  principalId: string;
  returnTo: string;
  expiresAt: Date;
  consumedAt: Date | null;
  browserSessionId: string | null;
};

/** A browser session token; never the desktop credential's prefix. */
function browserSessionToken(): string {
  for (;;) {
    const token = randomSecret();
    if (!token.startsWith(DESKTOP_CREDENTIAL_PREFIX)) return token;
  }
}

/**
 * Spends a code once. The right code within its 30 seconds, for a desktop
 * sign-in that still holds, opens a new browser session for the same person
 * with the same assurance. A spent code is refused and the browser session it
 * issued is ended, so a code that leaked and was raced loses both. An expired
 * code, or one whose desktop sign-in ended, is spent and refused. An unknown
 * code changes nothing.
 */
export async function redeemDesktopHandoff(
  database: PgDatabase,
  code: string | undefined,
  dependencies: {
    correlation: AuthAuditCorrelation;
    clientAddress?: string | null;
    now?: Date;
  },
): Promise<DesktopHandoffOutcome> {
  const now = dependencies.now ?? new Date();
  if (code === undefined || !isOneTimeCode(code)) {
    return { kind: "refused", reason: DesktopHandoffRefusal.Missing };
  }
  const codeHash = await sha256Hex(code);
  return await withPgTransaction(database, async (transaction) => {
    const found = await transaction.query<HandoffRow>(
      `select id, desktop_session_id as "desktopSessionId",
              principal_id as "principalId", return_to as "returnTo",
              expires_at as "expiresAt", consumed_at as "consumedAt",
              browser_session_id as "browserSessionId"
         from bakery.desktop_handoffs where code_hash = $1 for update`,
      [codeHash],
    );
    const row = found.rows[0];
    if (!row) return { kind: "refused", reason: DesktopHandoffRefusal.Missing };
    const audit = (operation: string, details: Record<string, unknown>) =>
      recordAuthAudit(transaction, dependencies.correlation, {
        organizationId: null,
        principalId: row.principalId,
        operation,
        resourceType: DESKTOP_HANDOFF_RESOURCE_TYPE,
        resourceId: row.id,
        details,
      });
    if (row.consumedAt !== null) {
      if (row.browserSessionId !== null) {
        const revoked = await transaction.query(
          "delete from public.session where id = $1",
          [row.browserSessionId],
        );
        await audit(DesktopHandoffAuditOperation.ReplayRevoke, {
          sessionId: row.browserSessionId,
          revokedSessionCount: revoked.rowCount ?? 0,
        });
      }
      return { kind: "refused", reason: DesktopHandoffRefusal.Used };
    }
    const spend = async (reason: DesktopHandoffRefusal) => {
      await transaction.query(
        "update bakery.desktop_handoffs set consumed_at = $2 where id = $1",
        [row.id, now],
      );
      await audit(DesktopHandoffAuditOperation.Refuse, { reason });
      return { kind: "refused", reason } as const;
    };
    if (row.expiresAt.getTime() <= now.getTime()) {
      return await spend(DesktopHandoffRefusal.Expired);
    }
    const desktop = await transaction.query<{
      userId: string;
      userAgent: string | null;
      factorVerifiedAt: Date | null;
      expiresAt: Date;
    }>(
      `select "userId", "userAgent", "factorVerifiedAt", "expiresAt"
         from public.session
        where id = $1 and "expiresAt" > $2 and starts_with(token, $3)`,
      [row.desktopSessionId, now, DESKTOP_CREDENTIAL_PREFIX],
    );
    const source = desktop.rows[0];
    if (!source) return await spend(DesktopHandoffRefusal.SignedOut);
    const token = browserSessionToken();
    // Never longer than the desktop sign-in it came from.
    const expiresAt = new Date(
      Math.min(
        now.getTime() + DESKTOP_SESSION_TTL_MS,
        source.expiresAt.getTime(),
      ),
    );
    const session = await transaction.query<{ id: string }>(
      `insert into public.session (
         token, "userId", "expiresAt", "createdAt", "updatedAt",
         "ipAddress", "userAgent", "factorVerifiedAt"
       ) values ($1, $2, $3, $4, $4, $5, $6, $7)
       returning id`,
      [
        token,
        source.userId,
        expiresAt,
        now,
        dependencies.clientAddress ?? null,
        source.userAgent,
        source.factorVerifiedAt,
      ],
    );
    const sessionId = session.rows[0].id;
    await transaction.query(
      `update bakery.desktop_handoffs
          set consumed_at = $2, browser_session_id = $3
        where id = $1`,
      [row.id, now, sessionId],
    );
    await audit(DesktopHandoffAuditOperation.Redeem, {
      desktopSessionId: row.desktopSessionId,
      sessionId,
    });
    return { kind: "issued", token, returnTo: row.returnTo, expiresAt };
  });
}

/**
 * Ends every browser session the given desktop sign-ins handed off, so a
 * window session never outlives the app's own sign-in: called wherever a
 * desktop session is deleted (sign out, revoke from the sessions list, revoke
 * others, a replayed sign-in code). Returns how many it ended.
 */
export async function endHandedOffSessions(
  transaction: Pick<PgTransactionClient, "query">,
  desktopSessionIds: readonly string[],
): Promise<number> {
  if (desktopSessionIds.length === 0) return 0;
  const ended = await transaction.query(
    `delete from public.session
      where id in (
        select browser_session_id from bakery.desktop_handoffs
         where desktop_session_id = any($1::uuid[])
           and browser_session_id is not null
      )`,
    [desktopSessionIds],
  );
  return ended.rowCount ?? 0;
}
