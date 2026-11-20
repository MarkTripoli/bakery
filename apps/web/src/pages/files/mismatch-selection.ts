/**
 * Which file and version a refusal belongs to (#437).
 *
 * A refusal is a fact about one set of bytes. The panel holds the flag, so it
 * must know when it is looking at different bytes and start clean, or one
 * refused download would blame every file opened in that panel afterwards.
 * The current version is a subject of its own: an older copy of the same file
 * has its own bytes, so a refusal on one says nothing about the other.
 */
export function mismatchSubject(
  fileId: string,
  revision: number | undefined,
): string {
  return `${fileId}:${revision ?? "-"}`;
}
