import type {
  PersistedActiveAssignment,
  PersistedPendingClaim,
  PersistedPendingHeartbeat,
  PersistedReleaseMarker,
  PersistedTerminationEvidence,
  RegistrationState,
} from "./types.ts";

const DECIMAL = /^[0-9]+$/;

export function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSessionGeneration(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
    return;
  }
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
}

function assertSequence(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
}

export function validateActiveAssignment(
  value: unknown,
): PersistedActiveAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const entry = value as Record<string, unknown>;
  if (
    !entry.assignment || typeof entry.assignment !== "object" ||
    Array.isArray(entry.assignment)
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  assertSequence(entry.nextLocalSeq);
  assertSequence(entry.ackedLocalSeq);
  if (BigInt(entry.ackedLocalSeq) >= BigInt(entry.nextLocalSeq)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (entry.renewalKey !== undefined && !isNonEmptyText(entry.renewalKey)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (entry.terminalAcked !== undefined && entry.terminalAcked !== true) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (
    entry.cleanQuiescence !== undefined &&
    typeof entry.cleanQuiescence !== "boolean"
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (
    entry.cleanQuiescence === true &&
    (BigInt(entry.nextLocalSeq) <= 2n || entry.terminalAcked === true)
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  return structuredClone(value) as PersistedActiveAssignment;
}

export function validatePendingClaim(value: unknown): PersistedPendingClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const claim = value as Record<string, unknown>;
  if (
    !isNonEmptyText(claim.claimKey) || !isNonEmptyText(claim.workerHostId) ||
    !Array.isArray(claim.capabilities) ||
    claim.capabilities.some((item) => !isNonEmptyText(item))
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (
    claim.supportedActions !== undefined &&
    (!Array.isArray(claim.supportedActions) ||
      claim.supportedActions.some((item) => !isNonEmptyText(item)))
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  return structuredClone(value) as PersistedPendingClaim;
}

export function validatePendingHeartbeat(
  value: unknown,
): PersistedPendingHeartbeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const pending = value as Record<string, unknown>;
  const body = pending.body;
  if (
    !isNonEmptyText(pending.idempotencyKey) ||
    !body || typeof body !== "object" || Array.isArray(body)
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const heartbeat = body as Record<string, unknown>;
  if (
    !isNonEmptyText(heartbeat.workerHostId) ||
    !isNonEmptyText(heartbeat.observedAt) ||
    !Number.isFinite(Date.parse(heartbeat.observedAt)) ||
    !isNonEmptyText(heartbeat.workerSessionId) ||
    !isNonEmptyText(heartbeat.workerSessionGeneration) ||
    !DECIMAL.test(heartbeat.workerSessionGeneration) ||
    !Array.isArray(heartbeat.activeAttemptIds) ||
    heartbeat.activeAttemptIds.length > 100 ||
    heartbeat.activeAttemptIds.some((attemptId) => !isNonEmptyText(attemptId))
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  for (const name of ["ackCommandIds", "rejectedCommandIds"]) {
    const ids = heartbeat[name];
    if (
      !Array.isArray(ids) || ids.length > 100 ||
      ids.some((commandId) => !isNonEmptyText(commandId))
    ) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  if (
    heartbeat.pendingClaimKey !== undefined &&
    !isNonEmptyText(heartbeat.pendingClaimKey)
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  return structuredClone(value) as PersistedPendingHeartbeat;
}

function validateReleaseMarkers(
  value: unknown,
): Record<string, PersistedReleaseMarker> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const entries = Object.entries(value);
  if (
    entries.length > 100 ||
    entries.some(([attemptId, marker]) =>
      !isNonEmptyText(attemptId) ||
      !marker || typeof marker !== "object" || Array.isArray(marker) ||
      !isNonEmptyText((marker as Record<string, unknown>).reason)
    )
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  return structuredClone(value) as Record<string, PersistedReleaseMarker>;
}

function validateTerminationEvidence(
  value: unknown,
): Record<string, PersistedTerminationEvidence> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(([attemptId, evidence]) => {
      if (
        !isNonEmptyText(attemptId) ||
        !evidence ||
        typeof evidence !== "object" ||
        Array.isArray(evidence) ||
        !["pending", "unknown"].includes(
          String((evidence as Record<string, unknown>).status),
        ) ||
        typeof (evidence as Record<string, unknown>).observedAt !== "string" ||
        !Number.isFinite(
          Date.parse(String((evidence as Record<string, unknown>).observedAt)),
        )
      ) return true;
      const fields = evidence as Record<string, unknown>;
      if (fields.fence !== undefined && !isNonEmptyText(fields.fence)) {
        return true;
      }
      if (
        fields.observedExitAt !== undefined &&
        (typeof fields.observedExitAt !== "string" ||
          !Number.isFinite(Date.parse(fields.observedExitAt)))
      ) return true;
      if (
        fields.observedBy !== undefined &&
        (!fields.observedBy || typeof fields.observedBy !== "object" ||
          Array.isArray(fields.observedBy) ||
          !isNonEmptyText(
            (fields.observedBy as Record<string, unknown>)
              .workerSessionId,
          ) ||
          !isNonEmptyText(
            (fields.observedBy as Record<string, unknown>)
              .workerSessionGeneration,
          ) ||
          !DECIMAL.test(
            String(
              (fields.observedBy as Record<string, unknown>)
                .workerSessionGeneration,
            ),
          ))
      ) return true;
      return fields.cleanupComplete !== undefined &&
        typeof fields.cleanupComplete !== "boolean";
    })
  ) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  return structuredClone(value) as Record<
    string,
    PersistedTerminationEvidence
  >;
}

export function validateState(value: unknown): RegistrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !isNonEmptyText(state.workerCredential)) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  for (
    const name of [
      "workerHostId",
      "principalId",
      "registrationIdempotencyKey",
      "pendingClaimKey",
      "workerSessionId",
    ]
  ) {
    if (state[name] !== undefined && !isNonEmptyText(state[name])) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  for (const field of ["admissionPaused", "operatorPaused", "capacityPaused"]) {
    if (state[field] !== undefined && typeof state[field] !== "boolean") {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  if (state.registrationGeneration !== undefined) {
    if (
      typeof state.registrationGeneration !== "number" ||
      !Number.isSafeInteger(state.registrationGeneration) ||
      state.registrationGeneration < 1
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (state.workerSessionGeneration !== undefined) {
    assertSessionGeneration(state.workerSessionGeneration);
    const generation = typeof state.workerSessionGeneration === "number"
      ? state.workerSessionGeneration
      : BigInt(String(state.workerSessionGeneration));
    if (
      (typeof generation === "number" && generation < 1) ||
      (typeof generation === "bigint" && generation < 1n)
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  if (state.pendingHeartbeat !== undefined) {
    validatePendingHeartbeat(state.pendingHeartbeat);
  }
  if (state.pendingClaim !== undefined) {
    validatePendingClaim(state.pendingClaim);
  }
  if (state.pendingClaimKey !== undefined && state.pendingClaim === undefined) {
    // Older state files carry only the idempotency key. The supervisor fills in
    // the stable envelope before retrying it.
  }
  if (state.releaseMarkers !== undefined) {
    validateReleaseMarkers(state.releaseMarkers);
  }
  if (state.terminationEvidence !== undefined) {
    validateTerminationEvidence(state.terminationEvidence);
  }
  const commandOutcomes = state.commandOutcomes;
  const commandStatuses: Record<string, true> = {
    acknowledged: true,
    rejected: true,
  };
  if (commandOutcomes !== undefined) {
    if (
      !commandOutcomes || typeof commandOutcomes !== "object" ||
      Array.isArray(commandOutcomes)
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    const entries = Object.entries(commandOutcomes);
    if (
      entries.length > 100 ||
      entries.some(([key, status]) =>
        !isNonEmptyText(key) || typeof status !== "string" ||
        !commandStatuses[status]
      )
    ) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  const createdAt = state.commandOutcomeCreatedAt;
  if (createdAt !== undefined) {
    if (
      !createdAt || typeof createdAt !== "object" || Array.isArray(createdAt)
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    const entries = Object.entries(createdAt);
    if (
      entries.length > 100 ||
      entries.some(([key, timestamp]) =>
        !isNonEmptyText(key) || typeof timestamp !== "string" ||
        !Number.isFinite(Date.parse(timestamp))
      )
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const renewalKeys = state.pendingRenewalKeys;
  if (renewalKeys !== undefined) {
    if (
      !renewalKeys || typeof renewalKeys !== "object" ||
      Array.isArray(renewalKeys)
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    const entries = Object.entries(renewalKeys);
    if (
      entries.length > 100 ||
      entries.some(([attemptId, key]) =>
        !isNonEmptyText(attemptId) || !isNonEmptyText(key)
      )
    ) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  const activeAssignments = state.activeAssignments;
  if (activeAssignments !== undefined) {
    if (
      !activeAssignments || typeof activeAssignments !== "object" ||
      Array.isArray(activeAssignments)
    ) throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    const entries = Object.entries(activeAssignments);
    if (
      entries.length > 100 ||
      entries.some(([attemptId, entry]) =>
        !isNonEmptyText(attemptId) || !validateActiveAssignment(entry)
      )
    ) {
      throw new Error("WORKER_REGISTRATION_STATE_INVALID");
    }
  }
  return structuredClone(value) as RegistrationState;
}
