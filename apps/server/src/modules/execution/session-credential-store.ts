/**
 * Storing, resolving and auditing session operation credentials.
 *
 * The credential module decides what a credential *means*; this one is the
 * record of what was granted and what was done with it. The split matters
 * because liveness is never decided here: a row in this table confers nothing
 * on its own, and every call re-checks the attempt through `assertActiveLease`.
 * If this table were trusted alone, a credential would keep working after its
 * lease moved, which is the failure the fence exists to prevent.
 *
 * Only the digest is stored. The token is handed back to the caller once, at
 * issue, and is unrecoverable afterwards — the same rule the worker host
 * credential follows.
 */

import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";
import { sha256Hex } from "../../platform/canonical-json.ts";
import {
  issueSessionOperationCredential,
  type OperationScope,
  type SessionOperationClaim,
  SessionOperationError,
} from "./session-credential.ts";

export type SessionCredentialRow = Readonly<{
  id: string;
  organizationId: string;
  attemptId: string;
  actsForPrincipalId: string;
  actsForPrincipalType: string;
  workerSessionId: string;
  workerSessionGeneration: bigint;
  fence: bigint;
  leaseTokenHash: string;
  scopes: readonly OperationScope[];
  expiresAt: Date;
  revokedAt: Date | null;
}>;

// Qualified, because the resolve query joins `bakery.principals` and both
// tables have an `id`.
const COLUMNS = `credential.id,
  credential.organization_id as "organizationId",
  credential.attempt_id as "attemptId",
  credential.acts_for_principal_id as "actsForPrincipalId",
  credential.worker_session_id as "workerSessionId",
  credential.worker_session_generation::text as "workerSessionGeneration",
  credential.fence::text as "fence",
  credential.lease_token_hash as "leaseTokenHash",
  credential.token_hash as "tokenHash",
  credential.scopes,
  credential.expires_at as "expiresAt",
  credential.revoked_at as "revokedAt"`;

type RawRow =
  & Omit<SessionCredentialRow, "workerSessionGeneration" | "fence">
  & {
    workerSessionGeneration: string;
    fence: string;
  };

function normalize(row: RawRow): SessionCredentialRow {
  return {
    ...row,
    workerSessionGeneration: BigInt(row.workerSessionGeneration),
    fence: BigInt(row.fence),
  };
}

/**
 * Issues a credential for an attempt and stores its digest.
 *
 * `leaseTokenHash` is stored beside it so liveness can be delegated to the same
 * check the worker routes use. A credential that could not name its lease could
 * not be compared against that lease at all, and would have to re-implement the
 * comparison — which is exactly how the status check went missing once.
 */
export async function issueStoredSessionCredential(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    attemptId: string;
    actsForPrincipalId: string;
    actsForPrincipalType: string;
    workerSessionId: string;
    workerSessionGeneration: bigint;
    fence: bigint;
    leaseTokenHash: string;
    scopes: readonly OperationScope[];
    leaseExpiresAt: Date;
    now?: Date;
  }>,
): Promise<{ id: string; token: string; claim: SessionOperationClaim }> {
  const issued = issueSessionOperationCredential(input);
  const tokenHash = await sha256Hex(issued.token);
  const result = await tx.query<{ id: string }>(
    `insert into bakery.session_operation_credentials
       (organization_id, attempt_id, acts_for_principal_id, worker_session_id,
        worker_session_generation, fence, lease_token_hash, token_hash, scopes,
        expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      input.organizationId,
      input.attemptId,
      input.actsForPrincipalId,
      input.workerSessionId,
      input.workerSessionGeneration,
      input.fence,
      input.leaseTokenHash,
      tokenHash,
      issued.claim.scopes,
      issued.claim.expiresAt,
    ],
  );
  return { id: result.rows[0].id, token: issued.token, claim: issued.claim };
}

/**
 * Resolves a presented token to a stored credential.
 *
 * A token that resolves to nothing is refused by the same code whether it is
 * forged, revoked or deleted, so the caller learns "not valid" and not which of
 * those three it was. That is deliberate: distinguishing them would let a
 * caller probe for the existence of another session's credential.
 */
export async function resolveSessionCredential(
  tx: PgTransactionClient,
  token: string,
  now: Date = new Date(),
): Promise<{ id: string; claim: SessionOperationClaim }> {
  const tokenHash = await sha256Hex(token);
  const result = await tx.query<
    RawRow & {
      tokenHash: string;
      actsForPrincipalType?: string;
      actsForPrincipalDisplayName?: string;
    }
  >(
    // The principal's type is joined rather than stored: the credential row
    // already names the person, `bakery.principals` already knows what kind of
    // principal it is, and a copied column would be a second truth that a
    // rename or a re-typed principal could silently desynchronise.
    `select ${COLUMNS},
            credential_principal.principal_type as "actsForPrincipalType",
            credential_principal.display_name as "actsForPrincipalDisplayName"
       from bakery.session_operation_credentials as credential
       join bakery.principals as credential_principal
         on credential_principal.id = credential.acts_for_principal_id
      where credential.token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row || row.revokedAt !== null) {
    throw new SessionOperationError("SESSION_CREDENTIAL_INVALID");
  }
  const stored = normalize(row);
  if (stored.expiresAt.getTime() <= now.getTime()) {
    throw new SessionOperationError("SESSION_CREDENTIAL_EXPIRED");
  }
  return {
    id: stored.id,
    claim: {
      organizationId: stored.organizationId,
      attemptId: stored.attemptId,
      actsForPrincipalId: stored.actsForPrincipalId,
      actsForPrincipalType: row.actsForPrincipalType ?? "worker",
      // Reloaded here so the dispatched action's authority guard has a typed
      // subject: it refuses a principal without a name, which is how a session
      // call could look authorised and be refused by its own guard instead.
      actsForPrincipalDisplayName: row.actsForPrincipalDisplayName ?? "",
      workerSessionId: stored.workerSessionId,
      workerSessionGeneration: stored.workerSessionGeneration,
      fence: stored.fence,
      leaseTokenHash: stored.leaseTokenHash,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
    },
  };
}

/**
 * Records that a call was made, with both identities.
 *
 * Written whatever the outcome, because a refused call is the interesting half
 * of an audit: "the agent tried to publish and was scope-denied" is evidence,
 * while a log of successes alone cannot show an attempt.
 */
export async function recordSessionOperationAudit(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    credentialId: string;
    attemptId: string;
    actsForPrincipalId: string;
    workerSessionId: string;
    operation: string;
    scope: string;
    outcome: "allowed" | "denied" | "unknown";
  }>,
): Promise<void> {
  await tx.query(
    `insert into bakery.session_operation_audits
       (organization_id, credential_id, attempt_id, acts_for_principal_id,
        worker_session_id, operation, scope, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.organizationId,
      input.credentialId,
      input.attemptId,
      input.actsForPrincipalId,
      input.workerSessionId,
      input.operation,
      input.scope,
      input.outcome,
    ],
  );
}

/**
 * Records a refusal that happened before any credential resolved.
 *
 * The audit's key is the credential, and the point of this path is that there is
 * no credential to key on. What is known is the organization the caller's host
 * belongs to, the attempt it asked about, and the hash of the token it
 * presented — enough to tell a stale client from a probe, and nothing invented
 * to fill the columns the audit needs.
 */
export async function recordSessionOperationRefusal(
  tx: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    attemptId: string;
    presentedTokenHash: string;
    operation: string;
    outcome: "denied" | "unknown";
  }>,
): Promise<void> {
  await tx.query(
    `insert into bakery.session_operation_refusals
       (organization_id, attempt_id, presented_token_hash, operation, outcome)
     values ($1, $2, $3, $4, $5)`,
    [
      input.organizationId,
      input.attemptId,
      input.presentedTokenHash,
      input.operation,
      input.outcome,
    ],
  );
}

/**
 * Revokes every credential an attempt still holds.
 *
 * Called when the attempt is fenced or finishes, so a token cannot outlive the
 * work even if the lease row is later reused. Revocation is a flag rather than a
 * delete: the row is what explains an audit that already points at it.
 */
export async function revokeAttemptCredentials(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; attemptId: string }>,
): Promise<number> {
  const result = await tx.query(
    `update bakery.session_operation_credentials
        set revoked_at = now()
      where organization_id = $1 and attempt_id = $2 and revoked_at is null`,
    [input.organizationId, input.attemptId],
  );
  if (result.rowCount === null) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return result.rowCount;
}

/**
 * The person and kind a claimed attempt's credential acted for, revoked or not.
 *
 * A replayed claim needs them to mint a fresh credential, and the only durable
 * record of who the run was for is the credential row the first claim wrote.
 * Revoked rows count, because the replay revokes the old one before it asks.
 */
export async function attemptCredentialPrincipal(
  tx: PgTransactionClient,
  input: Readonly<{ organizationId: string; attemptId: string }>,
): Promise<{ principalId: string; principalType: string } | null> {
  const result = await tx.query<{ principalId: string; principalType: string }>(
    `select credential.acts_for_principal_id as "principalId",
            credential_principal.principal_type as "principalType"
       from bakery.session_operation_credentials as credential
       join bakery.principals as credential_principal
         on credential_principal.id = credential.acts_for_principal_id
      where credential.organization_id = $1 and credential.attempt_id = $2
      order by credential.created_at desc
      limit 1`,
    [input.organizationId, input.attemptId],
  );
  return result.rows[0] ?? null;
}
