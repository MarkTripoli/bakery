import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { parseTraceparent } from "../../packages/config/src/telemetry-trace.ts";
import { appendDomainEvent } from "../../packages/persistence/src/event-audit.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { openInstallationFixture } from "../helpers/installation-settings.ts";

// C3 of #23: W3C trace context across the operation, outbox, engine, worker and
// effect boundaries. A durable row is how context survives a restart, so these
// run as the application role against a real Postgres: the role's privileges
// are the ones production has.

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

async function writeEvent(
  f: Fixture,
  traceId: string,
  traceparent?: string,
): Promise<string> {
  return await withPgTransaction(
    f.runtimePgDatabase,
    (transaction) =>
      appendDomainEvent(transaction, {
        organizationId: f.organizationId,
        eventType: "run.requested",
        aggregateId: crypto.randomUUID(),
        aggregateVersion: 1,
        payload: { runId: crypto.randomUUID() },
        traceId,
        traceparent,
      }),
  );
}

async function stored(f: Fixture, eventId: string) {
  const row = await f.runtimePgDatabase.query<
    { traceId: string; traceparent: string | null }
  >(
    `select trace_id as "traceId", traceparent
       from bakery.domain_events where organization_id = $1 and id = $2`,
    [f.organizationId, eventId],
  );
  assertEquals(row.rows.length, 1, "the event is readable as the app role");
  return row.rows[0]!;
}

Deno.test("a domain event written as the application role keeps its span context next to the trace id, and stays append-only", async () => {
  await withFixture(async (f) => {
    // The caller's trace continues in a child span.
    const child = await stored(
      f,
      await writeEvent(f, TRACE, `00-${TRACE}-${CALLER_SPAN}-01`),
    );
    assertEquals(child.traceId, TRACE);
    const childContext = parseTraceparent(child.traceparent);
    assert(childContext, `a valid traceparent is stored: ${child.traceparent}`);
    assertEquals(childContext.traceId, TRACE);
    assertNotEquals(childContext.spanId, CALLER_SPAN);
    assertEquals(childContext.sampled, true);

    // An internal path that minted a dashed UUID: the text is kept, the span is valid.
    const dashed = crypto.randomUUID();
    const internal = await stored(f, await writeEvent(f, dashed));
    assertEquals(internal.traceId, dashed);
    assert(parseTraceparent(internal.traceparent), "a fresh trace was stored");

    // The new column did not widen what the role may do to the table.
    await assertRejects(
      () =>
        f.runtimePgDatabase.query(
          `update bakery.domain_events set traceparent = null where organization_id = $1`,
          [f.organizationId],
        ),
      Error,
      "permission denied",
    );
  });
});
