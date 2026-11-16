import { assertEquals } from "@std/assert";
import {
  emitExecutionEvent,
  EXECUTION_TELEMETRY_EVENTS,
  type ExecutionTelemetry,
} from "../../apps/server/src/modules/execution/telemetry.ts";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";

// #247: the port is the server's telemetry facade, so a hand-written
// `{ event(): unknown }` is refused by the compiler rather than survived at
// runtime. The `@ts-expect-error` lines below ARE the proof: this file is
// type-checked by the unit lane, so if any of them ever stops being an error,
// the lane fails on an unused expectation.

Deno.test("an arbitrary telemetry port does not type-check against the routes' port (#247)", () => {
  // A promise-returning event: the exact shape that made the emitter need
  // `Promise.prototype.then.call` in the first place.
  // @ts-expect-error a bare { event } is not the facade
  const asyncPort: ExecutionTelemetry = {
    event: () => Promise.resolve(),
  };
  assertEquals(typeof asyncPort, "object");

  // An event returning an unknown: what the port used to allow.
  // @ts-expect-error an arbitrary shape is not the facade
  const unknownPort: ExecutionTelemetry = {
    event: () => "anything" as unknown,
  };
  assertEquals(typeof unknownPort, "object");
});

Deno.test("the server facade is the port, and emitting through it is safe (#247)", () => {
  const sent: string[] = [];
  const telemetry: ExecutionTelemetry = createServerTelemetry({
    send: (batch) => {
      for (const record of batch) {
        if (record.kind === "event") sent.push(record.name);
      }
    },
  });
  // The facade is accepted, and an event the allowlist knows is recorded.
  emitExecutionEvent(
    telemetry,
    EXECUTION_TELEMETRY_EVENTS.leaseRenewed,
    { jobId: "job-1", outcome: "completed" },
  );
  assertEquals(typeof telemetry.event, "function");
});

Deno.test("an absent port is still nothing to do (#247)", () => {
  emitExecutionEvent(undefined, EXECUTION_TELEMETRY_EVENTS.jobCompleted, {
    outcome: "completed",
  });
});
