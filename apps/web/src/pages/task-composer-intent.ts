import type { RunCreate, TaskCreate } from "../api/client.ts";

/**
 * One submission intent per composer draft. The id is minted once, kept in
 * `sessionStorage` under a key scoped to the organization and principal, and
 * cleared when the submission reaches a definitive outcome or the draft is
 * discarded. Request bodies are frozen with it, so a reload or a retry after
 * an unknown outcome replays the same keys and the same bodies.
 */
export const COMPOSER_INTENT_PREFIX = "bakery.taskComposer.intent";
export const START_RUN_INTENT_PREFIX = "bakery.taskStartRun.intent";

export type IntentStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ComposerSubmission = Readonly<{
  task: TaskCreate;
  /** Absent on the "Plan first" path: the task is created and no run starts. */
  run: RunCreate | null;
}>;

export type IntentRecord<Submission> = Readonly<{
  /** UUID the `:task` and `:run` idempotency keys derive from. */
  intent: string;
  /** Bodies frozen at the first send; absent until a send starts. */
  submission: Submission | null;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Storage key for the new-task composer of one principal in one organization. */
export function composerIntentKey(
  organizationId: string,
  principalId: string,
): string {
  return `${COMPOSER_INTENT_PREFIX}:${organizationId}:${principalId}`;
}

/** Storage key for starting a run on one existing draft task. */
export function startRunIntentKey(
  organizationId: string,
  principalId: string,
  taskId: string,
): string {
  return `${START_RUN_INTENT_PREFIX}:${organizationId}:${principalId}:${taskId}`;
}

export const taskIdempotencyKey = (intent: string) => `${intent}:task`;
export const runIdempotencyKey = (intent: string) => `${intent}:run`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the stored intent, or mint one when none is usable. A damaged value is
 * replaced rather than trusted. Unavailable storage degrades to an intent that
 * lives only as long as the page.
 */
export function loadIntent<Submission>(
  store: IntentStore | undefined,
  key: string,
  mint: () => string = () => crypto.randomUUID(),
): IntentRecord<Submission> {
  try {
    const raw = store?.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed) && typeof parsed.intent === "string" &&
        UUID.test(parsed.intent)
      ) {
        return {
          intent: parsed.intent,
          submission: isRecord(parsed.submission)
            ? parsed.submission as Submission
            : null,
        };
      }
    }
  } catch {
    // Fall through to a fresh intent.
  }
  const record: IntentRecord<Submission> = { intent: mint(), submission: null };
  saveIntent(store, key, record);
  return record;
}

export function saveIntent<Submission>(
  store: IntentStore | undefined,
  key: string,
  record: IntentRecord<Submission>,
): void {
  try {
    store?.setItem(key, JSON.stringify(record));
  } catch {
    // Storage may be full or blocked; the in-memory intent still holds.
  }
}

export function clearIntent(store: IntentStore | undefined, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

/** Browser session storage, or `undefined` when the platform denies it. */
export function browserIntentStore(): IntentStore | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export type FailureClass =
  | "unknown"
  | "forbidden"
  | "conflict"
  | "state-conflict"
  | "error";

type FailureLike =
  | { kind: "network" }
  | { kind: "invalid-response"; status?: number }
  | {
    kind: "problem";
    problem: { status: number; code: string; retryable: boolean };
  }
  | { kind: string };

/**
 * Sort a failed command. Anything that leaves the server's outcome open
 * (lost response, retryable problem, 5xx, 408) is `unknown` and is replayed
 * with the same keys; the rest are definitive.
 */
export function classifyFailure(failure: FailureLike): FailureClass {
  if (failure.kind !== "problem") return "unknown";
  const { problem } = failure as Extract<FailureLike, { kind: "problem" }>;
  if (problem.retryable || problem.status >= 500 || problem.status === 408) {
    return "unknown";
  }
  if (problem.status === 403) return "forbidden";
  if (problem.status === 409 || problem.status === 412) {
    return problem.code === "STATE_CONFLICT" ? "state-conflict" : "conflict";
  }
  return "error";
}
