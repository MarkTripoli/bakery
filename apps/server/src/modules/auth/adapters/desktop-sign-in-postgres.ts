import { StandardError, unprocessable } from "@bakery/contracts/http";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../platform/database.ts";
import {
  type AuthAuditCorrelation,
  recordAuthAudit,
} from "../application/audit.ts";
import { sha256Hex } from "../application/access-tokens.ts";
import {
  canonicalDesktopRedirect,
  constantTimeEqual,
  DESKTOP_CLIENT_ID,
  DESKTOP_SESSION_TTL_MS,
  DESKTOP_SIGN_IN_TTL_MS,
  desktopSessionLabel,
  DesktopSignInDecision,
  type DesktopSignInPageState,
  DesktopSignInRefusal,
  exchangeRefusalFor,
  generateDesktopCredential,
  isCodeChallenge,
  isCodeVerifier,
  isOneTimeCode,
  normalizeComputerName,
  pageStateFor,
  pkceMatches,
  randomSecret,
} from "../domain/desktop-sign-in.ts";
import { spendRateLimitAttempt } from "./rate-limit-postgres.ts";
import { endHandedOffSessions } from "./desktop-handoff-postgres.ts";

/** Browser page that asks the person to confirm; served by the API server under `/api`. */
export const DESKTOP_SIGN_IN_PAGE_PATH = "/api/desktop/sign-in";
/** Audit resource type of every desktop sign-in row. */
export const DESKTOP_SIGN_IN_RESOURCE_TYPE = "desktop_sign_in";
/** Audit operations written by the browser page and the replay guard. */
export const DesktopSignInAuditOperation = Object.freeze(
  {
    Approve: "auth.desktopSignIn.approve",
    Cancel: "auth.desktopSignIn.cancel",
    Refuse: "auth.desktopSignIn.refuse",
    ReplayRevoke: "auth.desktopSignIn.replayRevoke",
  } as const,
);

const START_LIMIT = { max: 20, windowMs: 60_000 } as const;
const EXCHANGE_ADDRESS_LIMIT = { max: 10, windowMs: 60_000 } as const;
const EXCHANGE_REQUEST_LIMIT = { max: 5, windowMs: 60_000 } as const;
const RATE_LIMIT_KEY_PREFIX = "bakery-desktop-sign-in";

type RequestRow = {
  id: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  computerName: string;
  createdAt: Date;
  expiresAt: Date;
  decision: "approved" | "cancelled" | null;
  principalId: string | null;
  factorVerifiedAt: Date | null;
  codeHash: string | null;
  consumedAt: Date | null;
  sessionId: string | null;
};

/** The request columns, qualified by `alias` when given. */
function requestColumns(alias = ""): string {
  const at = alias ? `${alias}.` : "";
  return [
    `${at}id`,
    `${at}client_id as "clientId"`,
    `${at}code_challenge as "codeChallenge"`,
    `${at}redirect_uri as "redirectUri"`,
    `${at}computer_name as "computerName"`,
    `${at}created_at as "createdAt"`,
    `${at}expires_at as "expiresAt"`,
    `${at}decision`,
    `${at}principal_id as "principalId"`,
    `${at}factor_verified_at as "factorVerifiedAt"`,
    `${at}code_hash as "codeHash"`,
    `${at}consumed_at as "consumedAt"`,
    `${at}session_id as "sessionId"`,
  ].join(", ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refused(reason: DesktopSignInRefusal): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function invalid(field: string): StandardError {
  return unprocessable([field], "desktop_sign_in_invalid");
}

async function limit(
  database: PgDatabase,
  key: string,
  rule: { max: number; windowMs: number },
  now: Date,
): Promise<void> {
  const retryAfterSeconds = await spendRateLimitAttempt(
    database,
    `${RATE_LIMIT_KEY_PREFIX}:${key}`,
    rule,
    now.getTime(),
  );
  if (retryAfterSeconds !== undefined) {
    throw new StandardError({
      code: "RATE_LIMITED",
      params: { retryAfterSeconds },
    });
  }
}

export type DesktopSignInStarted = {
  id: string;
  confirmUrl: string;
  expiresAt: string;
};

/** Opens one request. Grants nothing until a signed-in person confirms it. */
export async function startDesktopSignIn(
  database: PgDatabase,
  input: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    computerName: string;
  },
  dependencies: {
    publicBaseUrl: string;
    clientAddress: string | undefined;
    now?: Date;
  },
): Promise<DesktopSignInStarted> {
  const now = dependencies.now ?? new Date();
  await limit(
    database,
    `start:${dependencies.clientAddress ?? "unknown"}`,
    START_LIMIT,
    now,
  );
  if (input.clientId !== DESKTOP_CLIENT_ID) throw invalid("clientId");
  if (input.codeChallengeMethod !== "S256") {
    throw invalid("codeChallengeMethod");
  }
  if (!isCodeChallenge(input.codeChallenge)) throw invalid("codeChallenge");
  const redirectUri = canonicalDesktopRedirect(input.redirectUri);
  if (redirectUri === null) throw invalid("redirectUri");
  const computerName = normalizeComputerName(input.computerName);
  if (computerName === null) throw invalid("computerName");
  const expiresAt = new Date(now.getTime() + DESKTOP_SIGN_IN_TTL_MS);
  const inserted = await database.query<{ id: string }>(
    `insert into bakery.desktop_sign_in_requests (
       client_id, code_challenge, redirect_uri, computer_name, created_at,
       expires_at
     ) values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      DESKTOP_CLIENT_ID,
      input.codeChallenge,
      redirectUri,
      computerName,
      now,
      expiresAt,
    ],
  );
  const id = inserted.rows[0].id;
  const url = new URL(
    DESKTOP_SIGN_IN_PAGE_PATH,
    new URL(dependencies.publicBaseUrl).origin,
  );
  url.searchParams.set("request", id);
  return { id, confirmUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

export type DesktopSignInView = {
  state: DesktopSignInPageState;
  computerName?: string;
  createdAt?: Date;
};

/** What the browser page shows for a request id taken from its address. */
export async function viewDesktopSignIn(
  database: Pick<PgDatabase, "query">,
  id: string | undefined,
  now = new Date(),
): Promise<DesktopSignInView> {
  if (!id || !UUID.test(id)) return { state: "missing" };
  const result = await database.query<RequestRow>(
    `select ${requestColumns()} from bakery.desktop_sign_in_requests
     where id = $1`,
    [id],
  );
  const row = result.rows[0] ?? null;
  const state = pageStateFor(row, now);
  return state === "confirm"
    ? { state, computerName: row!.computerName, createdAt: row!.createdAt }
    : { state };
}

export type DesktopSignInDecided =
  | { state: "approved"; redirect: string }
  | { state: "cancelled" }
  | { state: Exclude<DesktopSignInPageState, "confirm"> };

/**
 * Records the person's answer on the page. Approval issues the one-time code
 * and returns the redirect that carries it; only its digest is stored.
 */
export async function decideDesktopSignIn(
  database: PgDatabase,
  input: {
    id: string | undefined;
    decision: DesktopSignInDecision;
    principalId: string;
    factorVerifiedAt: Date | null;
  },
  correlation: AuthAuditCorrelation,
  now = new Date(),
): Promise<DesktopSignInDecided> {
  if (!input.id || !UUID.test(input.id)) return { state: "missing" };
  const id = input.id;
  return await withPgTransaction(database, async (transaction) => {
    const result = await transaction.query<RequestRow>(
      `select ${requestColumns()} from bakery.desktop_sign_in_requests
       where id = $1 for update`,
      [id],
    );
    const row = result.rows[0] ?? null;
    const state = pageStateFor(row, now);
    if (state !== "confirm") return { state };
    if (input.decision === DesktopSignInDecision.Cancelled) {
      await transaction.query(
        `update bakery.desktop_sign_in_requests
         set decision = 'cancelled', decided_at = $2, principal_id = $3
         where id = $1`,
        [id, now, input.principalId],
      );
      await recordAuthAudit(transaction, correlation, {
        organizationId: null,
        principalId: input.principalId,
        operation: DesktopSignInAuditOperation.Cancel,
        resourceType: DESKTOP_SIGN_IN_RESOURCE_TYPE,
        resourceId: id,
        details: { clientId: DESKTOP_CLIENT_ID },
      });
      return { state: "cancelled" };
    }
    const code = randomSecret();
    await transaction.query(
      `update bakery.desktop_sign_in_requests
       set decision = 'approved', decided_at = $2, principal_id = $3,
         factor_verified_at = $4, code_hash = $5
       where id = $1`,
      [
        id,
        now,
        input.principalId,
        input.factorVerifiedAt,
        await sha256Hex(code),
      ],
    );
    await recordAuthAudit(transaction, correlation, {
      organizationId: null,
      principalId: input.principalId,
      operation: DesktopSignInAuditOperation.Approve,
      resourceType: DESKTOP_SIGN_IN_RESOURCE_TYPE,
      resourceId: id,
      details: { clientId: DESKTOP_CLIENT_ID },
    });
    const redirect = new URL(row!.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("request", id);
    return { state: "approved", redirect: redirect.toString() };
  });
}

export type DesktopSignInCredential = {
  credential: string;
  sessionId: string;
  expiresAt: string;
};

type ExchangeOutcome =
  | { kind: "issued"; value: DesktopSignInCredential }
  | { kind: "missing" }
  | { kind: "refused"; reason: DesktopSignInRefusal };

/**
 * Exchanges a confirmed request for the desktop credential: one attempt per
 * request, PKCE-bound, client-bound. A replay of a spent request ends the
 * sign-in the first exchange issued. Refusals that change state commit
 * before the error is raised.
 */
export async function exchangeDesktopSignIn(
  database: PgDatabase,
  input: {
    id: string;
    clientId: string;
    code: string;
    codeVerifier: string;
  },
  dependencies: {
    clientAddress: string | undefined;
    correlation: AuthAuditCorrelation;
    now?: Date;
  },
): Promise<DesktopSignInCredential> {
  const now = dependencies.now ?? new Date();
  await limit(
    database,
    `exchange:address:${dependencies.clientAddress ?? "unknown"}`,
    EXCHANGE_ADDRESS_LIMIT,
    now,
  );
  await limit(
    database,
    `exchange:request:${input.id.toLowerCase()}`,
    EXCHANGE_REQUEST_LIMIT,
    now,
  );
  const outcome = await withPgTransaction(
    database,
    async (transaction): Promise<ExchangeOutcome> => {
      const result = await transaction.query<
        RequestRow & { providerUserId: string | null }
      >(
        `select ${
          requestColumns("request")
        }, principal.provider_user_id as "providerUserId"
         from bakery.desktop_sign_in_requests as request
         left join bakery.principals as principal
           on principal.id = request.principal_id
           and principal.disabled_at is null
           and principal.principal_type = 'human'
         where request.id = $1
         for update of request`,
        [input.id],
      );
      const row = result.rows[0];
      if (!row) return { kind: "missing" };
      const audit = (operation: string, details: Record<string, unknown>) =>
        recordAuthAudit(transaction, dependencies.correlation, {
          organizationId: null,
          principalId: row.principalId,
          operation,
          resourceType: DESKTOP_SIGN_IN_RESOURCE_TYPE,
          resourceId: row.id,
          details,
        });
      const spend = async (reason: DesktopSignInRefusal) => {
        await transaction.query(
          `update bakery.desktop_sign_in_requests set consumed_at = $2
           where id = $1`,
          [row.id, now],
        );
        await audit(DesktopSignInAuditOperation.Refuse, { reason });
        return { kind: "refused", reason } as const;
      };
      // The code is checked first: only its holder may change the request's
      // state, so a caller that knows just the request id cannot revoke the
      // issued sign-in or spoil a pending one.
      const codeMatches = row.codeHash !== null && isOneTimeCode(input.code) &&
        constantTimeEqual(await sha256Hex(input.code), row.codeHash);
      const refusal = exchangeRefusalFor(row, input.clientId, now);
      if (refusal && !codeMatches) {
        return {
          kind: "refused",
          reason: refusal.burn ? DesktopSignInRefusal.Mismatch : refusal.reason,
        };
      }
      if (!codeMatches) {
        return { kind: "refused", reason: DesktopSignInRefusal.Mismatch };
      }
      if (refusal) {
        if (refusal.revokeIssued && row.sessionId) {
          const revoked = await transaction.query(
            "delete from public.session where id = $1",
            [row.sessionId],
          );
          await endHandedOffSessions(transaction, [row.sessionId]);
          await audit(DesktopSignInAuditOperation.ReplayRevoke, {
            sessionId: row.sessionId,
            revokedSessionCount: revoked.rowCount ?? 0,
          });
        }
        return refusal.burn
          ? await spend(refusal.reason)
          : { kind: "refused", reason: refusal.reason };
      }
      const secretsMatch = isCodeVerifier(input.codeVerifier) &&
        await pkceMatches(input.codeVerifier, row.codeChallenge);
      if (!secretsMatch || row.providerUserId === null) {
        return await spend(DesktopSignInRefusal.Mismatch);
      }
      const credential = generateDesktopCredential();
      const expiresAt = new Date(now.getTime() + DESKTOP_SESSION_TTL_MS);
      const session = await transaction.query<{ id: string }>(
        `insert into public.session (
           token, "userId", "expiresAt", "createdAt", "updatedAt",
           "ipAddress", "userAgent", "factorVerifiedAt"
         ) values ($1, $2, $3, $4, $4, $5, $6, $7)
         returning id`,
        [
          credential,
          row.providerUserId,
          expiresAt,
          now,
          dependencies.clientAddress ?? null,
          desktopSessionLabel(row.computerName),
          row.factorVerifiedAt,
        ],
      );
      const sessionId = session.rows[0].id;
      await transaction.query(
        `update bakery.desktop_sign_in_requests
         set consumed_at = $2, session_id = $3
         where id = $1`,
        [row.id, now, sessionId],
      );
      await audit(AuthImplementedAction.DesktopSignInsExchange, {
        clientId: DESKTOP_CLIENT_ID,
        sessionId,
      });
      return {
        kind: "issued",
        value: { credential, sessionId, expiresAt: expiresAt.toISOString() },
      };
    },
  );
  if (outcome.kind === "missing") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (outcome.kind === "refused") throw refused(outcome.reason);
  return outcome.value;
}
