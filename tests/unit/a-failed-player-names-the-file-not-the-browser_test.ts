import { assertEquals } from "@std/assert";
import { ApiProblemError } from "@bakery/contracts/client";
import {
  mediaFailureIsMismatch,
  refusedDownload,
} from "../../apps/web/src/pages/files/media-failure.ts";

/**
 * A player reads a video by address, so the browser is the first thing to see
 * bytes that do not match their record. The panel must not answer that with "this
 * file could not be played here": that blames the browser for a file the server
 * would refuse, and leaves a Download offered for bytes nobody has verified.
 */
const problem = (code: string) =>
  new ApiProblemError(
    { code, status: 409, title: code, detail: code } as never,
  );

Deno.test("a refused file is named as a mismatch, not as a player fault", () => {
  assertEquals(
    mediaFailureIsMismatch(problem("ARTIFACT_CONTENT_MISMATCH")),
    true,
  );
});

Deno.test("a player fault on an intact file stays a player fault", () => {
  // The read succeeded, so there is nothing to explain as a mismatch.
  assertEquals(mediaFailureIsMismatch(null), false);
  assertEquals(mediaFailureIsMismatch(undefined), false);
});

Deno.test("some other refusal is not turned into a mismatch", () => {
  assertEquals(mediaFailureIsMismatch(problem("NOT_FOUND")), false);
  assertEquals(mediaFailureIsMismatch(new Error("PREVIEW_UNAVAILABLE")), false);
});

Deno.test("a refused download is the file's fault, not the download's", () => {
  // Pressing Download on a damaged video must say what the player says, and stop
  // offering the button, rather than reporting a download that failed.
  assertEquals(
    refusedDownload(problem("ARTIFACT_CONTENT_MISMATCH")),
    "mismatch",
  );
  assertEquals(refusedDownload(problem("NOT_FOUND")), "failed");
  assertEquals(refusedDownload(new Error("network down")), "failed");
});
