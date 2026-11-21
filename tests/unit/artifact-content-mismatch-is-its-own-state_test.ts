import { assert, assertEquals } from "@std/assert";
import { ApiProblemError } from "@bakery/contracts/client";
import { isArtifactContentMismatch } from "../../apps/web/src/pages/artifact-mismatch.ts";

function problem(code: string, status: number) {
  return new ApiProblemError({
    type: `http://127.0.0.1:0/problems/${code.toLowerCase()}`,
    title: "problem",
    status,
    code,
    retryable: false,
  });
}

Deno.test("the server's mismatch refusal is a mismatch", () => {
  assert(isArtifactContentMismatch(problem("ARTIFACT_CONTENT_MISMATCH", 409)));
});

Deno.test("a mismatch carried through a wrapper is still a mismatch", () => {
  // The read helpers pass a failure object around rather than the class, so the
  // screen must read the code from the shape as well.
  assert(isArtifactContentMismatch({
    problem: { code: "ARTIFACT_CONTENT_MISMATCH" },
  }));
});

Deno.test("an expired file is not a mismatch", () => {
  // Expiry is the file having a limit, not the file disagreeing with its record:
  // a page that confused the two would tell someone to ask an Admin about a
  // retention policy.
  assertEquals(
    isArtifactContentMismatch(problem("ARTIFACT_CONTENT_EXPIRED", 410)),
    false,
  );
});

Deno.test("an ordinary failure is not a mismatch", () => {
  for (
    const error of [
      new Error("boom"),
      null,
      undefined,
      { problem: { code: "STATE_CONFLICT" } },
    ]
  ) {
    assertEquals(isArtifactContentMismatch(error), false);
  }
});
