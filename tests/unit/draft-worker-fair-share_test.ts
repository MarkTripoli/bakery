import { assertEquals, assertThrows } from "@std/assert";
import { toProblem } from "../../packages/contracts/src/http.ts";
import { readDraftWorkerPoolSize } from "../../packages/config/src/env.ts";
import {
  createDraftWorkerLimiter,
  DRAFT_WORKER_REFUSAL_MESSAGES,
  DraftIsolationError,
  workerRefusalParams,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

Deno.test("one organization holds at most half the pool, and the rest stays for others", () => {
  const limiter = createDraftWorkerLimiter(4);
  assertEquals(limiter.organizationShare, 2);
  assertEquals(limiter.tryAcquire("a"), undefined);
  assertEquals(limiter.tryAcquire("a"), undefined);
  assertEquals(limiter.tryAcquire("a"), "share");
  // Another organization still gets workers while "a" holds its share.
  assertEquals(limiter.tryAcquire("b"), undefined);
  assertEquals(limiter.tryAcquire("b"), undefined);
  // Now the pool itself is full: every caller hears "pool".
  assertEquals(limiter.tryAcquire("c"), "pool");
  assertEquals(limiter.tryAcquire("a"), "pool");
  assertEquals(limiter.tryAcquire(), "pool");
  assertEquals(limiter.active, 4);
  // A refusal takes nothing; releases give the share back.
  limiter.release("a");
  assertEquals(limiter.tryAcquire("a"), undefined);
  for (const owner of ["a", "a", "b", "b"]) limiter.release(owner);
  assertEquals(limiter.active, 0);
  assertEquals(limiter.tryAcquire("a"), undefined);
  assertEquals(limiter.tryAcquire("a"), undefined);
});

Deno.test("the share is half the pool rounded up, and never zero", () => {
  for (const [max, share] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [8, 4]]) {
    assertEquals(
      createDraftWorkerLimiter(max!).organizationShare,
      share,
      `${max}`,
    );
  }
  // With a pool of one, the only worker is anyone's: no starvation guarantee
  // is possible, but the pool still bounds memory.
  const one = createDraftWorkerLimiter(1);
  assertEquals(one.tryAcquire("a"), undefined);
  assertEquals(one.tryAcquire("b"), "pool");
});

Deno.test("unscoped calls count toward the pool only", () => {
  const limiter = createDraftWorkerLimiter(2);
  assertEquals(limiter.tryAcquire(), undefined);
  assertEquals(limiter.tryAcquire(), undefined);
  assertEquals(limiter.tryAcquire(), "pool");
  limiter.release();
  limiter.release();
  assertEquals(limiter.active, 0);
});

Deno.test("the pool size is configurable and validated", () => {
  assertEquals(readDraftWorkerPoolSize({}), undefined);
  assertEquals(
    readDraftWorkerPoolSize({ BAKERY_DRAFT_WORKER_POOL_SIZE: "" }),
    undefined,
  );
  assertEquals(
    readDraftWorkerPoolSize({ BAKERY_DRAFT_WORKER_POOL_SIZE: "8" }),
    8,
  );
  for (const bad of ["0", "-1", "1.5", "100", "four", "08"]) {
    assertThrows(
      () => readDraftWorkerPoolSize({ BAKERY_DRAFT_WORKER_POOL_SIZE: bad }),
      Error,
      "DRAFT_WORKER_POOL_SIZE_INVALID",
      bad,
    );
  }
});

Deno.test("a refused slot is a retryable 503 that names its cause and nothing else", () => {
  const render = (error: DraftIsolationError) =>
    toProblem(
      new StandardError({
        code: "DEPENDENCY_UNAVAILABLE",
        cause: error,
        ...workerRefusalParams(error),
      }),
      { requestId: "r", traceId: "t", publicBaseUrl: "https://bakery.example" },
    ) as unknown as Record<string, unknown>;
  const pool = render(
    new DraftIsolationError("unavailable", DRAFT_WORKER_REFUSAL_MESSAGES.pool),
  );
  assertEquals(pool.status, 503);
  assertEquals(pool.retryable, true);
  assertEquals(pool.reason, "draft_worker_pool_busy");
  assertEquals(pool.retryAfterSeconds, 1);
  const share = render(
    new DraftIsolationError("unavailable", DRAFT_WORKER_REFUSAL_MESSAGES.share),
  );
  assertEquals(share.reason, "draft_worker_organization_share_used");
  // Any other unavailable isolation failure carries no reason.
  const other = render(new DraftIsolationError("unavailable", "WORKER_EXIT_1"));
  assertEquals(other.reason, undefined);
  assertEquals(other.retryAfterSeconds, undefined);
  // The renderer itself only passes the allowlisted reasons through.
  const forged = toProblem(
    new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason: "org_b_is_busy_with_secret_project" },
    }),
    { requestId: "r", traceId: "t", publicBaseUrl: "https://bakery.example" },
  ) as unknown as Record<string, unknown>;
  assertEquals(forged.reason, undefined);
});
