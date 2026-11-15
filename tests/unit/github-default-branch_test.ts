import { assertEquals } from "@std/assert";
import { GitHubDefaultBranchSchema } from "../../apps/server/src/modules/integrations/github-app.ts";

// #65: a repository's default branch never fails the page it is listed on.
Deno.test("a default branch GitHub omits, nulls, empties or over-lengthens reads as null", () => {
  const read = (value: unknown) => GitHubDefaultBranchSchema.parse(value);
  assertEquals(read(undefined), null);
  assertEquals(read(null), null);
  assertEquals(read(""), null);
  assertEquals(read("a".repeat(256)), null);
  assertEquals(read("a".repeat(255)), "a".repeat(255));
  assertEquals(read("main"), "main");
  assertEquals(read("release/2026-ünïcode"), "release/2026-ünïcode");
});
