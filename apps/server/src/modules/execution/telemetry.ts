/**
 * What the execution routes know of telemetry.
 *
 * Lease renewal, completion and usage settlement are the paths telemetry must
 * never be able to hurt, so the routes see a port with one method and use it
 * under three rules:
 *
 * - It is called only after the transaction that did the work has committed,
 *   never inside it, so a slow or broken telemetry cannot hold a lock, fail a
 *   commit or change what was written.
 * - Its result is never awaited and nothing it does reaches the response: a
 *   throw is swallowed, and a returned promise that rejects is handled.
 * - What it is given is identifiers and a closed outcome word, never a lease
 *   token, a payload or any text the worker sent. The telemetry's own allowlist
 *   refuses anything else, but nothing is passed that it would have to refuse.
 */

/** The one thing the execution routes ask of telemetry. */
export type ExecutionTelemetry = {
  event(name: string, attributes?: unknown): void;
};

/** The events the execution routes emit. They must be in the server's allowlist. */
export const EXECUTION_TELEMETRY_EVENTS = Object.freeze({
  leaseRenewed: "lease.renewed",
  jobCompleted: "job.completed",
  usageSettled: "usage.settled",
});

/** The outcome words `job.completed` carries; the server's allowlist lists the same. */
export type JobOutcome = "completed" | "failed" | "canceled";

export const JOB_OUTCOMES: readonly JobOutcome[] = Object.freeze([
  "completed",
  "failed",
  "canceled",
]);

/**
 * Tells telemetry something happened. Never throws, never waits, and does
 * nothing when there is no telemetry. Call it after the commit.
 */
export function emitExecutionEvent(
  telemetry: ExecutionTelemetry | undefined,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
): void {
  if (telemetry === undefined) return;
  try {
    const returned: unknown = telemetry.event(name, attributes);
    // The port returns nothing, but a stand-in written as an async function
    // would return a promise, and an unhandled rejection ends a Node or Deno
    // process. Only a genuine Promise gets a handler, through the built-in
    // `then`: a foreign `then` is never called, because whatever it returns (a
    // rejected promise, an async function's promise) is a promise nobody holds,
    // and a subclass's own `then` is no safer. A thenable that is not a Promise
    // is left alone, so it cannot reject anything.
    if (returned instanceof Promise) {
      Promise.prototype.then.call(returned, undefined, () => {});
    }
  } catch {
    // Telemetry never reaches the caller.
  }
}
