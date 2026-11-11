import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../packages/persistence/src/postgres.ts";

function poolFixture(rollbackError?: Error) {
  const released: Array<Error | undefined> = [];
  let commits = 0;
  let rollbacks = 0;
  let queries = 0;
  const pool = {
    connect: () =>
      Promise.resolve({
        query(statement: string) {
          queries++;
          if (statement === "commit") commits++;
          if (statement === "rollback") {
            rollbacks++;
            if (rollbackError) return Promise.reject(rollbackError);
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release(error?: Error) {
          released.push(error);
        },
      }),
  } as unknown as PgDatabase;
  return { pool, released, counts: () => ({ commits, rollbacks, queries }) };
}

Deno.test("successful non-aborted transactions keep their pooled connection reusable", async () => {
  const fixture = poolFixture();
  const result = await withPgTransaction(
    fixture.pool,
    () => Promise.resolve("committed"),
    new AbortController().signal,
  );
  assertEquals(result, "committed");
  assertEquals(fixture.counts().commits, 1);
  assertEquals(fixture.released, [undefined]);
});

Deno.test("abort after a settled query rolls back and discards the backend", async () => {
  const fixture = poolFixture();
  const abort = new AbortController();
  const error = await assertRejects(() =>
    withPgTransaction(fixture.pool, async (tx) => {
      await tx.query("select 1");
      abort.abort();
    }, abort.signal)
  );
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(fixture.counts().commits, 0);
  assertEquals(fixture.counts().rollbacks, 1);
  assertEquals(fixture.released.length, 1);
  assertEquals(fixture.released[0]?.name, "AbortError");
});

Deno.test("already aborted work never starts and its connection is discarded", async () => {
  const fixture = poolFixture();
  const abort = new AbortController();
  abort.abort();
  let invoked = false;
  await assertRejects(() =>
    withPgTransaction(fixture.pool, () => {
      invoked = true;
      return Promise.resolve();
    }, abort.signal)
  );
  assertEquals(invoked, false);
  assertEquals(fixture.counts().queries, 0);
  assertEquals(fixture.released[0]?.name, "AbortError");
});

Deno.test("rollback failure keeps its discard reason without replacing the work error", async () => {
  const rollbackError = new Error("ROLLBACK_FAILED");
  const fixture = poolFixture(rollbackError);
  const abort = new AbortController();
  const workError = new Error("WORK_FAILED");
  const error = await assertRejects(() =>
    withPgTransaction(fixture.pool, () => {
      abort.abort();
      return Promise.reject(workError);
    }, abort.signal)
  );
  assertEquals(error, workError);
  assertEquals(fixture.released, [rollbackError]);
});
