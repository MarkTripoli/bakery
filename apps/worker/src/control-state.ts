export const WORKER_CONTROL_ACTIONS = [
  "cancel",
  "interrupt",
  "pause",
  "resume",
] as const;

export type WorkerControlAction = typeof WORKER_CONTROL_ACTIONS[number];
export type WorkerControlMode =
  | "running"
  | "paused"
  | "cancelling"
  | "interrupted";
export type TerminationStatus = "confirmed" | "pending" | "unknown";

export const MAX_TERMINATION_EVIDENCE = 64;
export const MAX_TERMINATION_CLEANUP_RETRIES_PER_HEARTBEAT = 8;

export class TerminationEvidenceCapacityError extends Error {
  constructor() {
    super("WORKER_TERMINATION_EVIDENCE_CAPACITY_EXCEEDED");
    this.name = "TerminationEvidenceCapacityError";
  }
}

export type LocalTerminationEvidence = {
  status: Exclude<TerminationStatus, "confirmed">;
  observedAt: string;
  fence?: string;
  observedExitAt?: string;
  cleanupComplete?: boolean;
  observedBy?: {
    workerSessionId: string;
    workerSessionGeneration: string;
  };
};

export function mergeTerminationEvidence(
  existing: LocalTerminationEvidence | undefined,
  incoming: LocalTerminationEvidence,
): LocalTerminationEvidence {
  const confirmedExit = (existing?.cleanupComplete === true &&
    existing.observedExitAt !== undefined) ||
    (incoming.cleanupComplete === true &&
      incoming.observedExitAt !== undefined);
  const status = confirmedExit
    ? "pending"
    : existing?.status === "unknown" || incoming.status === "unknown"
    ? "unknown"
    : "pending";
  return {
    status,
    observedAt: existing?.observedAt ?? incoming.observedAt,
    ...(existing?.fence ?? incoming.fence
      ? { fence: existing?.fence ?? incoming.fence }
      : {}),
    ...(existing?.observedExitAt ?? incoming.observedExitAt
      ? {
        observedExitAt: existing?.observedExitAt ?? incoming.observedExitAt,
      }
      : {}),
    ...(existing?.observedBy ?? incoming.observedBy
      ? { observedBy: existing?.observedBy ?? incoming.observedBy }
      : {}),
    ...(existing?.cleanupComplete === true || incoming.cleanupComplete === true
      ? { cleanupComplete: true }
      : incoming.cleanupComplete === false ||
          existing?.cleanupComplete === false
      ? { cleanupComplete: false }
      : {}),
  };
}

export type ControlTransition = {
  mode: WorkerControlMode;
  acknowledged: boolean;
  termination?: TerminationStatus;
};

export type ControlState = {
  mode: WorkerControlMode;
  admissionPaused: boolean;
  operatorPaused: boolean;
  capacityPaused: boolean;
  acknowledgements: Map<string, ControlTransition>;
};

export function syncAdmissionPause(state: ControlState): void {
  state.admissionPaused = state.operatorPaused || state.capacityPaused;
  if (state.admissionPaused && state.mode === "running") {
    state.mode = "paused";
  } else if (!state.admissionPaused && state.mode === "paused") {
    state.mode = "running";
  }
}

export function createControlState(): ControlState {
  return {
    mode: "running",
    admissionPaused: false,
    operatorPaused: false,
    capacityPaused: false,
    acknowledgements: new Map(),
  };
}

/** Apply a command exactly once; retries replay the original acknowledgement. */
export function applyControlAction(
  state: ControlState,
  commandId: string,
  action: WorkerControlAction,
  options: {
    active: boolean;
    freshHeartbeat?: boolean;
    workerScoped?: boolean;
    terminallyCanceled?: boolean;
  } = { active: true },
): ControlTransition {
  const prior = state.acknowledgements.get(commandId);
  if (prior) return prior;
  let transition: ControlTransition;
  if (
    !options.active && options.terminallyCanceled && action === "cancel"
  ) {
    state.mode = "cancelling";
    transition = {
      mode: state.mode,
      acknowledged: true,
      termination: "unknown",
    };
  } else if (
    !options.active && !(action === "resume" && options.workerScoped)
  ) {
    transition = {
      mode: state.mode,
      acknowledged: false,
      ...(action === "cancel" || action === "interrupt"
        ? { termination: "unknown" as const }
        : {}),
    };
  } else if (action === "resume") {
    const accepted = options.freshHeartbeat === true;
    if (accepted) {
      state.operatorPaused = false;
      syncAdmissionPause(state);
      state.mode = state.admissionPaused ? "paused" : "running";
    }
    transition = { mode: state.mode, acknowledged: accepted };
  } else if (action === "pause") {
    state.mode = "paused";
    state.operatorPaused = true;
    syncAdmissionPause(state);
    transition = { mode: state.mode, acknowledged: true };
  } else {
    state.mode = action === "cancel" ? "cancelling" : "interrupted";
    transition = {
      mode: state.mode,
      acknowledged: true,
      termination: "pending",
    };
  }
  state.acknowledgements.set(commandId, transition);
  return transition;
}

export function terminationEvidence(input: {
  processExited?: boolean;
  cleanupComplete?: boolean;
  observedExitAt?: string | null;
}): TerminationStatus {
  if (
    input.processExited === true && input.cleanupComplete === true &&
    input.observedExitAt
  ) return "confirmed";
  if (input.processExited === false || input.cleanupComplete === false) {
    return "pending";
  }
  return "unknown";
}

export function isWorkerControlAction(
  value: string,
): value is WorkerControlAction {
  return (WORKER_CONTROL_ACTIONS as readonly string[]).includes(value);
}
