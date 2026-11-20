/**
 * Which file and version a refusal belongs to (#437).
 *
 * A refusal is a fact about one set of bytes. The panel holds the flag, so it
 * must know when it is looking at different bytes and start clean, or one
 * refused download would blame every file opened in that panel afterwards.
 */
export type MismatchSelection = {
  /** The file and revision the panel is showing now. */
  readonly subject: string;
  /** Whether a refusal recorded for `subject` still applies. */
  readonly keep: (fileId: string, revision: number | undefined) => boolean;
};

/** The revision a subject names; the current version is its own subject. */
function subjectOf(fileId: string, revision: number | undefined): string {
  return `${fileId}:${revision ?? "-"}`;
}

/** Record which bytes a refusal was found on. */
export function mismatchSelection(
  fileId: string,
  revision: number | undefined,
): MismatchSelection {
  const subject = subjectOf(fileId, revision);
  return {
    subject,
    keep: (nextFileId, nextRevision) =>
      subjectOf(nextFileId, nextRevision) === subject,
  };
}
