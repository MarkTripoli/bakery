import { assertEquals } from "@std/assert";
import {
  branchesOf,
  canonicalJson,
  configDigest,
  folderOf,
  hasOwnRules,
  isCheckMade,
  needsCheck,
  nextRevision,
  parseBranches,
  settingsConfig,
  settingsProblem,
  setupBadge,
} from "../../apps/web/src/pages/projects/repository-state.ts";
import {
  canonicalJson as serverCanonical,
  sha256Hex,
} from "../../packages/contracts/src/workflow-compiler/canonical.ts";

Deno.test("the badges known without a check are Archived and Not set up", () => {
  assertEquals(
    setupBadge({ archivedAt: "x", activeProfileId: "p" }),
    "archived",
  );
  assertEquals(
    setupBadge({ archivedAt: null, activeProfileId: null }),
    "notSetUp",
  );
  assertEquals(setupBadge({ archivedAt: null, activeProfileId: "p" }), null);
});

Deno.test("branches are one per line, trimmed, without blanks or repeats", () => {
  assertEquals(parseBranches(" main\n\nrelease/*\r\nmain\n  \n"), [
    "main",
    "release/*",
  ]);
  assertEquals(parseBranches(""), []);
});

Deno.test("working settings are checked the way the server will", () => {
  assertEquals(settingsProblem([], ""), "branches");
  assertEquals(settingsProblem(["main"], ""), null);
  assertEquals(settingsProblem(["main"], "/abs"), "folder");
  assertEquals(settingsProblem(["main"], "a/../b"), "folder");
  assertEquals(settingsProblem(["main"], "packages/web"), null);
  assertEquals(
    settingsProblem(Array.from({ length: 33 }, (_, i) => `b${i}`), ""),
    "tooMany",
  );
  assertEquals(settingsProblem(["x".repeat(256)], ""), "tooLong");
});

Deno.test("new settings keep everything else a version holds, and a first one is the fixed default", () => {
  const first = settingsConfig(null, {
    base: "main",
    branches: ["main"],
    folder: "",
  });
  assertEquals(first, {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["main"] },
    worktree: { root: "." },
  });
  assertEquals(branchesOf(first), ["main"]);
  assertEquals(folderOf(first), "");
  const earlier = { ...first, agentBindings: { "harness.implement": "a" } };
  const next = settingsConfig(earlier, {
    base: "main",
    branches: ["main", "release/*"],
    folder: "app",
  });
  assertEquals((next as { agentBindings: unknown }).agentBindings, {
    "harness.implement": "a",
  });
  assertEquals(folderOf(next), "app");
});

Deno.test("the next version number is one more than the highest", () => {
  const profile = (revision: number) => ({ revision }) as never;
  assertEquals(nextRevision([]), 1);
  assertEquals(nextRevision([profile(1), profile(4), profile(2)]), 5);
});

Deno.test("the digest is the server's canonical-JSON SHA-256", async () => {
  const config = {
    worktree: { root: "." },
    schemaVersion: 1,
    branches: { allowedPatterns: ["main", "r/*"], base: "main" },
    workflow: { kind: "fixed" },
  };
  assertEquals(canonicalJson(config), serverCanonical(config));
  assertEquals(
    await configDigest(config),
    await sha256Hex(serverCanonical(config)),
  );
});

Deno.test("a control character in a branch or a folder is refused before anything is sent", () => {
  assertEquals(settingsProblem(["main\u0000x"], ""), "characters");
  assertEquals(settingsProblem(["a\u007fb"], ""), "characters");
  assertEquals(settingsProblem(["main"], "sub\u0000dir"), "folder");
  assertEquals(settingsProblem(["main", "release/*"], "sub/dir"), null);
});

Deno.test("a version that states rules of its own is told apart, even with no entries", () => {
  assertEquals(hasOwnRules({ repositoryRules: { entries: [] } }), true);
  assertEquals(hasOwnRules({ schemaVersion: 1 }), false);
  assertEquals(hasOwnRules(null), false);
});

Deno.test("a version made by a check is told apart from a person's", () => {
  assertEquals(isCheckMade({ schemaVersion: 2, checkPolicy: {} }), true);
  assertEquals(isCheckMade({ schemaVersion: 1, checkPolicy: {} }), true);
  assertEquals(isCheckMade({ schemaVersion: 1 }), false);
  assertEquals(isCheckMade(null), false);
});

Deno.test("a check is needed only when a person's version is in use and a check made an earlier one", () => {
  const person = { config: { schemaVersion: 1 } };
  const check = { config: { schemaVersion: 2, checkPolicy: {} } };
  assertEquals(needsCheck(person, [person, check]), true);
  // The check-made version in use is its own evidence.
  assertEquals(needsCheck(check, [person, check]), false);
  // Never checked: nothing to be stale.
  assertEquals(needsCheck(person, [person]), false);
  assertEquals(needsCheck(null, [check]), false);
});

Deno.test("a saved config never states the rules in force: the server keeps them", () => {
  const next = settingsConfig({
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["main"] },
    worktree: { root: "." },
    repositoryRules: { entries: [{ ruleKey: "commits.format" }] },
  }, { base: "main", branches: ["main", "dev"], folder: "" });
  assertEquals("repositoryRules" in next, false);
  assertEquals(
    (next.branches as { allowedPatterns: string[] }).allowedPatterns,
    ["main", "dev"],
  );
});
