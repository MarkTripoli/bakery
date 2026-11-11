import type { SkillCacheReconciliation } from "./skill-cache.ts";
import type { RegistrationState, SkillMaterializationOwner } from "./types.ts";
import {
  type ActiveAssignment,
  requiredAssignmentTiming,
} from "./supervisor-support.ts";
import type { RegistrationStore } from "./registration-store.ts";
import type { EventSpool } from "./spool.ts";
import type { PublicationAuthority } from "./quarantine.ts";
import {
  assignmentAuthority,
  validatePublicationAuthority,
} from "./quarantine.ts";

export function reconcileSkillMaterializationOwner(options: {
  owner: SkillMaterializationOwner;
  registration: RegistrationState | null;
  terminationEvidence: ReadonlyMap<string, unknown>;
  processSessionAcquired: boolean;
  healthy: boolean;
}): SkillCacheReconciliation {
  const { owner, registration } = options;
  if (
    !options.processSessionAcquired || !options.healthy ||
    !registration?.workerHostId ||
    registration.workerSessionId === undefined ||
    registration.workerSessionGeneration === undefined
  ) return "unknown";
  if (registration.workerHostId !== owner.workerHostId) return "unknown";
  if (options.terminationEvidence.has(owner.attemptId)) return "unknown";

  const persisted = registration.activeAssignments?.[owner.attemptId];
  if (!persisted) return "stale";
  const assignment = persisted.assignment;
  if (
    assignment.attemptId !== owner.attemptId ||
    assignment.jobId !== owner.jobId ||
    assignment.workerHostId !== owner.workerHostId
  ) return "unknown";
  const exactOwner = String(assignment.fence) === owner.fence &&
    assignment.workerSessionId === owner.workerSessionId &&
    assignment.workerSessionGeneration === owner.workerSessionGeneration;
  if (exactOwner) return "active";

  // A started attempt without durable clean quiescence may still own a live
  // native process. Session replacement alone cannot authorize deleting its
  // private roots; the existing termination-evidence lifecycle must settle it.
  if (
    BigInt(persisted.nextLocalSeq) > 2n &&
    persisted.cleanQuiescence !== true
  ) return "unknown";
  return "stale";
}

export function publicationAuthorityForAssignment(
  assignment: ActiveAssignment["assignment"],
  workerSessionId: string,
  workerSessionGeneration: string,
  leaseDeadline: number,
): PublicationAuthority | null {
  if (!Number.isFinite(leaseDeadline)) return null;
  try {
    return assignmentAuthority(
      {
        ...assignment,
        workerSessionId,
        workerSessionGeneration,
      },
      { lifecycle: "active", leaseDeadline },
    );
  } catch {
    return null;
  }
}

export type RecoveryContext = {
  registration: RegistrationState;
  registrationStore: RegistrationStore;
  spool: EventSpool;
  active: Map<string, ActiveAssignment>;
  authorityFor: (
    attemptId: string,
    assignment: ActiveAssignment["assignment"],
  ) => PublicationAuthority | null;
  leaseDeadlineFor: (
    attemptId: string,
    assignment: ActiveAssignment["assignment"],
  ) => number;
};
export async function restoreActiveAssignments(
  context: RecoveryContext,
): Promise<void> {
  const entries = Object.entries(context.registration?.activeAssignments ?? {});
  for (const [attemptId, entry] of entries) {
    if (context.active.has(attemptId)) continue;
    const renewalKey = entry.renewalKey ??
      context.registration?.pendingRenewalKeys?.[attemptId];
    const authority = context.authorityFor(attemptId, entry.assignment);
    if (!authority) continue;
    if (!renewalKey) {
      const decision = validatePublicationAuthority({
        attemptId,
        leaseToken: entry.assignment.leaseToken,
        fence: entry.assignment.fence,
        workerSessionId: authority.workerSessionId,
        workerSessionGeneration: authority.workerSessionGeneration,
      }, authority);
      if (!decision.allowed) continue;
    }
    await context.spool.restoreJournalState(
      attemptId,
      entry.nextLocalSeq,
      entry.ackedLocalSeq,
    );
    const timing = requiredAssignmentTiming(entry.assignment);
    context.active.set(attemptId, {
      assignment: {
        ...structuredClone(entry.assignment),
        workerSessionId: authority.workerSessionId,
        workerSessionGeneration: String(authority.workerSessionGeneration),
      },
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: Math.max(1, timing.leaseDurationSeconds),
      leaseDeadline: context.leaseDeadlineFor(attemptId, entry.assignment),
      renewalKey,
      renewalLoopStarted: false,
      terminalAcked: entry.terminalAcked === true,
      executionStarted: false,
      restored: true,
    });
  }
}

export async function recoverReleaseMarkers(
  context: RecoveryContext,
): Promise<RegistrationState> {
  let registration = context.registration;
  const markers = Object.entries(registration?.releaseMarkers ?? {});
  for (const [attemptId, marker] of markers) {
    if (
      marker.reason === "HEARTBEAT_NOT_RECONCILED" &&
      context.spool.hasReplaySafeRecord(attemptId)
    ) {
      continue;
    }
    if (context.spool.attemptIds().includes(attemptId)) {
      await context.spool.discardAttempt(attemptId);
    }
    registration = await context.registrationStore.completeRelease(attemptId);
  }
  return registration;
}
export type ServerTruthReconciliation = {
  discardedAttemptIds: string[];
};

/**
 * A restart may only continue attempts explicitly returned by the server's
 * accepted heartbeat. Local registration and spool state is quarantine data.
 */
export function reconcileServerTruth(
  restoredAttemptIds: Iterable<string>,
  spoolAttemptIds: Iterable<string>,
  reconciledAttemptIds: Iterable<string>,
): ServerTruthReconciliation {
  const restored = new Set(restoredAttemptIds);
  const spool = new Set(spoolAttemptIds);
  const server = new Set(reconciledAttemptIds);
  const discardedAttemptIds = [...new Set([...restored, ...spool])].filter(
    (attemptId) => !server.has(attemptId),
  );
  return { discardedAttemptIds };
}
