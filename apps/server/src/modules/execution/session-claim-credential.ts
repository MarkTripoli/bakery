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
import {
  POWER_SESSION_SCOPES,
  sessionOperationScopeValues,
} from "./session-tools.ts";
import {
  attemptOrigin,
  isAgentPower,
} from "../auth/application/agent-power-grants.ts";
import type { PgTransactionClient } from "@bakery/persistence";
import type { OperationScope } from "./session-credential.ts";
import {
  FILES_READ_SCOPE,
  FILES_WRITE_SCOPE,
  stepFileScopes,
} from "../knowledge/agent-file-scope.ts";
import { type ResolvedStepFiles, stepFilesForAttempt } from "./step-files.ts";
import { readsOnlyInputs } from "@bakery/contracts/workflow-compiler";

/**
 * The granted scopes a step keeps. An inputs-only step (O53) reads only its pinned
 * inputs and writes only its declared outputs, so a person's file grant never
 * reopens storage for it; every other step keeps all it was granted.
 */
export function grantedScopesForStep(
  files: ResolvedStepFiles,
  granted: readonly OperationScope[],
): readonly OperationScope[] {
  return readsOnlyInputs({ read: [...files.read], write: [...files.write] })
    ? granted.filter((scope) => !isFileScope(scope))
    : granted;
}

/** A storage scope: `files.read`, `files.write` or one of their area scopes. */
function isFileScope(scope: OperationScope): boolean {
  return scope === FILES_READ_SCOPE || scope === FILES_WRITE_SCOPE ||
    scope.startsWith(`${FILES_READ_SCOPE}:`) ||
    scope.startsWith(`${FILES_WRITE_SCOPE}:`);
}

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
  // files.read is the one read a definition decides: an inputs-only step must not
  // get the storage read tools, so it is minted from the step's files section.
  const read = sessionOperationScopeValues().filter((scope) =>
    scope.endsWith(".read") && scope !== FILES_READ_SCOPE
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
  // Reads for everyone, plus the write scope of each power a person granted the
  // workflow this attempt runs under (O52). Off by default: no grant, no scope.
  const files = input.scopes
    ? null
    : await stepFilesForAttempt(tx, input.organizationId, input.attemptId);
  const granted = files
    ? await grantedScopesForAttempt(tx, input.organizationId, input.attemptId)
    : [];
  const scopes = input.scopes ??
    [
      ...readScopesForSession(),
      // An inputs-only step (O53) reads only its pinned inputs and writes only its
      // declared outputs: a person's file grant never reopens storage for it.
      ...(files ? grantedScopesForStep(files, granted) : granted),
      // The step's files section, pinned into the credential so each storage
      // call is judged against the section the session was claimed under. A
      // step with no section never gets the storage write tools (#448).
      ...(files ? stepFileScopes(files) : []),
    ];
  return await issueStoredSessionCredential(tx, {
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    actsForPrincipalId: refusedPrincipal,
    actsForPrincipalType: input.actsForPrincipalType ?? "worker",
    workerSessionId: input.workerSessionId,
    workerSessionGeneration: input.workerSessionGeneration,
    fence: input.fence,
    leaseTokenHash: input.leaseTokenHash,
    scopes,
    leaseExpiresAt: input.leaseExpiresAt,
    now: input.now,
  });
}

/**
 * The session scopes the powers granted to this attempt's workflow add.
 *
 * Reads the grants for the workflow only (a session has no seat), so a grant
 * tied to a seat does not widen a worker session. An attempt with no workflow
 * holds no power and gets no scope.
 */
export async function grantedScopesForAttempt(
  tx: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<readonly OperationScope[]> {
  const origin = await attemptOrigin(tx, organizationId, attemptId);
  if (origin === null) return [];
  const granted = await tx.query<{ power: string }>(
    `select distinct power from bakery.agent_power_grants
      where organization_id = $1 and workflow_id = $2
        and access_token_id is null
        and (expires_at is null or expires_at > now())`,
    [organizationId, origin.workflowId],
  );
  const scopes = new Set<OperationScope>();
  for (const { power } of granted.rows) {
    if (!isAgentPower(power)) continue;
    for (const scope of POWER_SESSION_SCOPES[power]) scopes.add(scope);
  }
  // Bakery Files (#448): the write tools are offered only where a person
  // granted this workflow a folder to write, and the grant was live at claim.
  // Live at claim is not enough to write: the guard judges the grant again at
  // the time of every write.
  const fileGrants = await tx.query(
    `select 1 from bakery.agent_file_grants
      where organization_id = $1 and workflow_id = $2 and access = 'write'
        and revoked_at is null and expires_at > now()
      limit 1`,
    [organizationId, origin.workflowId],
  );
  if (fileGrants.rows.length > 0) scopes.add(FILES_WRITE_SCOPE);
  // A live grant of either access widens where the agent may read, so it
  // offers the read tools too; the guard checks the grant on every read.
  const readGrants = await tx.query(
    `select 1 from bakery.agent_file_grants
      where organization_id = $1 and workflow_id = $2
        and revoked_at is null and expires_at > now()
      limit 1`,
    [organizationId, origin.workflowId],
  );
  if (readGrants.rows.length > 0) scopes.add(FILES_READ_SCOPE);
  return [...scopes].sort();
}
