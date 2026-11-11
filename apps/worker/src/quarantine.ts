import type {
  JobAssignment,
  SpoolRecord,
  WorkerSessionGeneration,
} from "./types.ts";

/** Server-issued identity required before a restored attempt may publish. */
export type PublicationAuthority = {
  attemptId: string;
  leaseToken: string;
  workerSessionId: string;
  workerSessionGeneration: WorkerSessionGeneration;
  attemptFence: string;
  lifecycle: "active";
  leaseDeadline: number;
};

export type AuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: AuthorityRejection; cleanupRequired: true };

export type AuthorityRejection =
  | "ATTEMPT_MISMATCH"
  | "LEASE_TOKEN_MISMATCH"
  | "SESSION_MISMATCH"
  | "SESSION_GENERATION_MISMATCH"
  | "ATTEMPT_FENCE_MISMATCH"
  | "LEASE_EXPIRED";

const generation = (value: WorkerSessionGeneration): string => String(value);

/**
 * Validates all worker-local trust inputs. A valid local spool record is not
 * evidence of a live process or lease; only this server-derived tuple is.
 */
export function validatePublicationAuthority(
  input: Pick<SpoolRecord, "attemptId" | "leaseToken" | "fence"> & {
    workerSessionId?: string;
    workerSessionGeneration?: WorkerSessionGeneration;
  },
  authority: PublicationAuthority,
  now = performance.now(),
): AuthorityDecision {
  if (input.attemptId !== authority.attemptId) {
    return reject("ATTEMPT_MISMATCH");
  }
  if (input.leaseToken !== authority.leaseToken) {
    return reject("LEASE_TOKEN_MISMATCH");
  }
  if (input.workerSessionId !== authority.workerSessionId) {
    return reject("SESSION_MISMATCH");
  }
  if (
    input.workerSessionGeneration === undefined ||
    generation(input.workerSessionGeneration) !==
      generation(authority.workerSessionGeneration)
  ) {
    return reject("SESSION_GENERATION_MISMATCH");
  }
  if (input.fence !== authority.attemptFence) {
    return reject("ATTEMPT_FENCE_MISMATCH");
  }
  if (now >= authority.leaseDeadline) return reject("LEASE_EXPIRED");
  return { allowed: true };
}

function reject(reason: AuthorityRejection): AuthorityDecision {
  return { allowed: false, reason, cleanupRequired: true };
}

export function assignmentAuthority(
  assignment: JobAssignment,
  extra: Pick<PublicationAuthority, "lifecycle" | "leaseDeadline">,
): PublicationAuthority {
  if (
    !assignment.workerSessionId ||
    assignment.workerSessionGeneration === undefined
  ) {
    throw new Error("ASSIGNMENT_SESSION_REQUIRED");
  }
  return {
    attemptId: assignment.attemptId,
    leaseToken: assignment.leaseToken,
    workerSessionId: assignment.workerSessionId,
    workerSessionGeneration: assignment.workerSessionGeneration,
    attemptFence: assignment.fence,
    ...extra,
  };
}
