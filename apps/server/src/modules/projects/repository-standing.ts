/**
 * What a repository's row on the Projects list says about readiness (#65),
 * computed from the same facts the repository page reads so the two surfaces
 * cannot show two different words for one repository.
 *
 * The page's own rule (`standingOf` in the web app) answers "ready" only for a
 * check that passed for the version in use, "failed" for a check that did not,
 * and nothing when no check has run for that version. Here that becomes one
 * value per row, and a row this build cannot classify answers null: the list
 * then shows no badge rather than guessing a word.
 */
export type RepositoryStanding =
  | "not_set_up"
  | "check_needed"
  | "check_failed"
  | "ready"
  | "archived";

export function repositoryStanding(input: {
  /** The repository is retired. */
  archived: boolean;
  /** A version of the working settings is in use. */
  hasActiveVersion: boolean;
  /** The version in use was made by a readiness check (schema 2), not a person. */
  activeIsCheckMade: boolean;
  /** The check of the version in use passed (`readiness = 'eligible'`). */
  checkPassed: boolean;
}): RepositoryStanding {
  // A retired repository says so whatever its evidence was.
  if (input.archived) return "archived";
  if (!input.hasActiveVersion) return "not_set_up";
  // A person's save has no check of its own yet: the check has to run for it.
  if (!input.activeIsCheckMade) return "check_needed";
  return input.checkPassed ? "ready" : "check_failed";
}
