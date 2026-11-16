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
 *
 * The port's type is the facade itself (see {@link ExecutionTelemetry}).
 */
import type { Telemetry } from "@bakery/config/telemetry";

/**
 * The routes' telemetry port is the server's own facade, not an arbitrary
 * `{ event(): unknown }` shape.
 *
 * The facade's `event` returns `void` and never rejects, so the hazards below
 * cannot be expressed through it; accepting the facade type is what makes a
 * hand-written port with an async or throwing `event` a compile error rather
 * than something the emitter has to survive at runtime (issue 247).
 *
 * Residual risk, accepted and recorded rather than fixed: `emitExecutionEvent`
 * still handles only a genuine `Promise`, through the built-in `then`. Two
 * hostile shapes would still end the process if one were ever forced past this
 * type with a cast: a `Promise` subclass whose `Symbol.species` constructor
 * throws, and a `Proxy` around a rejected promise. `Promise.prototype.then.call`
 * cannot avoid either, because the built-in `then` honours species and Proxy
 * traps.
 *
 * They are deliberately NOT pinned by a test, and that is the honest statement
 * rather than an omission: triggering either ends the process, so a test that
 * calls the emitter with one cannot assert that the caller survives — it would
 * take the whole lane down with it. The hostile shapes that a test *can* outlive
 * (a throw, a string, a rejected promise, a promise that never settles, a
 * hand-written thenable) are pinned in `server-telemetry-wiring_test.ts`. These
 * two are accepted because the type now excludes them, and a cast is the only
 * way left to reach them.
 */
export type ExecutionTelemetry = Telemetry;

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
