import { assert, assertEquals } from "@std/assert";
import type { TelemetryTrace } from "@bakery/config/telemetry";
import {
  emitAttemptEvent,
  type ExecutionTelemetry,
} from "../../apps/server/src/modules/execution/telemetry.ts";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

type Row = Record<string, unknown>;

/** A database that answers the attempt-trace read with one row, or fails. */
function database(row: Row | undefined, fail = false) {
  return {
    query: () => {
      if (fail) return Promise.reject(new Error("the read failed"));
      return Promise.resolve({ rows: row === undefined ? [] : [row] });
    },
  } as never;
}

function capture() {
  const seen: { name: string; attributes: unknown; trace?: TelemetryTrace }[] =
    [];
  const telemetry = {
    event: (name: string, attributes?: unknown, trace?: TelemetryTrace) => {
      seen.push({ name, attributes, trace });
    },
  } as unknown as ExecutionTelemetry;
  return { seen, telemetry };
}

const first = {
  traceparent: `00-${TRACE}-b7ad6b7169203331-01`,
  attempt_id: ATTEMPT,
  first_attempt_id: ATTEMPT,
  first_traceparent: `00-${TRACE}-b7ad6b7169203331-01`,
  attempt_number: "1",
};
const retry = {
  traceparent: `00-${TRACE}-c8be7c827a314442-01`,
  attempt_id: ATTEMPT,
  first_attempt_id: "33333333-3333-4333-8333-333333333333",
  first_traceparent: `00-${TRACE}-b7ad6b7169203331-01`,
  attempt_number: "2",
};

Deno.test("an attempt's event is recorded inside its own span with no link", async () => {
  const { seen, telemetry } = capture();
  await emitAttemptEvent(
    database(first),
    telemetry,
    ORG,
    ATTEMPT,
    "lease.renewed",
    {
      "bakery.attempt.id": ATTEMPT,
    },
  );
  assertEquals(seen, [{
    name: "lease.renewed",
    attributes: { "bakery.attempt.id": ATTEMPT, "bakery.retry.count": 0 },
    trace: {
      context: { traceId: TRACE, spanId: "b7ad6b7169203331", sampled: true },
      links: [],
    },
  }]);
});

Deno.test("a retried attempt links to the first attempt's span and counts the tries before it", async () => {
  const { seen, telemetry } = capture();
  await emitAttemptEvent(
    database(retry),
    telemetry,
    ORG,
    ATTEMPT,
    "attempt.started",
    {
      "bakery.attempt.id": ATTEMPT,
    },
  );
  assertEquals(seen[0].trace, {
    context: { traceId: TRACE, spanId: "c8be7c827a314442", sampled: true },
    links: [{ traceId: TRACE, spanId: "b7ad6b7169203331" }],
  });
  assertEquals(
    (seen[0].attributes as Record<string, unknown>)["bakery.retry.count"],
    1,
  );
});

Deno.test("an attempt claimed before its span was kept still records its event, with no trace", async () => {
  const { seen, telemetry } = capture();
  await emitAttemptEvent(
    database({ ...first, traceparent: null }),
    telemetry,
    ORG,
    ATTEMPT,
    "job.completed",
    { "bakery.attempt.id": ATTEMPT },
  );
  assertEquals(seen, [{
    name: "job.completed",
    attributes: { "bakery.attempt.id": ATTEMPT },
    trace: undefined,
  }]);
});

Deno.test("a failed or missing read costs the trace, never the event", async () => {
  for (const db of [database(undefined), database(first, true), undefined]) {
    const { seen, telemetry } = capture();
    await emitAttemptEvent(db, telemetry, ORG, ATTEMPT, "usage.settled", {
      "bakery.attempt.id": ATTEMPT,
    });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].trace, undefined);
  }
});

Deno.test("with no telemetry nothing is read and nothing throws", async () => {
  let reads = 0;
  const counting = {
    query: () => {
      reads += 1;
      return Promise.resolve({ rows: [] });
    },
  } as never;
  await emitAttemptEvent(
    counting,
    undefined,
    ORG,
    ATTEMPT,
    "lease.renewed",
    {},
  );
  assertEquals(reads, 0);
});

Deno.test("the server telemetry keeps the trace and the link on the record, and drops secrets", async () => {
  const sent: unknown[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      sent.push(...batch);
    },
  });
  await emitAttemptEvent(
    database(retry),
    telemetry,
    ORG,
    ATTEMPT,
    "lease.renewed",
    {
      "bakery.attempt.id": ATTEMPT,
      authorization: "Bearer sk-live-canary",
      "bakery.outcome": "sk-live-canary",
    },
  );
  await telemetry.close(1_000);
  const record = sent[0] as {
    trace: { traceId: string };
    links: { traceId: string; spanId: string }[];
    attributes: Record<string, unknown>;
  };
  assertEquals(record.trace.traceId, TRACE);
  assertEquals(record.links, [{ traceId: TRACE, spanId: "b7ad6b7169203331" }]);
  assertEquals(record.attributes, {
    "bakery.attempt.id": ATTEMPT,
    "bakery.retry.count": 1,
  });
  assert(!JSON.stringify(sent).includes("sk-live-canary"));
});
