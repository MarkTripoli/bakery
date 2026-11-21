import { ApiProblemError } from "@bakery/contracts/client";

/**
 * Did this read fail because the stored bytes are not the bytes the record
 * describes? (#437)
 *
 * The server answers `ARTIFACT_CONTENT_MISMATCH` (409) for exactly that, and it is
 * the only failure a screen can explain to a person: the version is intact, its
 * record is intact, and what is stored under it hashes to something else. Every
 * surface that shows a preview asks this one question, so the Files panel, the
 * artifact page and the comment anchor cannot drift into three different answers.
 */
export function isArtifactContentMismatch(error: unknown): boolean {
  if (error instanceof ApiProblemError) {
    return error.problem.code === "ARTIFACT_CONTENT_MISMATCH";
  }
  // A caller that carried the problem through a wrapper still means the same
  // thing, so the code is read from the shape as well as from the class.
  const problem =
    error !== null && typeof error === "object" && "problem" in error
      ? (error as { problem?: { code?: unknown } }).problem
      : undefined;
  return problem?.code === "ARTIFACT_CONTENT_MISMATCH";
}
