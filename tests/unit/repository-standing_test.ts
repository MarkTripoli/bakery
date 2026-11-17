import { assertEquals } from "@std/assert";
import {
  type RepositoryStanding,
  repositoryStanding,
} from "../../apps/server/src/modules/projects/repository-standing.ts";

/** The page's words, which the list must never contradict (#65). */
const WORDS: Record<RepositoryStanding, string> = {
  not_set_up: "Not set up",
  check_needed: "Check needed",
  check_failed: "Check failed",
  ready: "Ready",
  archived: "Archived",
};

const of = (input: Parameters<typeof repositoryStanding>[0]) =>
  WORDS[repositoryStanding(input)];

Deno.test("the row's word follows the page's rule for every state (#65)", () => {
  // No version in use: the repository is not set up.
  assertEquals(
    of({
      archived: false,
      hasActiveVersion: false,
      activeIsCheckMade: false,
      checkPassed: false,
    }),
    "Not set up",
  );
  // A person's save has no check of its own yet, passed or not.
  assertEquals(
    of({
      archived: false,
      hasActiveVersion: true,
      activeIsCheckMade: false,
      checkPassed: false,
    }),
    "Check needed",
  );
  assertEquals(
    of({
      archived: false,
      hasActiveVersion: true,
      activeIsCheckMade: false,
      checkPassed: true,
    }),
    "Check needed",
  );
  // A check-made version in use answers by its check.
  assertEquals(
    of({
      archived: false,
      hasActiveVersion: true,
      activeIsCheckMade: true,
      checkPassed: true,
    }),
    "Ready",
  );
  assertEquals(
    of({
      archived: false,
      hasActiveVersion: true,
      activeIsCheckMade: true,
      checkPassed: false,
    }),
    "Check failed",
  );
});

Deno.test("a retired repository says archived whatever its evidence was (#65)", () => {
  for (
    const input of [
      { hasActiveVersion: false, activeIsCheckMade: false, checkPassed: false },
      { hasActiveVersion: true, activeIsCheckMade: true, checkPassed: true },
      { hasActiveVersion: true, activeIsCheckMade: true, checkPassed: false },
    ]
  ) {
    assertEquals(of({ ...input, archived: true }), "Archived");
  }
});

Deno.test("every state has a word, so the list never renders an empty badge (#65)", () => {
  assertEquals(Object.keys(WORDS).length, 5);
  for (const word of Object.values(WORDS)) {
    assertEquals(word.trim().length > 0, true);
  }
});
