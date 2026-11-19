/**
 * Issuing the session operation credential at claim time (#401, chapter 25 §18.1).
 *
 * The credential, its tables, its resolution, its audit and the gateway that
 * lists tools for it were all already merged; nothing minted one. This module is
 * the missing link, and it exists as its own unit so the decision "who does this
 * agent act for, and what may it call" is stated once and tested without a
 * database.
 *
 * The token is returned once, in the claim response, and only its digest is
 * stored - the same rule the worker host credential follows.
 */

import {
  issueSessionOperationCredential,
  type SessionOperationClaim,
  SessionOperationError,
} from "./session-credential.ts";
import {
  issueStoredSessionCredential,
  revokeAttemptCredentials,
} from "./session-credential-store.ts";
import { sessionOperationScopeValues } from "./session-tools.ts";
import type { PgTransactionClient } from "@bakery/persistence";
import type { OperationScope } from "./session-credential.ts";

export type SessionClaimCredentialInput = Readonly<{
  organizationId: string;
  attemptId: string;
  actsForPrincipalId: string | null;
  /**
   * The kind of principal the run was requested by, from `bakery.principals`.
   *
   * Optional on this input only so a caller that has no principal row in hand
   * is not forced to invent one; the claim path always supplies it, and the
   * fallback is the narrowest type rather than the widest.
   */
  actsForPrincipalType?: string | null;
  workerSessionId: string;
  workerSessionGeneration: bigint;
  fence: bigint;
  leaseTokenHash: string;
  leaseExpiresAt: Date;
  scopes?: readonly OperationScope[];
  now?: Date;
}>;

export type MintedSessionCredential = Readonly<{
  id: string;
  token: string;
  /** The full claim, because this is what the audit and the stored row carry. */
  claim: SessionOperationClaim;
}>;

/**
 * The read scopes every session gets, and nothing else.
 *
 * AC3 asks for read operations first. A write scope is offered only where a
 * definition granted it, and no definition stores grants yet, so minting one
 * here would hand every session an authority nobody granted - which is the
 * failure mode a scope is supposed to prevent. Reads are taken from the same
 * operation map the gateway lists from, so a read operation added later is
 * reachable without a second list to remember.
 */
export function readScopesForSession(): readonly OperationScope[] {
  const read = sessionOperationScopeValues().filter((scope) =>
    scope.endsWith(".read")
  );
  return [...new Set(read)].sort();
}

/**
 * Mints the credential for one claim, in the caller's transaction.
 *
 * Refuses rather than minting a credential with no principal: O50 requires the
 * audit to name the person the agent acted for, and an unattributable audit row
 * is worse than a failed claim, because it looks like evidence.
 */
export function sessionCredentialForClaim(
  input: SessionClaimCredentialInput,
): MintedSessionCredential {
  const actsForPrincipalId = input.actsForPrincipalId;
  if (actsForPrincipalId === null) {
    throw new SessionOperationError("SESSION_CREDENTIAL_NO_PRINCIPAL");
  }
  const issued = issueSessionOperationCredentialForClaim({
    ...input,
    actsForPrincipalId,
    // A principal row always has a type (the column is not null), so the join
    // failing while the id resolved means the person was deleted mid-claim.
    // Treating that as a human would grant an authority the row cannot back.
    actsForPrincipalType: input.actsForPrincipalType ?? "worker",
    scopes: input.scopes ?? readScopesForSession(),
  });
  return issued;
}

/**
 * The synchronous half, so the unit test can assert the decision without a
 * database. It delegates to the one function that mints tokens, because a
 * second token format would be a second thing to get wrong.
 */
function issueSessionOperationCredentialForClaim(
  input: SessionClaimCredentialInput & {
    actsForPrincipalId: string;
    actsForPrincipalType: string;
    scopes: readonly OperationScope[];
  },
): MintedSessionCredential {
  const issued = issueSessionOperationCredential({
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    actsForPrincipalId: input.actsForPrincipalId,
    actsForPrincipalType: input.actsForPrincipalType,
    workerSessionId: input.workerSessionId,
    workerSessionGeneration: input.workerSessionGeneration,
    fence: input.fence,
    leaseTokenHash: input.leaseTokenHash,
    scopes: input.scopes,
    leaseExpiresAt: input.leaseExpiresAt,
    now: input.now,
  });
  return { id: "pending", token: issued.token, claim: issued.claim };
}

/**
 * Stores the credential for an attempt, revoking any the attempt already held.
 *
 * Called inside the claim transaction, so the attempt and its credential appear
 * together or not at all. Revoking first is what keeps "one live credential per
 * attempt" true when a lease lapses and the same attempt is claimed again: the
 * old token must stop working at that moment, not when it happens to expire.
 */
export async function issueCredentialForAttempt(
  tx: PgTransactionClient,
  input: SessionClaimCredentialInput,
): Promise<MintedSessionCredential> {
  const refusedPrincipal = input.actsForPrincipalId;
  if (refusedPrincipal === null) {
    throw new SessionOperationError("SESSION_CREDENTIAL_NO_PRINCIPAL");
  }
  await revokeAttemptCredentials(tx, {
    organizationId: input.organizationId,
    attemptId: input.attemptId,
  });
  return await issueStoredSessionCredential(tx, {
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    actsForPrincipalId: refusedPrincipal,
    actsForPrincipalType: input.actsForPrincipalType ?? "worker",
    workerSessionId: input.workerSessionId,
    workerSessionGeneration: input.workerSessionGeneration,
    fence: input.fence,
    leaseTokenHash: input.leaseTokenHash,
    scopes: input.scopes ?? readScopesForSession(),
    leaseExpiresAt: input.leaseExpiresAt,
    now: input.now,
  });
}
