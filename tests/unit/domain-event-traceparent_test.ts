import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  formatTraceparent,
  parseTraceparent,
} from "../../packages/config/src/telemetry-trace.ts";
import { appendDomainEvent } from "../../packages/persistence/src/event-audit.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";

// C3 of #23: a domain event is the durable carrier between the operation that
// wrote it and the engine that runs later, so it stores the span context as
// well as the trace id. `trace_id` keeps meaning "the run's correlation key";
// `traceparent` is the writer's span, and the two must name the same trace.

function recorder() {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const transaction = {
    query: (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("event_clock")) {
        return Promise.resolve({ rows: [{ sequence: "1" }], rowCount: 1 });
      }
      if (sql.includes("insert into bakery.domain_events")) {
        return Promise.resolve({
          rows: [{ id: crypto.randomUUID() }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  return { calls, transaction };
}

async function written(
  overrides: { traceId: string; traceparent?: string },
) {
  const { calls, transaction } = recorder();
  await appendDomainEvent(transaction, {
    organizationId: crypto.randomUUID(),
    eventType: "run.requested",
    aggregateId: crypto.randomUUID(),
    aggregateVersion: 1,
    payload: { runId: crypto.randomUUID() },
    ...overrides,
  });
  const insert = calls.find((call) =>
    call.sql.includes("insert into bakery.domain_events")
  );
  assert(insert, "the event was inserted");
  return insert;
}

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

Deno.test("a domain event stores the writer's span next to the trace id, in the same trace", async () => {
  const insert = await written({ traceId: TRACE });
  assert(
    /\btrace_id,\s*traceparent\b/.test(insert.sql),
    "the insert names the traceparent column",
  );
  assertEquals(insert.params[12], TRACE, "trace_id is stored unchanged");
  const stored = parseTraceparent(String(insert.params[13]));
  assert(stored, `a valid traceparent was stored: ${insert.params[13]}`);
  assertEquals(stored.traceId, TRACE);
  assertEquals(stored.sampled, true);
});

Deno.test("a caller's traceparent makes the stored span its child, keeping its sampling decision", async () => {
  for (const [flags, sampled] of [["01", true], ["00", false]] as const) {
    const insert = await written({
      traceId: TRACE,
      traceparent: `00-${TRACE}-${CALLER_SPAN}-${flags}`,
    });
    const stored = parseTraceparent(String(insert.params[13]));
    assert(stored);
    assertEquals(stored.traceId, TRACE);
    assertNotEquals(stored.spanId, CALLER_SPAN, "the event is its own span");
    assertEquals(stored.sampled, sampled, flags);
  }
});

Deno.test("a trace id that is not a trace id, as the internal paths mint, is stored as it is and still gets a valid span", async () => {
  const dashed = crypto.randomUUID();
  const insert = await written({ traceId: dashed });
  assertEquals(insert.params[12], dashed, "trace_id text is never rewritten");
  const stored = parseTraceparent(String(insert.params[13]));
  assert(stored, "a fresh, valid trace context was stored");
  assertNotEquals(stored.traceId, dashed.replaceAll("-", ""));
  assertEquals(
    String(insert.params[13]),
    formatTraceparent(stored),
    "what is stored is exactly the version-00 header",
  );
});

Deno.test("a traceparent that cannot be a parent is ignored, and never stored", async () => {
  for (
    const bad of [
      "",
      "garbage",
      `00-${"0".repeat(32)}-${CALLER_SPAN}-01`,
      `00-11111111111111111111111111111111-${CALLER_SPAN}-01`,
    ]
  ) {
    const insert = await written({ traceId: TRACE, traceparent: bad });
    const stored = parseTraceparent(String(insert.params[13]));
    assert(stored, bad);
    assertEquals(stored.traceId, TRACE, `trace id follows trace_id for ${bad}`);
    assertNotEquals(String(insert.params[13]), bad);
  }
});
