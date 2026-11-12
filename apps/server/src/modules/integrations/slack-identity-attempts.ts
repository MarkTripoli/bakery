/**
 * Persistence for Sign in with Slack linking attempts (`slack_identity_attempts`).
 *
 * An attempt is what makes a Slack round trip belong to one Bakery member: it
 * is created in that member's browser session, binds the Slack app, workspace
 * and (if any) Enterprise Grid organization being linked, and issues a state
 * and a nonce. The callback must present the state from the same session and
 * member; the nonce is what the identity token must carry
 * (`slack-identity.ts` checks it). The state and the nonce are returned once,
 * by {@link createSlackIdentityAttempt}, and stored as a SHA-256 hash and as
 * ciphertext. Nothing here stores or logs a token, a code or a name.
 *
 * A claim is one atomic update that matches the state hash, the session, the
 * member, the pending status and the expiry together, so a claim from the wrong
 * session or member changes nothing and the attempt stays usable by its owner,
 * and of two claims for one attempt exactly one wins. Every refusal looks the
 * same to the caller (`refused`): which condition failed is not told to the
 * party that may be guessing. Input that is wrong is refused before the
 * database is touched; a failure of the database itself throws.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import { sha256Hex } from "../../platform/canonical-json.ts";
import {
  decryptSlackIdentityNonce,
  encryptSlackIdentityNonce,
} from "../secrets/crypto.ts";
import {
  isSlackAppId,
  isSlackEnterpriseId,
  isSlackTeamId,
} from "./slack-scope.ts";

/** How long a member has to finish Sign in with Slack. */
export const SLACK_IDENTITY_ATTEMPT_TTL_MINUTES = 15;

const MAX_SESSION_ID_LENGTH = 256;
const MAX_KEY_ID_LENGTH = 128;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_STATE_LENGTH = 512;

/** Why an attempt ended without a link. Fixed, so it can be stored and shown. */
export const SLACK_ATTEMPT_FAILURE_CODES = [
  "provider_denied",
  "exchange_failed",
  "token_invalid",
  "link_refused",
  "nonce_unreadable",
  "superseded",
] as const;

export type SlackAttemptFailureCode =
  (typeof SLACK_ATTEMPT_FAILURE_CODES)[number];

/** What the attempt binds: the Slack app and workspace being linked. */
export type SlackAttemptBinding = {
  /** The Slack app (`A...`) the installation belongs to. */
  readonly appId: string;
  /** The app's OAuth client id: the audience an identity token must name. */
  readonly clientId: string;
  /** The Slack workspace (`T...`). */
  readonly teamId: string;
  /** The Enterprise Grid organization (`E...`) the installation recorded, if any. */
  readonly enterpriseId?: string;
};

export type CreateSlackIdentityAttemptInput = {
  readonly organizationId: string;
  /** The Bakery member who is linking their Slack identity. */
  readonly principalId: string;
  /** The browser session the callback must come back in. */
  readonly sessionId: string;
  readonly binding: SlackAttemptBinding;
  /** The key the nonce is sealed under, and the identity it is bound to. */
  readonly secretsKey: CryptoKey;
  readonly keyId: string;
};

export type CreateSlackIdentityAttemptResult =
  | {
    readonly ok: true;
    readonly attemptId: string;
    /** The secret the callback must present. Returned here only. */
    readonly state: string;
    /** What the identity token must carry. Returned here only. */
    readonly nonce: string;
    readonly expiresAt: string;
  }
  | { readonly ok: false; readonly reason: "malformed" | "not_a_member" };

export type ClaimSlackIdentityAttemptInput = {
  readonly state: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly secretsKey: CryptoKey;
  readonly keyId: string;
};

/** What a claimed attempt hands the callback: the bound values and the nonce. */
export type ClaimedSlackIdentityAttempt = {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly appId: string;
  readonly clientId: string;
  readonly teamId: string;
  readonly enterpriseId?: string;
  readonly nonce: string;
};

export type ClaimSlackIdentityAttemptResult =
  | { readonly ok: true; readonly attempt: ClaimedSlackIdentityAttempt }
  | { readonly ok: false; readonly reason: "refused" };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

function isBinding(value: unknown): value is SlackAttemptBinding {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return isSlackAppId(b.appId) && isSlackTeamId(b.teamId) &&
    typeof b.clientId === "string" && CLIENT_ID.test(b.clientId) &&
    (b.enterpriseId === undefined || isSlackEnterpriseId(b.enterpriseId));
}

/**
 * A session id the database can store: non-empty, bounded, and without NUL,
 * which a text column cannot hold and which would otherwise surface as a
 * database error that aborts the caller's transaction instead of a refusal.
 */
function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH && !value.includes("\u0000");
}

function isCreateInput(
  value: unknown,
): value is CreateSlackIdentityAttemptInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isUuid(v.organizationId) && isUuid(v.principalId) &&
    isSessionId(v.sessionId) && isBinding(v.binding) &&
    typeof v.secretsKey === "object" && v.secretsKey !== null &&
    typeof v.keyId === "string" && v.keyId.length > 0 &&
    v.keyId.length <= MAX_KEY_ID_LENGTH;
}

/**
 * Starts an attempt for a current member. An earlier pending attempt of the
 * same member for the same workspace is superseded, so a member has one live
 * state per workspace and a loop of requests leaves no pile of live ones, also
 * when the requests race: creates for one member and workspace take a
 * transaction-scoped lock, held until the caller's transaction ends, so the
 * caller should commit promptly.
 */
export async function createSlackIdentityAttempt(
  transaction: PgTransactionClient,
  input: CreateSlackIdentityAttemptInput,
): Promise<CreateSlackIdentityAttemptResult> {
  if (!isCreateInput(input)) return { ok: false, reason: "malformed" };
  const { organizationId, principalId, sessionId, binding, keyId } = input;

  const attemptId = crypto.randomUUID();
  const state = randomToken();
  const nonce = randomToken();
  const stateHash = await sha256Hex(state);
  let cipher;
  try {
    cipher = await encryptSlackIdentityNonce(
      input.secretsKey,
      { organizationId, attemptId, stateHash, keyId },
      nonce,
    );
  } catch {
    // A key or a key id the cipher cannot use: nothing was written.
    return { ok: false, reason: "malformed" };
  }

  const member = await transaction.query(
    `select 1 from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2 and status = 'active'`,
    [organizationId, principalId],
  );
  if (member.rows.length !== 1) return { ok: false, reason: "not_a_member" };

  // Two creates for one member and workspace must not both pass the supersede
  // below before either insert is visible: under READ COMMITTED each update
  // would find nothing and both attempts would stay pending. The second create
  // waits here for the first to commit, and its update, a new statement, then
  // sees the first attempt. A mutex only: it decides nothing about the data.
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `slack-identity-attempt:${organizationId}:${principalId}:${binding.appId}:${binding.teamId}`,
    ],
  );

  await transaction.query(
    `update bakery.slack_identity_attempts
        set status = 'failed', failure_code = 'superseded',
            updated_at = now(), version = version + 1
      where organization_id = $1 and initiating_principal_id = $2
        and app_id = $3 and team_id = $4 and status = 'pending'`,
    [organizationId, principalId, binding.appId, binding.teamId],
  );

  const inserted = await transaction.query<{ expiresAt: string }>(
    `insert into bakery.slack_identity_attempts (
       id, organization_id, initiating_principal_id, session_id, state_hash,
       nonce_ciphertext, nonce_iv, nonce_key_id, app_id, client_id, team_id,
       enterprise_id, expires_at, status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       now() + make_interval(mins => $13::int), 'pending')
     returning to_char(expires_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
    [
      attemptId,
      organizationId,
      principalId,
      sessionId,
      stateHash,
      cipher.ciphertext,
      cipher.nonce,
      keyId,
      binding.appId,
      binding.clientId,
      binding.teamId,
      binding.enterpriseId ?? null,
      SLACK_IDENTITY_ATTEMPT_TTL_MINUTES,
    ],
  );
  return {
    ok: true,
    attemptId,
    state,
    nonce,
    expiresAt: inserted.rows[0]!.expiresAt,
  };
}

type ClaimedRow = {
  id: string;
  organizationId: string;
  principalId: string;
  appId: string;
  clientId: string;
  teamId: string;
  enterpriseId: string | null;
  nonceCiphertext: Uint8Array;
  nonceIv: Uint8Array;
  nonceKeyId: string;
};

const REFUSED = { ok: false, reason: "refused" } as const;

async function endClaimed(
  transaction: PgTransactionClient,
  attemptId: string,
  status: "completed" | "failed",
  code: SlackAttemptFailureCode | null,
): Promise<boolean> {
  const ended = await transaction.query(
    `update bakery.slack_identity_attempts
        set status = $2, failure_code = $3, updated_at = now(),
            version = version + 1
      where id = $1 and status = 'exchanging'
      returning id`,
    [attemptId, status, code],
  );
  return ended.rows.length === 1;
}

/**
 * Claims an attempt for the callback that presents its state. One atomic
 * update; see the module comment. A nonce that cannot be read back with the key
 * given ends the attempt as failed and is refused like any other claim.
 */
export async function claimSlackIdentityAttempt(
  transaction: PgTransactionClient,
  input: ClaimSlackIdentityAttemptInput,
): Promise<ClaimSlackIdentityAttemptResult> {
  if (
    typeof input !== "object" || input === null ||
    typeof input.state !== "string" || input.state.length === 0 ||
    input.state.length > MAX_STATE_LENGTH ||
    !isSessionId(input.sessionId) || !isUuid(input.principalId)
  ) return REFUSED;

  const stateHash = await sha256Hex(input.state);
  const claimed = await transaction.query<ClaimedRow>(
    `update bakery.slack_identity_attempts
        set status = 'exchanging', consumed_at = now(), updated_at = now(),
            version = version + 1
      where state_hash = $1 and status = 'pending' and session_id = $2
        and initiating_principal_id = $3 and expires_at > now()
      returning id, organization_id as "organizationId",
        initiating_principal_id as "principalId", app_id as "appId",
        client_id as "clientId", team_id as "teamId",
        enterprise_id as "enterpriseId",
        nonce_ciphertext as "nonceCiphertext", nonce_iv as "nonceIv",
        nonce_key_id as "nonceKeyId"`,
    [stateHash, input.sessionId, input.principalId],
  );
  const row = claimed.rows[0];
  if (row === undefined) return REFUSED;

  let nonce: string | undefined;
  if (row.nonceKeyId === input.keyId) {
    try {
      const plain = await decryptSlackIdentityNonce(
        input.secretsKey,
        {
          organizationId: row.organizationId,
          attemptId: row.id,
          stateHash,
          keyId: row.nonceKeyId,
        },
        {
          ciphertext: new Uint8Array(row.nonceCiphertext),
          nonce: new Uint8Array(row.nonceIv),
        },
      );
      nonce = new TextDecoder().decode(plain);
      plain.fill(0);
    } catch {
      nonce = undefined;
    }
  }
  if (nonce === undefined || nonce.length === 0) {
    await endClaimed(transaction, row.id, "failed", "nonce_unreadable");
    return REFUSED;
  }
  return {
    ok: true,
    attempt: {
      attemptId: row.id,
      organizationId: row.organizationId,
      principalId: row.principalId,
      appId: row.appId,
      clientId: row.clientId,
      teamId: row.teamId,
      ...(row.enterpriseId === null ? {} : { enterpriseId: row.enterpriseId }),
      nonce,
    },
  };
}

/** Marks a claimed attempt completed, once. False when it was not claimed. */
export async function completeSlackIdentityAttempt(
  transaction: PgTransactionClient,
  input: { readonly attemptId: string },
): Promise<boolean> {
  if (typeof input !== "object" || input === null || !isUuid(input.attemptId)) {
    return false;
  }
  return await endClaimed(transaction, input.attemptId, "completed", null);
}

/** Marks a claimed attempt failed with one of the fixed codes. False otherwise. */
export async function failSlackIdentityAttempt(
  transaction: PgTransactionClient,
  input: { readonly attemptId: string; readonly code: SlackAttemptFailureCode },
): Promise<boolean> {
  if (
    typeof input !== "object" || input === null || !isUuid(input.attemptId) ||
    !(SLACK_ATTEMPT_FAILURE_CODES as readonly unknown[]).includes(input.code)
  ) return false;
  return await endClaimed(transaction, input.attemptId, "failed", input.code);
}
