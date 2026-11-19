import { assertEquals, assertRejects } from "@std/assert";
import type { PgDatabase } from "@bakery/persistence";
import {
  completeStoragePurgeRequests,
  STORAGE_PURGE_MAX_REQUESTS,
  validPurgeBatchSize,
} from "../../apps/server/src/modules/knowledge/storage-record-purge.ts";

Deno.test("purge batch sizes are bounded positive integers", () => {
  assertEquals(
    [1, STORAGE_PURGE_MAX_REQUESTS, 10_000].map(validPurgeBatchSize),
    [true, true, true],
  );
  assertEquals(
    [0, -1, 10_001, 1.5, Number.NaN].map(validPurgeBatchSize),
    [false, false, false, false, false],
  );
});

Deno.test("an invalid batch size is refused before any query", async () => {
  const database = {
    query: () => {
      throw new Error("must not query");
    },
  } as unknown as PgDatabase;
  await assertRejects(
    () => completeStoragePurgeRequests(database, 0),
    Error,
    "STORAGE_PURGE_LIMIT_INVALID",
  );
});
