import { writeJsonAtomically } from "./storage.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_KEYS = [
  "event",
  "launchId",
  "outcome",
  "signal",
  "workerHostId",
  "workerSessionGeneration",
  "workerSessionId",
] as const;

export const WORKER_SHUTDOWN_RECEIPT_FILE = "shutdown-complete.json";

export type WorkerShutdownIdentity = Readonly<{
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
}>;

export type WorkerShutdownReceipt = Readonly<
  & WorkerShutdownIdentity
  & {
    event: "bakery.worker.shutdown-complete.v1";
    launchId: string;
    signal: "SIGTERM";
    outcome: "drained";
  }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function workerShutdownReceiptPath(stateDir: string): string {
  return `${stateDir}/${WORKER_SHUTDOWN_RECEIPT_FILE}`;
}

export function parseWorkerShutdownReceipt(
  value: unknown,
): WorkerShutdownReceipt {
  if (!isRecord(value)) throw new Error("WORKER_SHUTDOWN_RECEIPT_INVALID");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RECEIPT_KEYS.length ||
    keys.some((key, index) => key !== [...RECEIPT_KEYS].sort()[index]) ||
    value.event !== "bakery.worker.shutdown-complete.v1" ||
    value.signal !== "SIGTERM" ||
    value.outcome !== "drained" ||
    !isUuid(value.launchId) ||
    !isUuid(value.workerHostId) ||
    !isUuid(value.workerSessionId) ||
    typeof value.workerSessionGeneration !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.workerSessionGeneration)
  ) throw new Error("WORKER_SHUTDOWN_RECEIPT_INVALID");
  return value as WorkerShutdownReceipt;
}

export async function publishWorkerShutdownReceipt(options: {
  stateDir: string;
  launchId: string;
  identity: WorkerShutdownIdentity;
}): Promise<WorkerShutdownReceipt> {
  const receipt = parseWorkerShutdownReceipt({
    event: "bakery.worker.shutdown-complete.v1",
    launchId: options.launchId,
    signal: "SIGTERM",
    outcome: "drained",
    ...options.identity,
  });
  await writeJsonAtomically(
    workerShutdownReceiptPath(options.stateDir),
    receipt,
    0o600,
  );
  return receipt;
}
