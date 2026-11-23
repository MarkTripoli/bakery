/**
 * The credential an agent inside a session uses to call Bakery's own operations.
 *
 * It is not a person's token and it is not the worker's credential. A worker
 * credential authenticates the enrolled host and its protocol operations, and
 * an outside MCP client acts as a person; neither can express "the agent in
 * attempt X, acting for principal P, while the lease it was given still holds".
 * This is that thing, and it is deliberately narrow (chapter 25 §18.1):
 *
 * - bound to the **attempt's lease and fence**, so it dies when the lease does;
 * - bound to the **principal the agent acts for** (O50), so an audit can say
 *   whose action this was rather than only that a machine did it;
 * - bound to the **definition's scopes**, so a session cannot do more than the
 *   definition it is running was granted.
 *
 * Nothing here decides *whether* an operation is allowed. This module only
 * establishes who is calling and under what authority; the operation registry
 * checks the call as it would a person's, and budgets, counts and depth are
 * checked by the engine before it acts.
 */

import { StandardError } from "@bakery/contracts/http";
import { assertActiveLease } from "./events.ts";
import type { AttemptRow, WorkerIdentity } from "./shared.ts";

/** A scope a session credential may carry, as a stable string. */
export type OperationScope = string;

export type SessionOperationClaim = Readonly<{
  organizationId: string;
  /** The attempt this credential belongs to. */
  attemptId: string;
  /** The principal the agent acts for; the audit's subject (O50). */
  actsForPrincipalId: string;
  /**
   * The kind of principal that id names.
   *
   * A session call runs the action's own authority guard as this person, and
   * that guard needs a typed subject: a bare id cannot tell it whether it is
   * looking at a human or a service.
   */
  actsForPrincipalType: string;
  /**
   * The acting person's display name, joined at resolve time.
   *
   * Dispatched actions run their own authority guard as this person, and that
   * guard refuses a subject it cannot name. Carrying it means a session call is
   * judged by the same rule as a person's own request instead of failing inside
   * the guard for a reason that has nothing to do with authority.
   *
   * Optional on the issuer and filled at resolve time: the credential row stores
   * no name, so minting cannot know it and must not invent one.
   */
  actsForPrincipalDisplayName?: string;
  /** The worker session and generation that claimed the attempt. */
  workerSessionId: string;
  workerSessionGeneration: bigint;
  /** The lease fence the attempt held when the credential was issued. */
  fence: bigint;
  /**
   * Hash of the lease token this credential was minted alongside.
   *
   * Carried so liveness can delegate to `assertActiveLease`, which compares it
   * against the attempt's stored hash. A credential that could not name the
   * lease it belongs to could not be checked against that lease at all.
   */
  leaseTokenHash: string;
  /** Scopes the definition's grant gave this session. */
  scopes: readonly OperationScope[];
  /** Absolute expiry; the credential may not outlive the lease. */
  expiresAt: Date;
}>;

export type SessionOperationCredential = Readonly<{
  /** Opaque bearer value handed to the session; only its hash is stored. */
  token: string;
  claim: SessionOperationClaim;
}>;

const TOKEN_BYTES = 32;

/**
 * Raised when a credential cannot be honoured. The distinct codes exist so a
 * caller can tell "this token is not one of ours" from "this token was valid
 * and the lease beneath it ended", which are different facts about the world.
 */
export class SessionOperationError extends Error {
  constructor(
    readonly code:
      | "SESSION_CREDENTIAL_INVALID"
      | "SESSION_CREDENTIAL_EXPIRED"
      | "SESSION_CREDENTIAL_FENCE_STALE"
      | "SESSION_SCOPE_DENIED"
      /**
       * A claim that cannot name the person it acts for gets no credential.
       * O50 requires the audit to name that principal, and an unattributable
       * audit row is worse than a failed claim because it looks like evidence.
       */
      | "SESSION_CREDENTIAL_NO_PRINCIPAL",
    /**
     * The cause, when the refusal came from a check with its own reason.
     *
     * Kept so a log names what actually failed a host row while the caller still
     * sees one code for every unusable credential.
     */
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SessionOperationError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Issues a credential for an attempt.
 *
 * `expiresAt` is clamped to the lease's own deadline rather than trusted: a
 * credential that could outlive its lease would be a way to keep acting after
 * the work was reassigned, which is the exact failure the fence exists to
 * prevent. A caller passing a later expiry gets the lease's, not theirs.
 */
export function issueSessionOperationCredential(input: {
  organizationId: string;
  attemptId: string;
  actsForPrincipalId: string;
  /**
   * Optional on the issuer only, so a caller that holds no principal row is not
   * forced to invent a type; the claim path always supplies the real one. The
   * fallback is the narrowest type, never the widest.
   */
  actsForPrincipalType?: string;
  workerSessionId: string;
  workerSessionGeneration: bigint;
  fence: bigint;
  leaseTokenHash: string;
  scopes: readonly OperationScope[];
  leaseExpiresAt: Date;
  now?: Date;
}): SessionOperationCredential {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    Math.min(
      input.leaseExpiresAt.getTime(),
      now.getTime() +
        24 * 60 * 60 * 1000,
    ),
  );
  if (expiresAt.getTime() <= now.getTime()) {
    // Issuing a credential that is already dead is a caller bug, not a runtime
    // condition a session should have to discover on its first call.
    throw new SessionOperationError("SESSION_CREDENTIAL_EXPIRED");
  }
  const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  return {
    token,
    claim: {
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      actsForPrincipalId: input.actsForPrincipalId,
      actsForPrincipalType: input.actsForPrincipalType ?? "worker",
      workerSessionId: input.workerSessionId,
      workerSessionGeneration: input.workerSessionGeneration,
      fence: input.fence,
      leaseTokenHash: input.leaseTokenHash,
      // Deduplicated and ordered so a claim compares stably and an audit line
      // does not depend on the order a definition happened to list them.
      scopes: [...new Set(input.scopes)].sort(),
      expiresAt,
    },
  };
}

/**
 * Re-checks a claim against the attempt as it is *now*.
 *
 * This is the half that makes the credential die with the lease. A token that
 * was valid when issued is not evidence that it is valid now: the lease may
 * have expired, another worker may hold a higher fence, or the session may have
 * been recycled with a new generation. Each of those refuses with its own code.
 */
export function assertSessionOperationLive(
  claim: SessionOperationClaim,
  attempt: AttemptRow,
  identity: WorkerIdentity,
  now: Date = new Date(),
): void {
  // Delegated, not re-derived. The first version of this compared the fence
  // columns itself and quietly skipped the attempt's status, so a completed
  // attempt with an unexpired lease passed. Adopting `assertActiveLease` means
  // the session surface cannot drift from the worker routes that fence the same
  // rows: one comparison, one set of refusal codes, one place to fix.
  try {
    assertActiveLease(
      attempt,
      identity,
      claim.leaseTokenHash,
      claim.fence
        .toString(),
    );
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    throw new SessionOperationError(
      error.code === "LEASE_EXPIRED"
        ? "SESSION_CREDENTIAL_EXPIRED"
        : "SESSION_CREDENTIAL_FENCE_STALE",
    );
  }
  // The attempt and organization the claim names must be the ones we locked:
  // `assertActiveLease` proves the *lease* is live, not that it is this
  // session's credential being presented against this attempt.
  if (
    attempt.id !== claim.attemptId ||
    attempt.organization_id !== claim.organizationId
  ) {
    throw new SessionOperationError("SESSION_CREDENTIAL_FENCE_STALE");
  }
  // The credential's own deadline is stricter than the lease's, never looser.
  if (claim.expiresAt.getTime() <= now.getTime()) {
    throw new SessionOperationError("SESSION_CREDENTIAL_EXPIRED");
  }
}

/**
 * Refuses a scope the session does not hold.
 *
 * Scopes are exact names, never a wildcard match: `workflows.publish` does not
 * grant `workflows.publishAny`, and nothing grants `*`. Chapter 25 §15.4 makes
 * the same point about tool grants, for the same reason — a wildcard is a
 * promise the issuer cannot keep once a new operation is added.
 */
export function assertOperationScope(
  claim: SessionOperationClaim,
  required: OperationScope | readonly OperationScope[],
): void {
  const wanted = typeof required === "string" ? [required] : required;
  for (const scope of wanted) {
    if (scope === "*" || scope.endsWith(".*")) {
      throw new SessionOperationError("SESSION_SCOPE_DENIED");
    }
    if (!claim.scopes.includes(scope)) {
      throw new SessionOperationError("SESSION_SCOPE_DENIED");
    }
  }
}
