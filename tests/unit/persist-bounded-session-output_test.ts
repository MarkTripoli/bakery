import { assert, assertEquals } from "@std/assert";
import {
  assertDescribedSchema,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  OUTPUT_LIMITS,
  OutputBatchSchema,
  OutputPartSchema,
  outputSequenceSchema,
} from "../../packages/contracts/src/output.ts";
Deno.test("output numerical and UTF-8 envelope bounds retain meaningful recursive descriptions", () => {
  for (
    const schema of [
      OutputBatchSchema,
      OutputPartSchema,
      contractSchemas.WorkerOutputOpen,
      contractSchemas.WorkerOutputClose,
      contractSchemas.WorkerOutputBinding,
    ]
  ) assertDescribedSchema(schema);
  for (
    const value of [
      NaN,
      Infinity,
      1.5,
      0,
      -1,
      "0",
      "01",
      "-1",
      "9223372036854775807",
      "9223372036854775808",
    ]
  ) assertEquals(outputSequenceSchema.safeParse(value).success, false);
  assert(outputSequenceSchema.safeParse("1").success);
  const part = {
    itemId: crypto.randomUUID(),
    channel: "stdout",
    text: "é".repeat(8000),
  };
  assert(OutputPartSchema.safeParse(part).success);
  assertEquals(
    OutputPartSchema.safeParse({ ...part, text: part.text + "é" }).success,
    false,
  );
  const base = {
    sessionId: crypto.randomUUID(),
    writerGeneration: "1",
    batchId: crypto.randomUUID(),
    sequence: "1",
    capture: "capturing",
    reason: null,
    digest: "a".repeat(64),
  };
  assertEquals(
    OutputBatchSchema.safeParse({ ...base, parts: [] }).success,
    false,
  );
  assertEquals(
    OutputBatchSchema.safeParse({ ...base, parts: [part, part] }).success,
    false,
  );
  assertEquals(
    OutputBatchSchema.safeParse({
      ...base,
      parts: [part, { ...part, itemId: crypto.randomUUID() }],
    }).success,
    false,
  );
  assertEquals(
    OutputBatchSchema.safeParse({
      ...base,
      parts: Array.from(
        { length: OUTPUT_LIMITS.parts + 1 },
        () => ({ ...part, itemId: crypto.randomUUID(), text: "x" }),
      ),
    }).success,
    false,
  );
  const escaped = { ...part, text: '"'.repeat(16000) };
  assert(OutputPartSchema.safeParse(escaped).success);
  assertEquals(
    OutputBatchSchema.safeParse({ ...base, parts: [escaped] }).success,
    false,
  );
  assertEquals(
    OutputBatchSchema.safeParse({
      ...base,
      parts: [{ ...part, text: "x" }],
      applicationId: crypto.randomUUID(),
    }).success,
    false,
  );
});
