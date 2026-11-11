import type { z } from "zod";
import type { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import type {
  WorkerSkillFileResponse,
  WorkerSkillReadAuthority,
  WorkerSkillVersionResponse,
} from "@bakery/contracts/worker-skill-read";

type ContractValue<Name extends keyof typeof contractSchemas> = z.output<
  (typeof contractSchemas)[Name]
>;

export type WorkerSessionGeneration = number | string;
/**
 * Maximum encoded size of a terminal worker result payload on the wire.
 * The spool minimum derives from this protocol budget, rather than from an
 * unrelated storage size.
 */
export const WORKER_RESULT_MAX_BYTES = 32_000;

/**
 * Per-attempt output status reserve, charged to every reserved terminal
 * attempt by the spool capacity check. Living here keeps the supported
 * configuration minima derivable from the reservation scheme itself.
 */
export const OUTPUT_STATUS_RESERVE_RECORDS = 8;
export const OUTPUT_STATUS_RESERVE_BYTES = 64 * 1024;

/**
 * One terminal result may consume the full protocol budget, plus its output
 * status reserve, plus the persisted-state envelope. The minima derive from
 * the reservation arithmetic so every accepted configuration can admit one
 * supported assignment instead of failing `reserveTerminal` after leasing.
 */
export const WORKER_SPOOL_STATE_OVERHEAD_BYTES = 2 * 1024;

/** Upper bound over contract-legal identity lengths (lease token max 512). */
export const WORKER_SPOOL_MIN_BYTES = terminalReservationBytes({
  attemptId: "0".repeat(36),
  leaseToken: "L".repeat(512),
  fence: "9".repeat(20),
}) + OUTPUT_STATUS_RESERVE_BYTES + WORKER_SPOOL_STATE_OVERHEAD_BYTES;
export const WORKER_SPOOL_MIN_RECORDS = 1 + OUTPUT_STATUS_RESERVE_RECORDS;

/** Encoded bytes of a worst-case reserved terminal spool record and its maps. */
export function terminalReservationBytes(input: {
  attemptId: string;
  leaseToken: string;
  fence: string;
}): number {
  const payload = {
    status: "completed",
    result: "x".repeat(WORKER_RESULT_MAX_BYTES),
  };
  const record = {
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    fence: input.fence,
    localSeq: "9223372036854775806",
    eventId: "00000000-0000-4000-8000-000000000000",
    kind: "result",
    type: "result",
    payload,
    digest: "0".repeat(64),
  };
  const envelope = new TextEncoder().encode(JSON.stringify(record)).byteLength;
  const mapOverhead = new TextEncoder().encode(JSON.stringify({
    nextLocalSeq: { [input.attemptId]: "9223372036854775806" },
    ackedLocalSeq: { [input.attemptId]: "9223372036854775805" },
  })).byteLength;
  return envelope + mapOverhead;
}

export type WorkerProtocolVersion = 2;
export type WorkerSessionFields = {
  workerSessionId: string;
  workerSessionGeneration: string;
};
export type WorkerExecutionIdentity = {
  type: "cgroup-v2";
  boundaryId: string;
  attemptId: string;
  assignmentFence: string;
  cgroupRoot: string;
  cgroupPath: string;
  /**
   * The phase is optional only for identities written by the previous
   * executor version. New identities always persist it before side effects.
   */
  phase?: "provisioning" | "active" | "terminating";
  cgroupDevice?: string;
  cgroupInode?: string;
  sidecarPath: string;
};

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};

export type WorkerRegistration = ContractValue<"WorkerRegistration">;
export type WorkerRegistrationResult = ContractValue<
  "WorkerRegistrationResult"
>;
export type WorkerClaim = ContractValue<"WorkerClaim">;
export type JobAssignment = ContractValue<"JobAssignment">;
export type UsageReceipt = ContractValue<"UsageReceipt">;
export type PinnedSkillRef = ContractValue<"PinnedSkillRef">;
export type SkillFileManifestEntry = ContractValue<"SkillFileManifestEntry">;
export type WorkerSkillVersionRequest =
  & WorkerSkillReadAuthority
  & PinnedSkillRef
  & {
    workerHostId: string;
  };
export type WorkerSkillFileRequest = WorkerSkillVersionRequest & {
  organizationId: string;
  file: SkillFileManifestEntry;
};
export type {
  WorkerSkillFileResponse,
  WorkerSkillReadAuthority,
  WorkerSkillVersionResponse,
};

/** Exact immutable cache namespace authorized by the server. */
export type SkillCacheIdentity = Readonly<{
  organizationId: string;
  versionId: string;
  digest: string;
}>;

/** Durable owner identity for one attempt's cache pin and private copy. */
export type SkillMaterializationOwner = Readonly<{
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  jobId: string;
  attemptId: string;
  fence: string;
}>;

/** Request used by the supervisor to prepare all exact pins for one attempt. */
export type SkillMaterializationRequest = Readonly<{
  assignment: JobAssignment;
  workerSessionId: string;
  workerSessionGeneration: string;
}>;

/** One verified, attempt-private skill tree. It is not an OS sandbox. */
export type PreparedSkillRoot = Readonly<
  & SkillCacheIdentity
  & SkillMaterializationOwner
  & {
    rootPath: string;
    entryPath: string;
  }
>;

/**
 * Prepared roots remain owned by the exact attempt until release settles.
 * A caller must invoke release after executor settlement, including failures.
 */
export type PreparedSkillContext = Readonly<{
  owner: SkillMaterializationOwner;
  roots: readonly PreparedSkillRoot[];
  release(): Promise<void>;
}>;

export type WorkerHeartbeat = ContractValue<"WorkerHeartbeat">;
export type WorkerCommand = ContractValue<"WorkerCommand">;
export type WorkerCommandOutcomeStatus = "acknowledged" | "rejected";
export type LeaseState = ContractValue<"LeaseState">;
export type WorkerHeartbeatResult = ContractValue<"WorkerHeartbeatResult">;
export type WorkerInventoryReport = ContractValue<"WorkerInventoryReport">;
export type WorkerInventoryCheck = ContractValue<"WorkerInventoryCheck">;
export type WorkerInventoryReceipt = ContractValue<"WorkerInventoryReceipt">;
export type WorkerHeartbeatResultWithReconciliation = WorkerHeartbeatResult & {
  reconciledAttemptIds?: string[];
};
export type WorkerEventBatch = ContractValue<"WorkerEventBatch">;
export type WorkerResult = ContractValue<"WorkerResult">;
export type WorkerCleanupRequest = {
  fence: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  observedByWorkerSessionId: string;
  observedByWorkerSessionGeneration: string;
  exitedAt: string;
};
export type WorkerCleanupResult = {
  attemptId: string;
  status: "canceled";
  cancellation: JsonValue;
};
export type WorkerAck = ContractValue<"WorkerAck">;

export type WorkerHeartbeatRequest =
  & Omit<WorkerHeartbeat, "workerSessionId" | "workerSessionGeneration">
  & WorkerSessionFields
  & { pendingClaimKey?: string };

export type WorkerClaimRequest =
  & Omit<WorkerClaim, "workerSessionId" | "workerSessionGeneration">
  & WorkerSessionFields;

export type LeaseRenewalRequest = {
  leaseToken: string;
  fence: string;
  leaseSeconds: number;
} & WorkerSessionFields;

export type WorkerEventBatchRequest =
  & Omit<WorkerEventBatch, "workerSessionId" | "workerSessionGeneration">
  & WorkerSessionFields;

export type WorkerResultRequest =
  & Omit<WorkerResult, "workerSessionId" | "workerSessionGeneration">
  & WorkerSessionFields;

export type WorkerEvent = {
  eventId: string;
  localSeq: string;
  eventType: string;
  payload: JsonValue;
};

export type PersistedPendingClaim = {
  claimKey: string;
  workerHostId: string;
  capabilities: string[];
  supportedActions?: string[];
};

export type PersistedActiveAssignment = {
  assignment: JobAssignment;
  nextLocalSeq: string;
  ackedLocalSeq: string;
  renewalKey?: string;
  terminalAcked?: boolean;
  cleanQuiescence?: boolean;
};

export type PersistedPendingHeartbeat = {
  idempotencyKey: string;
  body: WorkerHeartbeatRequest;
};

export type PersistedReleaseMarker = {
  reason: string;
};

export type PersistedTerminationEvidence = {
  status: "pending" | "unknown";
  observedAt: string;
  fence?: string;
  observedExitAt?: string;
  cleanupComplete?: boolean;
  observedBy?: WorkerSessionFields;
};

export type RegistrationState = {
  version: 1;
  workerCredential: string;
  workerHostId?: string;
  principalId?: string;
  registrationGeneration?: number;
  workerSessionId?: string;
  workerSessionGeneration?: WorkerSessionGeneration;
  registrationIdempotencyKey?: string;
  pendingHeartbeat?: PersistedPendingHeartbeat;
  pendingClaimKey?: string;
  pendingClaim?: PersistedPendingClaim;
  commandOutcomes?: Record<string, WorkerCommandOutcomeStatus>;
  commandOutcomeCreatedAt?: Record<string, string>;
  pendingRenewalKeys?: Record<string, string>;
  activeAssignments?: Record<string, PersistedActiveAssignment>;
  releaseMarkers?: Record<string, PersistedReleaseMarker>;
  admissionPaused?: boolean;
  operatorPaused?: boolean;
  capacityPaused?: boolean;
  terminationEvidence?: Record<string, PersistedTerminationEvidence>;
};
export type SpoolRecordKind = "event" | "result";
export type SpoolRecord = {
  attemptId: string;
  leaseToken: string;
  fence: string;
  localSeq: string;
  eventId: string;
  kind: SpoolRecordKind;
  type: string;
  payload: JsonValue;
  digest: string;
};

export type WorkerOutputOpen = ContractValue<"WorkerOutputOpen">;
export type WorkerOutputClose = ContractValue<"WorkerOutputClose">;
export type WorkerOutputBinding = ContractValue<"WorkerOutputBinding">;
export type WorkerOutputFinalize = ContractValue<"WorkerOutputFinalize">;
export type WorkerOutputFinalization = ContractValue<
  "OutputFinalizationReceipt"
>;
export type WorkerOutputRevoke = ContractValue<"WorkerOutputRevoke">;
export type WorkerOutputRevokeReceipt = ContractValue<"OutputRevokeReceipt">;
export type {
  OutputBatch,
  OutputPart,
} from "../../../packages/contracts/src/output.ts";
