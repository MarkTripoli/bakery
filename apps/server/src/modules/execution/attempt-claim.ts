/**
 * The one way a worker route claims an attempt for the rest of a transaction.
 *
 * Three routes had grown the same four lines — lock the attempt rows, check the
 * calling session, hash the lease token, assert the lease — and a fourth was
 * about to make it four. Copying that chain is how the routes drift apart: one
 * of them eventually re-asserts the lease after doing slow work and the others
 * do not, and the difference is invisible until a lease expires mid-request.
 *
 * The two halves are kept separate on purpose. `claimAttempt` runs at the top of
 * a route; `reassertAttempt` runs after any step that could take long enough for
 * the lease to lapse. A route that only ever does the first has an expiry window
 * between the check and the answer, which is exactly the bug #504 fixed in the
 * input read — so this module makes the second call the obvious one to reach for
 * rather than something each route remembers by itself.
 */

import type { PgTransactionClient } from "@bakery/persistence";
import {
  assertActiveLease,
  type AttemptLockMode,
  lockAttempt as lockPersistedAttempt,
} from "./events.ts";
import { assertAttemptMutationSession, type WorkerIdentity } from "./shared.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";

export type ClaimedAttempt = Readonly<{
  transaction: PgTransactionClient;
  identity: WorkerIdentity;
  attemptId: string;
  /** The job this attempt is running, read under the lock. */
  jobId: string;
  /** The lock the claim took, so the re-assert takes the same one. */
  lock: AttemptLockMode;
  /** Hash of the lease token, so a re-assert does not re-read the header. */
  tokenHash: string;
  /**
   * The attempt row as locked at claim time.
   *
   * Returned so a caller that needs the row for a further check does not query
   * `job_attempts` itself: a second read is a second place the fence could be
   * compared, and the whole point of this module is that there is one.
   */
  attempt: Awaited<ReturnType<typeof lockPersistedAttempt>>;
  fence: string;
  workerSessionId: string | undefined;
  workerSessionGeneration: string | undefined;
}>;

/**
 * Locks the attempt and refuses a caller that is not the live lease holder.
 *
 * The attempt rows are locked `for update of attempt, job`, so no other
 * connection can move the fence while this transaction runs. That is what makes
 * the re-assert meaningful: time can still pass, but the fence cannot move
 * underneath us.
 */
export async function claimAttempt(input: {
  transaction: PgTransactionClient;
  identity: WorkerIdentity;
  attemptId: string;
  proof: Readonly<{
    /** The lease token as presented. Omitted when the caller already holds its hash. */
    leaseToken?: string;
    /**
     * The lease token's hash, when the caller did not receive the token itself.
     *
     * A session credential is minted alongside the lease and carries only the
     * hash, so a gateway holding a credential cannot present the token. Taking
     * the hash here keeps that caller on this one chain instead of letting it
     * re-derive the lock-and-assert sequence, which is how the status check went
     * missing once already.
     */
    tokenHash?: string;
    fence: string;
    workerSessionId?: string;
    workerSessionGeneration?: string;
  }>;
  /**
   * `no key update` for a caller that runs work on another connection while
   * this transaction holds the lock (the session gateway); see
   * AttemptLockMode. Defaults to `update`.
   */
  lock?: AttemptLockMode;
}): Promise<ClaimedAttempt> {
  const lock = input.lock ?? "update";
  const tokenHash = input.proof.tokenHash ??
    await sha256Hex(input.proof.leaseToken ?? "");
  const attempt = await lockPersistedAttempt(
    input.transaction,
    input.identity,
    input.attemptId,
    lock,
  );
  assertAttemptMutationSession(
    input.identity.host,
    attempt,
    input.proof.workerSessionId,
    input.proof.workerSessionGeneration,
  );
  assertActiveLease(attempt, input.identity, tokenHash, input.proof.fence);
  return {
    transaction: input.transaction,
    identity: input.identity,
    attemptId: input.attemptId,
    jobId: attempt.job_id,
    lock,
    tokenHash,
    attempt,
    fence: input.proof.fence,
    workerSessionId: input.proof.workerSessionId,
    workerSessionGeneration: input.proof.workerSessionGeneration,
  };
}

/**
 * Re-checks the lease after work that could outlast it.
 *
 * Rolls back rather than issuing authority late: if the lease lapsed while the
 * route was gathering or validating, the caller must see nothing, because a
 * partial answer to a worker that no longer holds the attempt is a correctness
 * bug the fences exist to prevent. It also re-asserts against the *current* row
 * rather than the one locked at claim time, which is what catches a lease whose
 * `lease_expires_at` has passed while the transaction sat open.
 */
export async function reassertAttempt(claimed: ClaimedAttempt): Promise<void> {
  const attempt = await lockPersistedAttempt(
    claimed.transaction,
    claimed.identity,
    claimed.attemptId,
    claimed.lock,
  );
  assertAttemptMutationSession(
    claimed.identity.host,
    attempt,
    claimed.workerSessionId,
    claimed.workerSessionGeneration,
  );
  assertActiveLease(
    attempt,
    claimed.identity,
    claimed.tokenHash,
    claimed.fence,
  );
}
