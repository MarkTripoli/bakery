/**
 * #448 S4: the step write limits (O49). The arithmetic that admits or refuses
 * an agent's write, the defaults and bounds, and the refusal as a person reads
 * it: a 409 naming which limit and its value, not the quota's sentence.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  DEFAULT_STORAGE_LIMITS,
  invalidLimit,
  stepWriteLimitRefusal,
  STORAGE_LIMIT_BOUNDS,
} from "../../apps/server/src/modules/knowledge/storage-areas.ts";
import { StandardError, toProblem } from "../../packages/contracts/src/http.ts";

const GIB = 1024 ** 3;
const limits = { stepWriteBytes: 100, stepWriteFiles: 2 };

Deno.test("each step may write up to 2 GiB and 2,000 files by default", () => {
  assertEquals(DEFAULT_STORAGE_LIMITS.stepWriteBytes, 2 * GIB);
  assertEquals(DEFAULT_STORAGE_LIMITS.stepWriteFiles, 2000);
  assertEquals(invalidLimit(DEFAULT_STORAGE_LIMITS), undefined);
  assertEquals(STORAGE_LIMIT_BOUNDS.stepWriteBytes, [1024 * 1024, 1024 * GIB]);
  assertEquals(STORAGE_LIMIT_BOUNDS.stepWriteFiles, [1, 1_000_000]);
  assertEquals(
    invalidLimit({ ...DEFAULT_STORAGE_LIMITS, stepWriteFiles: 0 }),
    "stepWriteFiles",
  );
  assertEquals(
    invalidLimit({ ...DEFAULT_STORAGE_LIMITS, stepWriteBytes: 1024 }),
    "stepWriteBytes",
  );
});

Deno.test("a new entry past the file count is refused; the limit itself is allowed", () => {
  const write = { newEntry: true, addedBytes: 1 };
  assertEquals(
    stepWriteLimitRefusal({ files: 1, bytes: 0 }, write, limits),
    undefined,
  );
  assertEquals(
    stepWriteLimitRefusal({ files: 2, bytes: 0 }, write, limits),
    "files",
  );
  // A folder, move or trash adds no bytes but still counts as an entry.
  assertEquals(
    stepWriteLimitRefusal({ files: 2, bytes: 0 }, {
      newEntry: true,
      addedBytes: 0,
    }, limits),
    "files",
  );
});

Deno.test("rewriting an entry the step already wrote adds no file", () => {
  assertEquals(
    stepWriteLimitRefusal({ files: 2, bytes: 10 }, {
      newEntry: false,
      addedBytes: 10,
    }, limits),
    undefined,
  );
  assertEquals(
    stepWriteLimitRefusal({ files: 2, bytes: 0 }, {
      newEntry: false,
      addedBytes: 0,
    }, limits),
    undefined,
  );
});

Deno.test("bytes past the step's limit are refused; exactly the limit is allowed", () => {
  assertEquals(
    stepWriteLimitRefusal({ files: 0, bytes: 60 }, {
      newEntry: true,
      addedBytes: 40,
    }, limits),
    undefined,
  );
  assertEquals(
    stepWriteLimitRefusal({ files: 0, bytes: 60 }, {
      newEntry: true,
      addedBytes: 41,
    }, limits),
    "bytes",
  );
});

const render = (params: Record<string, unknown>) =>
  toProblem(
    new StandardError({ code: "STEP_WRITE_LIMIT_EXCEEDED", params }),
    { requestId: "r", traceId: "t", publicBaseUrl: "https://bakery.example" },
  ) as unknown as Record<string, unknown>;

Deno.test("the refusal is a 409 naming the limit hit and its value", () => {
  const files = render({ reason: "files", limit: 2000 });
  assertEquals(files.status, 409);
  assertEquals(files.code, "STEP_WRITE_LIMIT_EXCEEDED");
  assertEquals(files.retryable, false);
  assertEquals(files.reason, "files");
  assertEquals(files.limit, 2000);
  assertEquals(
    files.detail,
    "This step stopped because it wrote more than 2,000 files (the limit for one step). An Admin can raise the limit.",
  );
  const bytes = render({ reason: "bytes", limit: 2 * GIB });
  assertEquals(bytes.reason, "bytes");
  assertEquals(bytes.limit, 2 * GIB);
  assertEquals(
    bytes.detail,
    "This step stopped because it wrote more than 2 GB of files (the limit for one step). An Admin can raise the limit.",
  );
  // It must not read as the quota's sentence.
  const quota = toProblem(
    new StandardError({
      code: "STORAGE_QUOTA_EXCEEDED",
      params: { reason: "organization" },
    }),
    { requestId: "r", traceId: "t", publicBaseUrl: "https://bakery.example" },
  ) as unknown as Record<string, unknown>;
  assertNotEquals(bytes.detail, quota.detail);
  assertNotEquals(bytes.title, quota.title);
});
