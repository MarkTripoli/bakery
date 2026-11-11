import type { PgDatabase, PgTransactionClient } from "./postgres.ts";

export type RequestMetadata = {
  requestId: string;
  traceId: string;
};

export type HostRow = {
  id: string;
  organizationId: string;
  principalId: string;
  principalType: string;
  name: string;
  os: string;
  architecture: string;
  capabilities: unknown;
  slots: number;
  status: string;
  desiredMode: string;
  credentialHash: string;
  credentialGeneration: number;
  protocolVersion: number;
  inventoryRevision: number;
  readinessRevision: number;
  workerSessionId: string | null;
  workerSessionGeneration: string | number;
  lastHeartbeatAt: Date | string | null;
};

export type AttemptRow = {
  id: string;
  organizationId: string;
  jobId: string;
  workerHostId: string;
  workerSessionId: string | null;
  workerSessionGeneration: string | number;
  fence: string | number;
  leaseTokenHash: string;
  leaseExpiresAt: Date | string;
  leaseExpired: boolean;
  jobCurrentFence: string | number;
  status: string;
  lastEventSeq: string | number;
};

export type ExistingEventRow = {
  localSeq: string | number;
  eventId: string;
  eventType: string;
  payloadDigest: string;
  savedAck: unknown;
};

export type JobRow = {
  id: string;
  organizationId: string;
  runStepId: string;
  action: string;
  requirements: unknown;
  input: unknown;
  currentCheckpoints: unknown;
  agentConfig: unknown;
  skillRefs: unknown;
  agentVersionId: string | null;
  billing: unknown;
  installationReservationId: string | null;
  currentFence: string | number;
};

export type WorkerIdentity = {
  tokenHash: string;
  host: HostRow;
};

export type ExecutionDatabaseOptions = {
  database: PgDatabase;
};

export type QueryTransaction = PgTransactionClient;

export function sessionGeneration(
  value: string | number,
  minimum = 0n,
): bigint {
  const parsed = BigInt(value);
  if (parsed < minimum) throw new Error("WORKER_SESSION_GENERATION_INVALID");
  return parsed;
}

export function assertBigIntAtLeast(
  value: string | number,
  minimum: bigint,
): bigint {
  const parsed = BigInt(value);
  if (parsed < minimum) throw new Error("WORKER_FENCE_INVALID");
  return parsed;
}
