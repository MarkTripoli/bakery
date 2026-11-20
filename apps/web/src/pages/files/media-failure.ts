import { isArtifactContentMismatch } from "../artifact-mismatch.ts";

/**
 * A player failed, or a read did: which fault is it? (#437)
 *
 * A video or audio file is handed to the browser by address, so its bytes are
 * never read into the page and the server never gets to refuse them. When the
 * browser cannot play it, one content read asks the same question every other
 * preview asks, and this decides what its answer means: a file that does not
 * match its record is named as such instead of being blamed on the browser.
 *
 * `null` is the ordinary case -- the read succeeded, or there was no read -- and
 * means the player itself could not play a file that is otherwise intact.
 */
export function mediaFailureIsMismatch(error: unknown): boolean {
  return isArtifactContentMismatch(error);
}

/**
 * A download the server refused: is the file wrong, or did the download fail?
 *
 * Pressing Download on a damaged video is the same question the player asks, and
 * it must get the same answer: the panel says the file does not match its record
 * and stops offering to save it, rather than reporting a download that failed and
 * leaving the button there to be pressed again.
 */
export function refusedDownload(error: unknown): "mismatch" | "failed" {
  return mediaFailureIsMismatch(error) ? "mismatch" : "failed";
}
