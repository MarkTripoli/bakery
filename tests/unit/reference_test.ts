import { assertEquals } from "@std/assert";
import { shortReference } from "../../packages/ui/src/molecules/reference-short.ts";

Deno.test("a commit shows 7 characters, a release, task and run 8, and the whole id stays in the card", () => {
  const sha = "4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6";
  assertEquals(shortReference("commit", sha), "4f2a9c1");
  assertEquals(shortReference("release", sha), "4f2a9c1e");
  assertEquals(shortReference("task", sha), "4f2a9c1e");
  assertEquals(shortReference("run", sha), "4f2a9c1e");
});

Deno.test("numbers and names are shown as they are", () => {
  assertEquals(shortReference("pullRequest", "#123"), "#123");
  assertEquals(shortReference("issue", "#9"), "#9");
  assertEquals(shortReference("machine", "build-box-2"), "build-box-2");
  assertEquals(shortReference("person", "ana"), "ana");
});

Deno.test("a short value is not padded or cut", () => {
  assertEquals(shortReference("commit", "abc"), "abc");
});
