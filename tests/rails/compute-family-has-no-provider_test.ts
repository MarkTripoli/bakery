import { assertEquals } from "@std/assert";
import {
  COMPUTE_PROVIDERS,
  USAGE_RECORD_KINDS,
} from "../../packages/integration-sdk/mod.ts";

// #428 part 3 (chapter 25 section 8, O22): the compute family exists as a
// contract and nothing serves it. Adding the first provider is an owner
// decision, so this rail fails until someone changes it on purpose.

Deno.test("the compute family has no provider in v1", () => {
  assertEquals(COMPUTE_PROVIDERS.length, 0);
});

Deno.test("the usage ledger names a compute kind beside model usage", () => {
  assertEquals([...USAGE_RECORD_KINDS], ["model", "compute"]);
});

Deno.test("the model path names its kind and the ledger migration states no rule", async () => {
  const root = new URL("../../apps/server/src/modules/work/", import.meta.url);
  const sql = await Deno.readTextFile(
    new URL("migrations/bakery/0351_usage_records_kind.sql", root),
  );
  assertEquals(/\bcheck\s*\(/i.test(sql), false);
  const budget = await Deno.readTextFile(new URL("budget.ts", root));
  assertEquals(budget.includes("provenance, kind,"), true);
  assertEquals(budget.includes("$31, 'model', now()"), true);
});
