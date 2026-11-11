import { assertEquals } from "@std/assert";
import {
  closeWorkerFixture,
  type ExecutionState,
  openWorkerFixture,
  readExecutionState,
  type WorkerFixture,
  workerFixtureCapabilities,
  type WorkerRegistration,
  workerRequest,
} from "../worker-execution.ts";
export type WorkerAssignment = {
  jobId: string;
  attemptId: string;
  workerHostId: string;
  leaseToken: string;
  fence: string;
  action: string;
  leaseDurationSeconds: number;
  serverTime: string;
  [key: string]: unknown;
};
export type RegisteredWorker = {
  credential: string;
  registration: WorkerRegistration;
};

export async function withWorkerFixture<T>(
  work: (fixture: WorkerFixture) => Promise<T>,
  options: Parameters<typeof openWorkerFixture>[0] = {},
): Promise<T> {
  const fixture = await openWorkerFixture(options);
  try {
    return await work(fixture);
  } finally {
    await closeWorkerFixture(fixture);
  }
}

export async function claimAssignment(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  options: {
    claimKey?: string;
    capabilities?: string[];
    supportedActions?: string[];
  } = {},
): Promise<WorkerAssignment> {
  const claimKey = options.claimKey ?? crypto.randomUUID();
  const body: Record<string, unknown> = {
    claimKey,
    workerHostId: worker.registration.workerHostId,
    capabilities: options.capabilities ?? workerFixtureCapabilities,
  };
  if (options.supportedActions !== undefined) {
    body.supportedActions = options.supportedActions;
  }
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    body,
    { idempotencyKey: claimKey },
  );
  assertEquals(response.status, 200);
  return await response.json() as WorkerAssignment;
}

export function heartbeatRequest(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  options: {
    activeAttemptIds?: string[];
    ackCommandIds?: string[];
    rejectedCommandIds?: string[];
    load?: number;
    pendingClaimKey?: string;
    workerSessionId?: string;
    workerSessionGeneration?: string;
    idempotencyKey?: string;
    includeWorkerSession?: boolean;
    protocolVersion?: number;
    adapterCapabilities?: string[];
  } = {},
): Promise<Response> {
  const body: Record<string, unknown> = {
    workerHostId: worker.registration.workerHostId,
    observedAt: "2026-09-20T00:00:00.000Z",
    load: options.load ?? 0,
    activeAttemptIds: options.activeAttemptIds ?? [],
    ackCommandIds: options.ackCommandIds ?? [],
    rejectedCommandIds: options.rejectedCommandIds ?? [],
  };
  if (options.pendingClaimKey !== undefined) {
    body.pendingClaimKey = options.pendingClaimKey;
  }
  if (options.workerSessionId !== undefined) {
    body.workerSessionId = options.workerSessionId;
  }
  if (options.workerSessionGeneration !== undefined) {
    body.workerSessionGeneration = options.workerSessionGeneration;
  }
  if (options.adapterCapabilities !== undefined) {
    body.adapterCapabilities = options.adapterCapabilities;
  }
  const protocolVersion = options.protocolVersion;
  return workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/heartbeat",
    body,
    {
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      includeWorkerSession: options.includeWorkerSession,
      ...(protocolVersion === undefined ? {} : {
        headers: {
          "X-Bakery-Worker-Protocol-Version": String(protocolVersion),
        },
      }),
    },
  );
}

export function eventBody(
  assignment: Pick<WorkerAssignment, "leaseToken" | "fence">,
  eventId: string,
  localSeq = "1",
  acceptedAt = "2026-09-20T00:00:01.000Z",
  options: {
    eventType?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  return {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    events: [{
      eventId,
      localSeq,
      eventType: options.eventType ?? "job.accepted",
      payload: options.payload ?? { acceptedAt },
    }],
  };
}

export function resultBody(
  assignment: Pick<WorkerAssignment, "leaseToken" | "fence">,
  options: {
    localSeq?: string;
    status?: "completed" | "failed" | "canceled";
    result?: Record<string, unknown>;
    fault?: Record<string, unknown>;
    cancellation?: Record<string, unknown>;
  } = {},
) {
  return {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: options.localSeq ?? "1",
    status: options.status ?? "completed",
    ...(options.result === undefined ? {} : { result: options.result }),
    ...(options.fault === undefined ? {} : { fault: options.fault }),
    ...(options.cancellation === undefined
      ? {}
      : { cancellation: options.cancellation }),
  };
}

export function workerEventPath(assignment: WorkerAssignment): string {
  return `/v1/worker/attempts/${assignment.attemptId}/events`;
}

export function workerResultPath(assignment: WorkerAssignment): string {
  return `/v1/worker/attempts/${assignment.attemptId}/result`;
}

export function postWorkerEvent(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  assignment: WorkerAssignment,
  body: unknown,
  idempotencyKey: string,
  options: { includeWorkerSession?: boolean; protocolVersion?: number } = {},
): Promise<Response> {
  return workerRequest(
    fixture,
    worker.credential,
    workerEventPath(assignment),
    body,
    {
      idempotencyKey,
      includeWorkerSession: options.includeWorkerSession,
      ...(options.protocolVersion === undefined ? {} : {
        headers: {
          "X-Bakery-Worker-Protocol-Version": String(options.protocolVersion),
        },
      }),
    },
  );
}

export function postWorkerResult(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  assignment: WorkerAssignment,
  body: unknown,
  idempotencyKey: string,
  options: { includeWorkerSession?: boolean; protocolVersion?: number } = {},
): Promise<Response> {
  return workerRequest(
    fixture,
    worker.credential,
    workerResultPath(assignment),
    body,
    {
      idempotencyKey,
      includeWorkerSession: options.includeWorkerSession,
      ...(options.protocolVersion === undefined ? {} : {
        headers: {
          "X-Bakery-Worker-Protocol-Version": String(options.protocolVersion),
        },
      }),
    },
  );
}

export async function assertExecutionStateUnchanged(
  fixture: Pick<WorkerFixture, "pgDatabase">,
  jobId: string,
  expected: ExecutionState,
): Promise<void> {
  assertEquals(await readExecutionState(fixture.pgDatabase, jobId), expected);
}
