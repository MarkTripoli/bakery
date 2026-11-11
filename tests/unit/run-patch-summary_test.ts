import { assertEquals } from "@std/assert";
import { summarizePatch } from "../../apps/web/src/pages/patch-summary.ts";
Deno.test("unified hunk counts preserve added plus and removed minus content", () => {
  assertEquals(
    summarizePatch(
      "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n---counter;\n+++counter;\n context\n",
    ),
    { files: 1, added: 1, removed: 1 },
  );
});
Deno.test("git patches count multiple files and zero-line insertion hunks", () => {
  assertEquals(
    summarizePatch(
      "diff --git a/one b/one\n--- /dev/null\n+++ b/one\n@@ -0,0 +1 @@\n+first\n\\ No newline at end of file\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-old\n+new\n",
    ),
    { files: 2, added: 2, removed: 1 },
  );
});
Deno.test("unsupported or incomplete patches never invent a diff summary", () => {
  for (
    const patch of [
      "binary patch",
      "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-only\n+one",
      "@@ -1 +1 @@\n-a\n+b",
      "--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n-invalid\n",
    ]
  ) assertEquals(summarizePatch(patch), null);
});

Deno.test("mixed binary, rename-only and mode-only sections suppress aggregate counts", () => {
  const text =
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
  for (
    const suffix of [
      "diff --git a/logo b/logo\nBinary files a/logo and b/logo differ",
      "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new",
      "diff --git a/mode b/mode\nold mode 100644\nnew mode 100755",
    ]
  ) assertEquals(summarizePatch(text + suffix), null);
});
