import { assert, assertEquals, assertRejects } from "@std/assert";
import { Hono } from "hono";
import {
  problemResponse,
  StandardError,
  toProblem,
} from "../../packages/contracts/src/http.ts";
import {
  assertNotQuiesced,
  DRAIN_SETTLE_SECONDS,
  drainDecision,
  effectiveMaintenanceState,
  isQuiesced,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  maintenanceIsActive,
  maintenanceRetryAfter,
  MaintenanceState,
} from "../../apps/server/src/platform/maintenance.ts";

// #64 slice B: the maintenance switch's pure rules and its shared guard.

const now = new Date("2026-11-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

Deno.test("the switch is active only while its state is not off and its lease is in the future", () => {
  const lease = (state: string, offsetMs: number) => ({
    state,
    leaseExpiresAt: at(offsetMs),
  });
  assert(maintenanceIsActive(lease("draining", 1), now));
  assert(maintenanceIsActive(lease("quiesced", 60_000), now));
  // A lease that ends exactly now has lapsed; so has one in the past.
  assert(!maintenanceIsActive(lease("draining", 0), now));
  assert(!maintenanceIsActive(lease("quiesced", -1), now));
  assert(!maintenanceIsActive(lease("quiesced", -3_600_000), now));
  // Off is never active, however long its lease; no row is not active.
  assert(!maintenanceIsActive(lease("off", 60_000), now));
  assert(!maintenanceIsActive(null, now));
  // A state the rules do not know is not a reason to refuse work.
  assert(!maintenanceIsActive(lease("paused", 60_000), now));
});

Deno.test("a lapsed lease reads as off with no action from anyone", () => {
  const draining = { state: "draining", leaseExpiresAt: at(10_000) };
  assertEquals(effectiveMaintenanceState(draining, now), "draining");
  assertEquals(effectiveMaintenanceState(draining, at(9_999)), "draining");
  // The same stored row, read after its lease ended: off.
  assertEquals(effectiveMaintenanceState(draining, at(10_000)), "off");
  assertEquals(effectiveMaintenanceState(draining, at(86_400_000)), "off");
  assertEquals(
    effectiveMaintenanceState(
      { state: "quiesced", leaseExpiresAt: at(5_000) },
      at(5_001),
    ),
    "off",
  );
  assertEquals(effectiveMaintenanceState(null, now), MaintenanceState.Off);
});

Deno.test("the retry hint is the usual interval, shorter when the lease ends sooner, never under one", () => {
  const row = (offsetMs: number) => ({
    state: "quiesced",
    leaseExpiresAt: at(offsetMs),
  });
  assertEquals(
    maintenanceRetryAfter(row(10 * 60_000), now),
    MAINTENANCE_RETRY_AFTER_SECONDS,
  );
  assertEquals(maintenanceRetryAfter(row(12_000), now), 12);
  assertEquals(maintenanceRetryAfter(row(12_001), now), 13);
  assertEquals(maintenanceRetryAfter(row(1), now), 1);
  assertEquals(maintenanceRetryAfter(row(0), now), 1);
});

Deno.test("drained needs nothing live and the settle window to have passed", () => {
  const settle = DRAIN_SETTLE_SECONDS * 1000;
  const idle = { liveAttempts: 0, openTransactions: 0 };
  // Quiet from the first look, but the window has not passed.
  const early = drainDecision({
    enteredAt: now,
    now,
    observation: idle,
  });
  assertEquals(early.drained, false);
  assertEquals(early.waitSeconds, DRAIN_SETTLE_SECONDS);
  // Exactly at the window: drained.
  assertEquals(
    drainDecision({ enteredAt: now, now: at(settle), observation: idle })
      .drained,
    true,
  );
  assertEquals(
    drainDecision({ enteredAt: now, now: at(settle - 1), observation: idle })
      .drained,
    false,
  );
  // A live attempt or an open transaction blocks it however long it has waited.
  for (
    const busy of [
      { liveAttempts: 1, openTransactions: 0 },
      { liveAttempts: 0, openTransactions: 1 },
      { liveAttempts: 3, openTransactions: 2 },
    ]
  ) {
    const decision = drainDecision({
      enteredAt: now,
      now: at(10 * 60_000),
      observation: busy,
    });
    assertEquals(decision.drained, false, JSON.stringify(busy));
    assert(decision.waitSeconds > 0);
  }
  // Drained means nothing left to wait for.
  assertEquals(
    drainDecision({ enteredAt: now, now: at(settle), observation: idle })
      .waitSeconds,
    0,
  );
});

type Row = { state: string; leaseExpiresAt: Date; now: Date };
function transactionWith(row: Row | null) {
  const queries: string[] = [];
  return {
    queries,
    transaction: {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({
          rows: row === null ? [] : [row],
          rowCount: row === null ? 0 : 1,
        });
      },
    } as never,
  };
}

Deno.test("the guard lets work through while the switch is off, absent or lapsed", async () => {
  for (
    const row of [
      null,
      { state: "off", leaseExpiresAt: at(60_000), now },
      { state: "draining", leaseExpiresAt: at(-1), now },
      { state: "quiesced", leaseExpiresAt: now, now },
    ]
  ) {
    const { transaction, queries } = transactionWith(row);
    await assertNotQuiesced(transaction, "intake");
    // One read: the switch row, and whether a restore holds the installation.
    assertEquals(queries.length, 1);
    assert(queries[0].includes("bakery.installation_maintenance"));
  }
});

Deno.test("the guard refuses while draining or quiesced with a retryable 503", async () => {
  for (const state of ["draining", "quiesced"]) {
    const { transaction } = transactionWith({
      state,
      leaseExpiresAt: at(20_000),
      now,
    });
    const error = await assertRejects(
      () => assertNotQuiesced(transaction, "intake"),
      StandardError,
    );
    assertEquals(error.code, "INSTALLATION_QUIESCED");
    const problem = toProblem(error, {
      publicBaseUrl: "https://bakery.example",
      requestId: "request-1",
      traceId: "trace-1",
      locale: "en",
    });
    assertEquals(problem.status, 503);
    assertEquals(problem.retryable, true);
    assertEquals(problem.code, "INSTALLATION_QUIESCED");
    assertEquals(problem.retryAfterSeconds, 20);
  }
});

Deno.test("the problem response carries Retry-After for the quiesced code and for no other", async () => {
  const app = new Hono();
  app.get("/quiesced", (context) =>
    problemResponse(
      context,
      new StandardError({
        code: "INSTALLATION_QUIESCED",
        params: { retryAfterSeconds: 17 },
      }),
      { publicBaseUrl: "https://bakery.example" },
    ));
  app.get("/other", (context) =>
    problemResponse(
      context,
      new StandardError({
        code: "DEPENDENCY_UNAVAILABLE",
        params: { retryAfterSeconds: 9 },
      }),
      { publicBaseUrl: "https://bakery.example" },
    ));
  const quiesced = await app.request("/quiesced");
  assertEquals(quiesced.status, 503);
  assertEquals(quiesced.headers.get("retry-after"), "17");
  assertEquals(
    (await quiesced.json() as { code: string }).code,
    "INSTALLATION_QUIESCED",
  );
  // Other codes answer as before: no new header.
  const other = await app.request("/other");
  assertEquals(other.status, 503);
  assertEquals(other.headers.get("retry-after"), null);
  await other.body?.cancel();
});

// #64 slice E: a restore holds the installation until an administrator releases
// it. The same single read answers both questions.
const restoring = (row: Row | null, held: boolean) => {
  const { transaction, queries } = transactionWith(row);
  const original = (transaction as unknown as {
    query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
  }).query;
  (transaction as unknown as { query: typeof original }).query = async (
    sql: string,
  ) => {
    const result = await original(sql);
    return {
      ...result,
      rows: [{
        ...(row ?? { state: null, leaseExpiresAt: null, now }),
        restoreHeld: held,
      }],
    };
  };
  return { transaction, queries };
};

Deno.test("a restore hold refuses with a non-retryable 503, in one read, and reads only", async () => {
  for (const row of [null, { state: "off", leaseExpiresAt: at(60_000), now }]) {
    const { transaction, queries } = restoring(row, true);
    const error = await assertRejects(() =>
      assertNotQuiesced(transaction, "intake")
    );
    assert(error instanceof StandardError);
    assertEquals(error.code, "INSTALLATION_RESTORING");
    assertEquals(error.params?.retryAfterSeconds, undefined);
    assertEquals(queries.length, 1);
    assert(queries[0].includes("bakery.installation_restores"));
    assert(!/\b(insert|update|delete)\b/i.test(queries[0]));
  }
});

Deno.test("a restore hold wins over a backup hold, and a released restore changes nothing", async () => {
  const both = restoring(
    { state: "quiesced", leaseExpiresAt: at(20_000), now },
    true,
  );
  const error = await assertRejects(() =>
    assertNotQuiesced(both.transaction, "intake")
  );
  assert(error instanceof StandardError);
  assertEquals(error.code, "INSTALLATION_RESTORING");

  // Released: only the backup switch decides, as before.
  const released = restoring(
    { state: "off", leaseExpiresAt: at(60_000), now },
    false,
  );
  await assertNotQuiesced(released.transaction, "intake");
  const backupOnly = restoring(
    { state: "quiesced", leaseExpiresAt: at(20_000), now },
    false,
  );
  const quiesced = await assertRejects(() =>
    assertNotQuiesced(backupOnly.transaction, "intake")
  );
  assert(quiesced instanceof StandardError);
  assertEquals(quiesced.code, "INSTALLATION_QUIESCED");
});

Deno.test("the non-throwing check treats a restore hold as held", async () => {
  assertEquals(
    await isQuiesced(
      restoring({ state: "off", leaseExpiresAt: at(60_000), now }, true)
        .transaction,
      "intake",
    ),
    true,
  );
  assertEquals(
    await isQuiesced(
      restoring({ state: "off", leaseExpiresAt: at(60_000), now }, false)
        .transaction,
      "intake",
    ),
    false,
  );
});
