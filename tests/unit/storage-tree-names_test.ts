import { assertEquals, assertThrows } from "@std/assert";
import {
  normalizeEntryName,
  parseStoragePath,
  StorageNameError,
  workItemFolderName,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

// #444: a path is a name, not an identity. Names are unique per folder, compared
// case-insensitively after normalization; these are the rules for that.

Deno.test("names compare case-insensitively after Unicode normalization", () => {
  const composed = normalizeEntryName("Café");
  const decomposed = normalizeEntryName("Café");
  assertEquals(composed.name, decomposed.name);
  assertEquals(composed.nameKey, decomposed.nameKey);
  assertEquals(normalizeEntryName("  Plan.MD ").nameKey, "plan.md");
  assertEquals(normalizeEntryName("Plan.md").name, "Plan.md");
});

Deno.test("empty, dot, separator and control names are refused", () => {
  for (
    const bad of [
      "",
      "   ",
      ".",
      "..",
      "a/b",
      "tab\there",
      "nul\u0000",
      "x".repeat(256),
    ]
  ) {
    assertThrows(() => normalizeEntryName(bad), StorageNameError);
  }
});

Deno.test("a path must be absolute and every segment must be a valid name", () => {
  assertEquals(parseStoragePath("/"), []);
  assertThrows(() => parseStoragePath("projects/x"), StorageNameError);
  assertThrows(() => parseStoragePath("/projects/../x"), StorageNameError);
  assertThrows(() => parseStoragePath("/projects//x"), StorageNameError);
  assertEquals(
    parseStoragePath("/projects/Bakery").map((segment) => segment.nameKey),
    ["projects", "bakery"],
  );
});

Deno.test("a work item's folder name is a readable slug plus its short id", () => {
  const id = "1a2b3c4d-0000-4000-8000-000000000000";
  assertEquals(
    workItemFolderName("Fix: upload retry!", id),
    "fix-upload-retry-1a2b3c4d",
  );
  assertEquals(workItemFolderName("   ", id), "work-item-1a2b3c4d");
  assertEquals(workItemFolderName("Ünï cödé", id), "uni-code-1a2b3c4d");
});
