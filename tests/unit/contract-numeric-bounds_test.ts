import { assertEquals, assertThrows } from "@std/assert";
import {
  assertKnownBounds,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";

type Shaped = {
  shape: Record<string, { safeParse(value: unknown): { success: boolean } }>;
};

const field = (schema: string, name: string) =>
  (contractSchemas as unknown as Record<string, Shaped>)[schema].shape[name];

Deno.test("bounds spelled minimum and maximum are enforced like min and max", () => {
  const size = field("BlobUploadStart", "sizeBytes");
  assertEquals(size.safeParse(0).success, true);
  assertEquals(size.safeParse(5_368_709_120).success, true);
  assertEquals(size.safeParse(5_368_709_121).success, false);
  assertEquals(size.safeParse(-1).success, false);
  assertEquals(
    field("WorkerMaintenanceReport", "sequence").safeParse(0).success,
    false,
  );
  assertEquals(
    field("WorkerMaintenanceReport", "sequence").safeParse(1).success,
    true,
  );
});

Deno.test("a bound key the generator does not know is refused loudly", () => {
  const error = assertThrows(
    () => assertKnownBounds({ maximumm: 3 }, "Example.count"),
    Error,
  );
  assertEquals(error.message, "Example.count names an unknown bound: maximumm");
  assertKnownBounds(
    { min: 1, max: 2, minimum: 1, maximum: 2 },
    "Example.count",
  );
});
