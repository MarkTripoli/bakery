import { assertEquals } from "@std/assert";
import {
  fileChanges,
  shortRevision,
} from "../../apps/web/src/pages/library/skill-update-state.ts";

const change = {
  path: "SKILL.md",
  change: "changed",
  installedSha256: "a".repeat(64),
  latestSha256: "b".repeat(64),
  installedSizeBytes: 10,
  latestSizeBytes: 12,
  diff: "-a\n+b",
  diffOmitted: null,
};

Deno.test("only entries with the file change shape are listed", () => {
  assertEquals<unknown>(
    fileChanges([change, "SKILL.md", null, { ...change, change: "moved" }]),
    [change],
  );
});

Deno.test("a commit or digest is shortened and a branch is not", () => {
  assertEquals(shortRevision("a".repeat(40)), "aaaaaaa");
  assertEquals(shortRevision("sha256:" + "b".repeat(64)), "bbbbbbb");
  assertEquals(shortRevision("main"), "main");
});
