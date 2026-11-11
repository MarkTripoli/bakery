import type {
  PersistedActiveAssignment,
  PersistedPendingClaim,
  PersistedPendingHeartbeat,
  PersistedTerminationEvidence,
  RegistrationState,
  WorkerCommandOutcomeStatus,
  WorkerRegistrationResult,
  WorkerSessionGeneration,
} from "./types.ts";
import {
  acquireStateLock,
  readJsonIfExists,
  writeJsonAtomically,
} from "./storage.ts";
import type { StateLock, StateLockFactory } from "./storage.ts";
import {
  isNonEmptyText,
  validateActiveAssignment,
  validatePendingClaim,
  validatePendingHeartbeat,
  validateState,
} from "./registration-validation.ts";
import {
  MAX_TERMINATION_EVIDENCE,
  mergeTerminationEvidence,
  TerminationEvidenceCapacityError,
} from "./control-state.ts";

export function generateWorkerCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
function writeActiveAssignment(
  state: RegistrationState,
  entry: PersistedActiveAssignment,
  options: { clearPendingClaim?: boolean; clearMissingRenewalKey?: boolean } =
    {},
): RegistrationState {
  const activeAssignments = { ...(state.activeAssignments ?? {}) };
  if (
    !(entry.assignment.attemptId in activeAssignments) &&
    Object.keys(activeAssignments).length >= 100
  ) throw new Error("WORKER_ACTIVE_ASSIGNMENT_CAPACITY_EXCEEDED");
  activeAssignments[entry.assignment.attemptId] = structuredClone(entry);
  const pendingRenewalKeys = { ...(state.pendingRenewalKeys ?? {}) };
  if (entry.renewalKey) {
    pendingRenewalKeys[entry.assignment.attemptId] = entry.renewalKey;
  } else if (options.clearMissingRenewalKey) {
    delete pendingRenewalKeys[entry.assignment.attemptId];
  }
  const next = { ...state, activeAssignments };
  if (Object.keys(pendingRenewalKeys).length) {
    next.pendingRenewalKeys = pendingRenewalKeys;
  } else {
    delete next.pendingRenewalKeys;
  }
  if (options.clearPendingClaim) {
    delete next.pendingClaimKey;
    delete next.pendingClaim;
  }
  return next;
}

function removeAttemptState(
  state: RegistrationState,
  attemptId: string,
  includeReleaseMarker: boolean,
): RegistrationState {
  const activeAssignments = { ...(state.activeAssignments ?? {}) };
  const pendingRenewalKeys = { ...(state.pendingRenewalKeys ?? {}) };
  const releaseMarkers = { ...(state.releaseMarkers ?? {}) };
  delete activeAssignments[attemptId];
  delete pendingRenewalKeys[attemptId];
  if (includeReleaseMarker) delete releaseMarkers[attemptId];
  const next = { ...state };
  if (Object.keys(activeAssignments).length) {
    next.activeAssignments = activeAssignments;
  } else delete next.activeAssignments;
  if (Object.keys(pendingRenewalKeys).length) {
    next.pendingRenewalKeys = pendingRenewalKeys;
  } else delete next.pendingRenewalKeys;
  if (includeReleaseMarker) {
    if (Object.keys(releaseMarkers).length) {
      next.releaseMarkers = releaseMarkers;
    } else delete next.releaseMarkers;
  }
  return next;
}

export class RegistrationStore {
  readonly path: string;
  private readonly acquireLock: StateLockFactory;
  private mutationTail = Promise.resolve();

  constructor(
    path: string,
    options: { acquireStateLock?: StateLockFactory } = {},
  ) {
    this.path = path;
    this.acquireLock = options.acquireStateLock ?? acquireStateLock;
  }

  private async readCurrent(): Promise<RegistrationState | null> {
    const value = await readJsonIfExists<unknown>(this.path);
    return value === null ? null : validateState(value);
  }

  private async update(
    mutate: (state: RegistrationState | null) => RegistrationState,
  ): Promise<RegistrationState> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let lock: StateLock | null = null;
    try {
      lock = await this.acquireLock(`${this.path}.lock`);
      const next = validateState(mutate(await this.readCurrent()));
      await writeJsonAtomically(this.path, next, 0o600);
      return structuredClone(next);
    } finally {
      try {
        if (lock) await lock.release();
      } finally {
        release();
      }
    }
  }

  async load(): Promise<RegistrationState | null> {
    const lock = await this.acquireLock(`${this.path}.lock`);
    try {
      return await this.readCurrent();
    } finally {
      await lock.release();
    }
  }

  async savePendingRegistration(
    workerCredential: string,
    registrationIdempotencyKey: string,
  ): Promise<RegistrationState> {
    return await this.update((state) => ({
      ...(state ?? { version: 1 }),
      workerCredential,
      registrationIdempotencyKey,
    }));
  }

  async saveRegistered(
    workerCredential: string,
    result: WorkerRegistrationResult,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      const next: RegistrationState = {
        ...(state ?? { version: 1 }),
        workerCredential,
        workerHostId: result.workerHostId,
        principalId: result.principalId,
        registrationGeneration: result.registrationGeneration,
        workerSessionId: result.workerSessionId,
        workerSessionGeneration: result.workerSessionGeneration as
          | WorkerSessionGeneration
          | undefined,
      };
      delete next.registrationIdempotencyKey;
      return next;
    });
  }

  async saveSession(
    workerSessionId: string,
    workerSessionGeneration: WorkerSessionGeneration,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return { ...state, workerSessionId, workerSessionGeneration };
    });
  }

  async savePendingHeartbeat(
    pendingHeartbeat: PersistedPendingHeartbeat,
  ): Promise<RegistrationState> {
    validatePendingHeartbeat(pendingHeartbeat);
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return {
        ...state,
        pendingHeartbeat: structuredClone(pendingHeartbeat),
      };
    });
  }

  async saveSessionAndClearPendingHeartbeat(
    workerSessionId: string,
    workerSessionGeneration: WorkerSessionGeneration,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const next = { ...state, workerSessionId, workerSessionGeneration };
      delete next.pendingHeartbeat;
      return next;
    });
  }

  async savePendingClaimKey(
    pendingClaimKey: string | undefined,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const next = { ...state };
      if (pendingClaimKey) next.pendingClaimKey = pendingClaimKey;
      else {
        delete next.pendingClaimKey;
        delete next.pendingClaim;
      }
      return next;
    });
  }

  async savePendingClaim(
    pendingClaim: PersistedPendingClaim,
  ): Promise<RegistrationState> {
    validatePendingClaim(pendingClaim);
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return {
        ...state,
        pendingClaimKey: pendingClaim.claimKey,
        pendingClaim: structuredClone(pendingClaim),
      };
    });
  }

  async commitClaimAssignment(
    entry: PersistedActiveAssignment,
  ): Promise<RegistrationState> {
    validateActiveAssignment(entry);
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return writeActiveAssignment(state, entry, {
        clearPendingClaim: true,
      });
    });
  }

  async saveCommandOutcome(
    commandId: string,
    status: WorkerCommandOutcomeStatus,
    options: {
      admissionPaused?: boolean;
      operatorPaused?: boolean;
      capacityPaused?: boolean;
    } = {},
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const commandOutcomes = { ...(state.commandOutcomes ?? {}) };
      if (
        !(commandId in commandOutcomes) &&
        Object.keys(commandOutcomes).length >= 100
      ) {
        throw new Error("WORKER_COMMAND_ACK_CAPACITY_EXCEEDED");
      }
      commandOutcomes[commandId] = status;
      const next = { ...state, commandOutcomes };
      if (options.admissionPaused !== undefined) {
        next.admissionPaused = options.admissionPaused;
      }
      if (options.operatorPaused !== undefined) {
        next.operatorPaused = options.operatorPaused;
      }
      if (options.capacityPaused !== undefined) {
        next.capacityPaused = options.capacityPaused;
      }
      return next;
    });
  }

  async saveTerminationEvidence(
    attemptId: string,
    evidence: PersistedTerminationEvidence,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const terminationEvidence = { ...(state.terminationEvidence ?? {}) };
      const existing = terminationEvidence[attemptId];
      if (
        !existing &&
        Object.keys(terminationEvidence).length >= MAX_TERMINATION_EVIDENCE
      ) {
        throw new TerminationEvidenceCapacityError();
      }
      terminationEvidence[attemptId] = structuredClone(
        mergeTerminationEvidence(existing, evidence),
      );
      return { ...state, terminationEvidence };
    });
  }

  async setCapacityPaused(
    capacityPaused: boolean,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const operatorPaused = state.operatorPaused ??
        (state.admissionPaused === true && state.capacityPaused !== true);
      return {
        ...state,
        admissionPaused: operatorPaused || capacityPaused,
        operatorPaused,
        capacityPaused,
      };
    });
  }

  async clearTerminationEvidence(
    attemptId: string,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const terminationEvidence = { ...(state.terminationEvidence ?? {}) };
      delete terminationEvidence[attemptId];
      const next = { ...state };
      if (Object.keys(terminationEvidence).length) {
        next.terminationEvidence = terminationEvidence;
      } else {
        delete next.terminationEvidence;
        if (state.capacityPaused === true) {
          const operatorPaused = state.operatorPaused ??
            (state.admissionPaused === true &&
              state.capacityPaused !== true);
          next.capacityPaused = false;
          next.operatorPaused = operatorPaused;
          next.admissionPaused = operatorPaused;
        }
      }
      return next;
    });
  }

  async reconcileCapacityPause(): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const legacyOperatorPaused = state.operatorPaused === undefined &&
        state.admissionPaused === true && state.capacityPaused !== true;
      if (state.capacityPaused !== true) {
        return legacyOperatorPaused
          ? { ...state, operatorPaused: true }
          : state;
      }
      if (Object.keys(state.terminationEvidence ?? {}).length > 0) {
        return state;
      }
      const operatorPaused = state.operatorPaused ?? false;
      return {
        ...state,
        admissionPaused: operatorPaused,
        operatorPaused,
        capacityPaused: false,
      };
    });
  }

  async clearCommandOutcome(commandId: string): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      if (!state.commandOutcomes?.[commandId]) return state;
      const commandOutcomes = { ...state.commandOutcomes };
      const commandOutcomeCreatedAt = {
        ...(state.commandOutcomeCreatedAt ?? {}),
      };
      delete commandOutcomes[commandId];
      delete commandOutcomeCreatedAt[commandId];
      const next: RegistrationState = { ...state };
      if (Object.keys(commandOutcomes).length) {
        next.commandOutcomes = commandOutcomes;
      } else {
        delete next.commandOutcomes;
      }
      if (Object.keys(commandOutcomeCreatedAt).length) {
        next.commandOutcomeCreatedAt = commandOutcomeCreatedAt;
      } else {
        delete next.commandOutcomeCreatedAt;
      }
      return next;
    });
  }

  async saveActiveAssignment(
    entry: PersistedActiveAssignment,
  ): Promise<RegistrationState> {
    validateActiveAssignment(entry);
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return writeActiveAssignment(state, entry, {
        clearMissingRenewalKey: true,
      });
    });
  }

  async updateActiveAssignment(
    attemptId: string,
    patch: Partial<PersistedActiveAssignment>,
  ): Promise<RegistrationState> {
    if (patch.assignment) {
      validateActiveAssignment({
        assignment: patch.assignment,
        nextLocalSeq: patch.nextLocalSeq || "1",
        ackedLocalSeq: patch.ackedLocalSeq || "0",
        renewalKey: patch.renewalKey,
        terminalAcked: patch.terminalAcked,
      });
    }
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const current = state.activeAssignments?.[attemptId];
      if (!current) return state;
      const currentEntry = current;
      const nextEntry: PersistedActiveAssignment = {
        ...currentEntry,
        ...patch,
        nextLocalSeq: patch.nextLocalSeq ?? currentEntry.nextLocalSeq,
        ackedLocalSeq: patch.ackedLocalSeq ?? currentEntry.ackedLocalSeq,
        assignment: patch.assignment
          ? structuredClone(patch.assignment)
          : currentEntry.assignment,
      };
      validateActiveAssignment(nextEntry);
      return writeActiveAssignment(state, nextEntry, {
        clearMissingRenewalKey: true,
      });
    });
  }

  async clearActiveAssignment(attemptId: string): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return removeAttemptState(state, attemptId, false);
    });
  }

  async saveReleaseMarker(
    attemptId: string,
    reason: string,
  ): Promise<RegistrationState> {
    if (!isNonEmptyText(attemptId) || !isNonEmptyText(reason)) {
      throw new Error("WORKER_RELEASE_MARKER_INVALID");
    }
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const releaseMarkers = { ...(state.releaseMarkers ?? {}) };
      if (
        !(attemptId in releaseMarkers) &&
        Object.keys(releaseMarkers).length >= 100
      ) {
        throw new Error("WORKER_RELEASE_MARKER_CAPACITY_EXCEEDED");
      }
      releaseMarkers[attemptId] = { reason };
      return { ...state, releaseMarkers };
    });
  }

  async completeRelease(attemptId: string): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      return removeAttemptState(state, attemptId, true);
    });
  }

  async savePendingRenewalKey(
    attemptId: string,
    key: string | undefined,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const current = state.activeAssignments?.[attemptId];
      if (key !== undefined && !current) {
        throw new Error("WORKER_ACTIVE_ASSIGNMENT_REQUIRED");
      }
      const pendingRenewalKeys = { ...(state.pendingRenewalKeys ?? {}) };
      const activeAssignments = { ...(state.activeAssignments ?? {}) };
      if (key === undefined) {
        delete pendingRenewalKeys[attemptId];
        if (current) {
          activeAssignments[attemptId] = { ...current };
          delete activeAssignments[attemptId].renewalKey;
        }
      } else {
        pendingRenewalKeys[attemptId] = key;
        activeAssignments[attemptId] = { ...current!, renewalKey: key };
      }
      const next = { ...state };
      if (Object.keys(pendingRenewalKeys).length) {
        next.pendingRenewalKeys = pendingRenewalKeys;
      } else {
        delete next.pendingRenewalKeys;
      }
      if (Object.keys(activeAssignments).length) {
        next.activeAssignments = activeAssignments;
      }
      return next;
    });
  }

  async prunePendingRenewalKeys(): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const activeAssignments = { ...(state.activeAssignments ?? {}) };
      const pendingRenewalKeys = { ...(state.pendingRenewalKeys ?? {}) };
      for (const attemptId of Object.keys(activeAssignments)) {
        const entry = activeAssignments[attemptId];
        const key = entry.renewalKey ?? pendingRenewalKeys[attemptId];
        if (key) {
          activeAssignments[attemptId] = { ...entry, renewalKey: key };
          pendingRenewalKeys[attemptId] = key;
        } else {
          delete pendingRenewalKeys[attemptId];
        }
      }
      for (const attemptId of Object.keys(pendingRenewalKeys)) {
        if (!activeAssignments[attemptId]) delete pendingRenewalKeys[attemptId];
      }
      const next = { ...state };
      if (Object.keys(activeAssignments).length) {
        next.activeAssignments = activeAssignments;
      }
      if (Object.keys(pendingRenewalKeys).length) {
        next.pendingRenewalKeys = pendingRenewalKeys;
      } else {
        delete next.pendingRenewalKeys;
      }
      return next;
    });
  }

  async rebindActiveAssignments(
    workerSessionId: string,
    workerSessionGeneration: WorkerSessionGeneration,
    reconciledAttemptIds?: ReadonlySet<string>,
  ): Promise<RegistrationState> {
    return await this.update((state) => {
      if (!state) throw new Error("WORKER_NOT_REGISTERED");
      const activeAssignments = Object.fromEntries(
        Object.entries(state.activeAssignments ?? {}).map(([
          attemptId,
          entry,
        ]) => [
          attemptId,
          reconciledAttemptIds === undefined ||
            reconciledAttemptIds.has(attemptId)
            ? {
              ...entry,
              assignment: {
                ...entry.assignment,
                workerSessionId,
                workerSessionGeneration: String(workerSessionGeneration),
              },
            }
            : entry,
        ]),
      );
      return {
        ...state,
        ...(Object.keys(activeAssignments).length ? { activeAssignments } : {}),
      };
    });
  }
}
