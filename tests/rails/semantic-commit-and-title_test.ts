import { assert, assertEquals } from "@std/assert";
import {
  isSemanticCommitSubject,
  isSemanticPullRequestTitle,
  isSemanticTitle,
} from "../../scripts/ci/validate-semantic.ts";

Deno.test("accepts Conventional Commit subjects and pull request titles", () => {
  for (
    const value of [
      "feat(contracts): enforce description quality errors",
      "fix: reject malformed requests",
      "docs(backend-delivery): clarify merge gates",
      "revert: restore the previous contract rail",
    ]
  ) {
    assert(isSemanticTitle(value));
    assert(isSemanticCommitSubject(value));
  }
  assert(isSemanticCommitSubject('Revert "feat: add a temporary rail"'));
});

Deno.test("reserves room for the squash suffix", () => {
  const title66 = `feat: ${"x".repeat(60)}`;
  const title65 = `feat: ${"x".repeat(59)}`;

  assertEquals(isSemanticPullRequestTitle(title66, 207), false);
  assert(isSemanticPullRequestTitle(title66, 9));
  assert(isSemanticPullRequestTitle(title65, 207));
  for (const number of [0, -1, 1.5]) {
    assertEquals(isSemanticPullRequestTitle(title65, number), false);
  }
});

Deno.test("rejects non-semantic titles and commit subjects", () => {
  for (
    const value of [
      "[F05] Enforce contract description quality",
      "Implement contract quality",
      "feature(contracts): use descriptions",
      "feat(contracts) enforce descriptions",
      `feat: ${"x".repeat(70)}`,
    ]
  ) {
    assertEquals(isSemanticTitle(value), false);
    assertEquals(isSemanticCommitSubject(value), false);
  }
});
